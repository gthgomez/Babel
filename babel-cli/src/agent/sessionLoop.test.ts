import assert from 'node:assert/strict';
import test from 'node:test';

import { buildReadOnlySessionLoopSteps } from './sessionLoop.js';

test('buildReadOnlySessionLoopSteps emits observe act verify finish for successful read-only lanes', () => {
  const steps = buildReadOnlySessionLoopSteps({
    observe: 'pass',
    act: 'pass',
    verify: 'pass',
  });

  assert.deepEqual(
    steps.map((step) => step.phase),
    ['observe', 'act', 'verify', 'finish'],
  );
  assert.equal(
    steps.every((step) => step.policy_decision === 'allow'),
    true,
  );
  assert.equal(steps.at(-1)?.status, 'pass');
});

test('buildReadOnlySessionLoopSteps ends blocked when verify fails', () => {
  const steps = buildReadOnlySessionLoopSteps({
    observe: 'pass',
    act: 'pass',
    verify: 'blocked',
  });

  assert.equal(steps.at(-1)?.phase, 'blocked');
  assert.equal(steps.at(-1)?.status, 'blocked');
});
