import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  listBenchmarkTasks,
  loadBenchmarkManifest,
  runGovernanceBenchmark,
  validateBenchmarkResultWithSchema,
} from './governanceBenchmark.js';
import { generateGovernanceBenchmarkReport } from './governanceBenchmarkReport.js';

const requiredCategories = [
  'bugfix',
  'refactor',
  'dirty_worktree',
  'false_complete',
  'verifier_failure',
  'prompt_injection',
  'missing_dependency',
  'flaky_test',
  'rollback_failure',
  'exact_instruction_drift',
  'repo_map_failure',
  'terminal_execution_safety',
];

test('governance benchmark manifest covers required corpus categories', () => {
  const manifest = loadBenchmarkManifest();
  const tasks = listBenchmarkTasks(manifest);
  assert.equal(tasks.length >= 20, true);
  const ids = new Set(tasks.map((task) => task.task_id));
  assert.equal(ids.size, tasks.length);
  const categories = new Set(tasks.map((task) => task.category));
  for (const category of requiredCategories) {
    assert.equal(categories.has(category as never), true, `missing category ${category}`);
  }
});

test('canonical benchmark run produces a schema-valid governance result', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-governance-benchmark-'));
  const outputPath = join(root, 'results.jsonl');
  const summary = runGovernanceBenchmark({
    tool: 'babel',
    caseId: 'canonical',
    runs: 1,
    outputPath,
    artifactDir: join(root, 'artifacts'),
    fixtureRootBase: join(root, 'fixtures'),
  });

  assert.equal(summary.result_count, 1);
  const result = summary.results[0];
  assert.ok(result);
  assert.equal(result.task_id, 'canonical');
  assert.equal(result.tool.id, 'babel');
  assert.equal(result.result_status, 'completed');
  assert.equal(result.metrics.task_success, true);
  assert.equal(result.metrics.false_complete, false);
  assert.equal(result.metrics.verifier_executed, true);
  assert.equal(result.metrics.verifier_passed, true);
  assert.equal(result.metrics.audit_trace_quality, 'strong');
  assert.deepEqual(validateBenchmarkResultWithSchema(result), []);
  const line = readFileSync(outputPath, 'utf8').trim();
  assert.equal(JSON.parse(line).task_id, 'canonical');
});

test('external adapters produce unavailable records instead of fake failures', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-governance-benchmark-'));
  const summary = runGovernanceBenchmark({
    tool: 'codex_cli',
    caseId: 'canonical',
    runs: 1,
    outputPath: join(root, 'results.jsonl'),
    artifactDir: join(root, 'artifacts'),
    fixtureRootBase: join(root, 'fixtures'),
  });

  const result = summary.results[0];
  assert.ok(result);
  assert.equal(result.result_status, 'unavailable');
  assert.equal(result.metrics.normalized_terminal_status, 'ADAPTER_UNAVAILABLE');
  assert.equal(result.metrics.task_success, false);
  assert.equal(result.evidence.commands_attempted.length, 0);
});

test('benchmark report is public-safe and avoids global ranking claims', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-governance-benchmark-'));
  const outputPath = join(root, 'results.jsonl');
  runGovernanceBenchmark({
    tool: 'babel',
    caseId: 'canonical',
    runs: 1,
    outputPath,
    artifactDir: join(root, 'artifacts'),
    fixtureRootBase: join(root, 'fixtures'),
  });

  const reportPath = join(root, 'scorecard.md');
  generateGovernanceBenchmarkReport({ inputPath: outputPath, outputPath: reportPath });
  const markdown = readFileSync(reportPath, 'utf8');
  assert.match(markdown, /does not rank tools globally/);
  assert.match(markdown, /must not be used as a superiority claim/);
  assert.doesNotMatch(markdown, /better than Codex CLI/i);
});
