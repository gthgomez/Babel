import assert from 'node:assert/strict';
import test from 'node:test';

import { recommendModelEscalation } from './modelEscalationRules.js';

test('model escalation rules flag benchmark and performance-heavy tasks', () => {
  const recommendation = recommendModelEscalation({
    task: 'Fix largest-eigenval timeout and optimize speed for the benchmark verifier',
  });

  assert.equal(recommendation.should_escalate, true);
  assert.equal(recommendation.recommended_tier, 'escalation');
  assert.equal(recommendation.signals.some(signal => signal.code === 'performance_optimization'), true);
  assert.equal(recommendation.signals.some(signal => signal.code === 'benchmark_risk_numerical_performance'), true);
});

test('model escalation rules use benchmark risk labels for git and security canaries', () => {
  const merge = recommendModelEscalation({
    task: 'Terminal-Bench 2 task: merge-diff-arc-agi-task fetch bundle1.bundle and merge branch2',
  });
  const security = recommendModelEscalation({
    task: 'Terminal-Bench 2 task: break-filter-js-from-html inspect filter.py and build an alert bypass',
  });

  assert.equal(merge.signals.some(signal => signal.code === 'benchmark_risk_git_stateful_merge'), true);
  assert.equal(security.signals.some(signal => signal.code === 'benchmark_risk_browser_or_security_adversarial'), true);
});

test('model escalation rules leave simple local edits on default tier', () => {
  const recommendation = recommendModelEscalation({
    task: 'Rename the README title',
  });

  assert.equal(recommendation.should_escalate, false);
  assert.equal(recommendation.recommended_tier, null);
});
