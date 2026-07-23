import assert from 'node:assert/strict';
import test from 'node:test';

import {
  readLiteParallelReviewScenarios,
  resolveLiteParallelReviewFixturePath,
  runLiteParallelReviewHarness,
} from './liteParallelReview.js';
import { inferDoExecutionVerb, routeLiteOrFull, shouldSpawnSparkReview } from './liteFullRouter.js';
import { runSparkParallelReview, synthesizeSparkFindings } from './babelFull.js';

test('parallel review fixture defines two or more scenarios', () => {
  const scenarios = readLiteParallelReviewScenarios(resolveLiteParallelReviewFixturePath());
  assert.ok(scenarios.length >= 2);
  assert.ok(scenarios.every((scenario) => scenario.expects_spark_review));
});

test('shouldSpawnSparkReview is true for complex bl do routes only', () => {
  const decision = routeLiteOrFull(
    'Plan a repo-wide migration for the authentication module without editing files',
    { requestedVerb: 'do' },
  );
  assert.equal(decision.selected_lane, 'lite_plan');
  assert.equal(
    shouldSpawnSparkReview(decision, { requestedVerb: 'do', agentsMode: 'read-only' }),
    true,
  );
  assert.equal(shouldSpawnSparkReview(decision, { requestedVerb: 'do', agentsMode: 'off' }), false);
  assert.equal(
    shouldSpawnSparkReview(decision, { requestedVerb: 'fix', agentsMode: 'read-only' }),
    false,
  );
});

test('synthesizeSparkFindings aggregates read-only reviewer output', () => {
  const routeDecision = routeLiteOrFull('Use Spark agents to harden a repo-wide migration plan');
  const review = runSparkParallelReview({
    task: 'Use Spark agents to harden a repo-wide migration plan',
    routeDecision,
    now: new Date('2026-06-05T00:00:00.000Z'),
  });
  const synthesis = synthesizeSparkFindings({
    task: 'Use Spark agents to harden a repo-wide migration plan',
    routeDecision,
    sparkAgents: review.spark_agents,
    runDir: review.run_dir,
  });
  assert.equal(synthesis.mutation_allowed, false);
  assert.equal(synthesis.agent_count, 4);
  assert.ok(synthesis.summary.length > 0);
  assert.equal(synthesis.evidence_paths.length, 4);
});

test('inferDoExecutionVerb maps complex tasks to plan or fix', () => {
  assert.equal(inferDoExecutionVerb('Plan a repo-wide migration without editing files'), 'plan');
  assert.equal(
    inferDoExecutionVerb(
      'Fix the XSS vulnerability in pipeline.ts security sandbox across the repo',
    ),
    'fix',
  );
});

test(
  'lite parallel review harness passes on fixture repos',
  { concurrency: false, timeout: 120_000 },
  async () => {
    const result = await runLiteParallelReviewHarness();
    assert.equal(result.status, 'pass');
    assert.equal(result.scenarios.length, 2);
    assert.ok(result.scenarios.every((scenario) => scenario.status === 'pass'));
    assert.ok(result.scenarios.every((scenario) => scenario.reviewers_read_only !== false));
  },
);
