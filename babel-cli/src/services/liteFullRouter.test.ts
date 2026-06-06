import assert from 'node:assert/strict';
import test from 'node:test';

import { inferDoExecutionVerb, routeLiteOrFull, shouldSpawnSparkReview } from './liteFullRouter.js';

test('Lite/Full router keeps simple daily work in Lite lanes', () => {
  assert.equal(routeLiteOrFull('Explain this failure without editing').selected_lane, 'lite_ask');
  assert.equal(routeLiteOrFull('Plan the safest parser cleanup').selected_lane, 'lite_plan');
  assert.equal(routeLiteOrFull('Propose a patch for the README wording').selected_lane, 'lite_patch');
  assert.equal(routeLiteOrFull('Fix the failing parser test').selected_lane, 'lite_fix');
});

test('Lite/Full router escalates complex or risky work to visible Babel Full', () => {
  const decision = routeLiteOrFull('Use Spark agents to harden a repo-wide migration plan for the Babel pipeline');

  assert.equal(decision.selected_lane, 'babel_full');
  assert.equal(decision.complexity, 'high');
  assert.equal(decision.model_tier_recommendation, 'escalation');
  assert.equal(decision.risk_signals.some(signal => signal.code === 'explicit_full_or_agents'), true);
  assert.equal(decision.risk_signals.some(signal => signal.code === 'repo_wide_or_architecture'), true);
  assert.match(decision.full_babel_equivalent, /^babel full /);
});

test('Lite/Full router recommends escalation tier for protected control-plane failures', () => {
  const decision = routeLiteOrFull('Fix repeated Zod schema failures in pipeline.ts and agentContracts');

  assert.equal(decision.selected_lane, 'babel_full');
  assert.equal(decision.model_tier_recommendation, 'escalation');
  assert.equal(decision.risk_signals.some(signal => signal.code === 'protected_babel_control_plane'), true);
  assert.equal(decision.risk_signals.some(signal => signal.code === 'repeated_failure_or_recovery'), true);
});

test('Lite/Full router routes plugin/MCP/public-export work to full', () => {
  const decision = routeLiteOrFull('Audit public-export plugin registry changes in MCP integration');

  assert.equal(decision.selected_lane, 'babel_full');
  assert.equal(decision.risk_signals.some(signal => signal.code === 'plugin_mcp_public_export'), true);
  assert.equal(decision.complexity, 'high');
  assert.equal(decision.model_tier_recommendation, 'escalation');
});

test('Lite/Full router routes performance and security tasks to full with escalation', () => {
  const decision = routeLiteOrFull('Benchmark this pipeline for timeout and performance hotspots');

  assert.equal(decision.selected_lane, 'babel_full');
  assert.equal(decision.risk_signals.some(signal => signal.code === 'performance_or_security'), true);
  assert.equal(decision.complexity, 'high');
  assert.equal(decision.model_tier_recommendation, 'escalation');
});

test('shouldSpawnSparkReview gates complex bl do on agents mode', () => {
  const decision = routeLiteOrFull(
    'Plan a repo-wide migration for the authentication module without editing files',
    { requestedVerb: 'do' },
  );
  assert.equal(shouldSpawnSparkReview(decision, { requestedVerb: 'do', agentsMode: 'read-only' }), true);
  assert.equal(shouldSpawnSparkReview(decision, { requestedVerb: 'do', agentsMode: 'off' }), false);
});

test('inferDoExecutionVerb keeps read-only plan tasks on plan lane', () => {
  assert.equal(
    inferDoExecutionVerb('Plan a repo-wide migration without editing files'),
    'plan',
  );
});

test('Lite/Full router respects explicit full verb', () => {
  const decision = routeLiteOrFull('Rename README title', { requestedVerb: 'full' });

  assert.equal(decision.selected_lane, 'babel_full');
  assert.equal(decision.route_reason, 'Full lane was requested explicitly.');
});

test('Lite/Full router keeps requested read-only repo-wide planning in Lite', () => {
  const decision = routeLiteOrFull('a documentation pass for the repo', { requestedVerb: 'plan' });

  assert.equal(decision.selected_lane, 'lite_plan');
  assert.equal(decision.model_tier_recommendation, 'standard');
});

test('Lite/Full router keeps requested ask questions read-only', () => {
  const decision = routeLiteOrFull('what is this repo about?', { requestedVerb: 'ask' });

  assert.equal(decision.selected_lane, 'lite_ask');
});

test('Lite/Full router still escalates explicit Full wording for read-only verbs', () => {
  const decision = routeLiteOrFull('run the Full governed lane for an architecture review', { requestedVerb: 'plan' });

  assert.equal(decision.selected_lane, 'babel_full');
  assert.equal(decision.risk_signals.some(signal => signal.code === 'explicit_full_or_agents'), true);
});
