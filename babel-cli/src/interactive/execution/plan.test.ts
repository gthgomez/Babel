import assert from 'node:assert/strict';
import test from 'node:test';
import { planDecisionShellOutcome } from './plan.js';

test('plan cancellation retains a cancelled shell outcome', () => {
  assert.equal(planDecisionShellOutcome(null), 'cancelled');
});

test('plan rejection retains a blocked shell outcome', () => {
  assert.equal(planDecisionShellOutcome('reject'), 'blocked');
});
