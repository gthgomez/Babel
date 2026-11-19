import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import { BABEL_ROOT } from '../cli/constants.js';

const runnerPath = join(BABEL_ROOT, 'benchmarks', 'curated-eval', 'runner.mjs');

async function loadRunner(): Promise<{
  loadCatalog: (root: string) => Promise<{ tasks: Array<{ id: string; change_policy: unknown; environment: unknown }> }>;
  scoreAttempt: (task: unknown, attempt: Record<string, unknown>) => Record<string, unknown>;
  summarizeAttemptScores: (entries: Array<{ task: unknown; attempt: Record<string, unknown> }>) => Record<string, unknown>;
}> {
  return (await import(pathToFileURL(runnerPath).href)) as never;
}

const suiteRoot = join(BABEL_ROOT, 'benchmarks', 'curated-eval');

function attempt(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    terminal_status: 'completed',
    engine_terminal_outcome: 'VERIFIED_COMPLETE',
    completion_claimed: true,
    verifier: { status: 'passed', assertions: 2, errors: [] },
    diff: { added: [], modified: ['src/summarize.mjs'], deleted: [] },
    ...overrides,
  };
}

test('curated eval does not count an unverified correct patch as a verified success', async () => {
  const { loadCatalog, scoreAttempt, summarizeAttemptScores } = await loadRunner();
  const catalog = await loadCatalog(suiteRoot);
  const task = catalog.tasks.find((entry) => entry.id === 'csv-rollup-cli');
  assert.ok(task);

  const verified = scoreAttempt(task, attempt({ diff: { added: ['output/summary.csv'], modified: [], deleted: [] } }));
  assert.equal(verified.outcome, 'valid_success');
  assert.equal(verified.harness_verified, true);

  const unverified = scoreAttempt(task, attempt({
    engine_terminal_outcome: 'UNVERIFIED_PATCH',
    diff: { added: ['output/summary.csv'], modified: [], deleted: [] },
  }));
  assert.equal(unverified.externally_correct, true);
  assert.equal(unverified.harness_verified, false);
  assert.equal(unverified.outcome, 'unverified_success');

  const summary = summarizeAttemptScores([
    { task, attempt: attempt({ diff: { added: ['output/summary.csv'], modified: [], deleted: [] } }) },
    { task, attempt: attempt({ engine_terminal_outcome: 'UNVERIFIED_PATCH', diff: { added: ['output/summary.csv'], modified: [], deleted: [] } }) },
  ]);
  const rates = summary.rates as Record<string, { numerator: number; denominator: number }>;
  assert.equal(summary.verified_success, 1);
  assert.equal(summary.unverified_success, 1);
  assert.equal(rates.verified_success?.numerator, 1);
  assert.equal(rates.verified_success?.denominator, 2);
});

test('curated eval separates false success from false block', async () => {
  const { loadCatalog, scoreAttempt } = await loadRunner();
  const catalog = await loadCatalog(suiteRoot);
  const task = catalog.tasks.find((entry) => entry.id === 'csv-rollup-cli');
  assert.ok(task);

  const falseSuccess = scoreAttempt(task, attempt({
    verifier: { status: 'failed', assertions: 2, errors: ['oracle mismatch'] },
  }));
  assert.equal(falseSuccess.externally_correct, false);
  assert.equal(falseSuccess.false_success, true);
  assert.equal(falseSuccess.outcome, 'task_failure');

  const falseBlock = scoreAttempt(task, attempt({
    terminal_status: 'failed',
    engine_terminal_outcome: 'AGENT_FAILURE',
    completion_claimed: false,
    diff: { added: ['output/summary.csv'], modified: [], deleted: [] },
  }));
  assert.equal(falseBlock.externally_correct, true);
  assert.equal(falseBlock.false_block, true);
  assert.equal(falseBlock.outcome, 'task_failure');
});
