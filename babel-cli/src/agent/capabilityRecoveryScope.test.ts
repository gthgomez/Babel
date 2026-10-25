import assert from 'node:assert/strict';
import test from 'node:test';

import {
  bindCapabilityRecoveryScope,
  isolationPrerequisiteRevisionKey,
} from './capabilityRecoveryScope.js';
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

test('isolationPrerequisiteRevisionKey ignores dirtyTree so unrelated edits do not re-arm shell denial', () => {
  const clean = {
    isolationRequired: true,
    isolationAvailable: false,
    hostFallbackAllowed: false,
    dirtyTree: false,
  };
  const dirty = { ...clean, dirtyTree: true };
  assert.equal(isolationPrerequisiteRevisionKey(clean), isolationPrerequisiteRevisionKey(dirty));
  assert.equal(isolationPrerequisiteRevisionKey(clean), '1:0:0');
});
