import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runBabelFullPlan, runSparkParallelReview } from './babelFull.js';
import { routeLiteOrFull } from './liteFullRouter.js';

test('Babel Full writes read-only Spark evidence and hardened plan artifacts', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-full-proof-'));
  const projectRoot = join(root, 'project');
  const runsRoot = join(root, 'runs');
  mkdirSync(projectRoot, { recursive: true });
  writeFileSync(join(projectRoot, 'README.md'), '# Example\n', 'utf-8');
  writeFileSync(join(projectRoot, 'package.json'), '{"scripts":{}}\n', 'utf-8');

  const routeDecision = routeLiteOrFull(
    'Use Spark agents to harden the repo-wide implementation plan',
  );
  const result = runBabelFullPlan('Use Spark agents to harden the repo-wide implementation plan', {
    routeDecision,
    projectRoot,
    runsRoot,
    now: new Date('2026-06-05T00:00:00.000Z'),
  });

  assert.equal(result.status, 'FULL_PLAN_READY');
  assert.equal(result.selected_lane, 'deep_lane');
  assert.equal(result.spark_agents.length, 4);
  assert.equal(result.mutation_subagents.enabled, false);
  assert.equal(existsSync(join(result.run_dir, 'route_decision.json')), true);
  assert.equal(existsSync(result.hardened_plan_path), true);
  assert.equal(existsSync(result.qa_review_path), true);
  assert.equal(existsSync(result.cost_ledger_path), true);
  assert.equal(
    result.spark_agents.every((agent) => agent.mode === 'read_only'),
    true,
  );
  assert.equal(
    result.spark_agents.every((agent) => /[\\\/]spark[\\\/]/.test(agent.evidence_path)),
    true,
  );
  assert.match(readFileSync(result.hardened_plan_path, 'utf-8'), /governed Babel executor/i);

  const cartographerEvidence = JSON.parse(
    readFileSync(join(result.run_dir, 'spark', 'read-only', 'repo-cartographer.json'), 'utf-8'),
  ) as { repo_cartography?: { package_scripts?: string[]; dir_samples?: string[] } };
  assert.ok(cartographerEvidence.repo_cartography);
  assert.deepEqual(cartographerEvidence.repo_cartography?.package_scripts, []);
  assert.ok((cartographerEvidence.repo_cartography?.dir_samples?.length ?? 0) >= 0);
});

test('Spark parallel review writes synthesis without mutating reviewers', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-full-spark-parallel-'));
  const projectRoot = join(root, 'project');
  const runsRoot = join(root, 'runs');
  mkdirSync(projectRoot, { recursive: true });
  writeFileSync(join(projectRoot, 'README.md'), '# Example\n', 'utf-8');

  const routeDecision = routeLiteOrFull(
    'Audit plugin/public-export security across the whole repo',
  );
  const result = runSparkParallelReview({
    task: 'Audit plugin/public-export security across the whole repo',
    routeDecision,
    projectRoot,
    runsRoot,
    now: new Date('2026-06-05T00:00:00.000Z'),
  });

  assert.equal(result.spark_agents.length, 4);
  assert.equal(
    result.spark_agents.every((agent) => agent.mode === 'read_only'),
    true,
  );
  assert.equal(existsSync(result.synthesis_path), true);
  assert.equal(existsSync(join(result.run_dir, 'spark_parallel_review.json')), true);
  const synthesis = JSON.parse(readFileSync(result.synthesis_path, 'utf-8')) as {
    mutation_allowed: boolean;
  };
  assert.equal(synthesis.mutation_allowed, false);
});

test('Babel Full can disable read-only agents while preserving route artifacts', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-full-no-agents-'));
  const routeDecision = routeLiteOrFull('Run the full lane for this architecture task', {
    requestedVerb: 'full',
  });
  const result = runBabelFullPlan('Run the full lane for this architecture task', {
    routeDecision,
    runsRoot: join(root, 'runs'),
    agentsMode: 'off',
    now: new Date('2026-06-05T00:00:00.000Z'),
  });

  assert.equal(result.agents_mode, 'off');
  assert.deepEqual(result.spark_agents, []);
  assert.equal(existsSync(join(result.run_dir, 'route_decision.json')), true);
});
