import assert from 'node:assert/strict';
import test from 'node:test';

import { bindCapabilityRecoveryScope } from './capabilityRecoveryScope.js';
import { ProgressController } from './progressController.js';

test('bindCapabilityRecoveryScope keys probes by durable taskOwnerId, not submission generation', () => {
  const progressController = new ProgressController();
  const host = {
    progressController,
    engineRunId: 'run-1',
    executionProfile: 'dev_local',
    taskAllowance: { taskOwnerId: 'owner-abc' },
    options: { projectRoot: '/tmp/proj', model: 'fixture' },
  };

  const first = bindCapabilityRecoveryScope(host);
  assert.equal(first.taskId, 'owner-abc');
  assert.ok(first.environmentIdentity.includes('run-1'));

  const continued = bindCapabilityRecoveryScope(host);
  assert.equal(continued.taskId, 'owner-abc', 'same durable task must reuse the probe task id');
});
