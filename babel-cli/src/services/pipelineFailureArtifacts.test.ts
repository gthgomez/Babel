import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PRE_EXECUTION_FAILURE_CAPSULE_FILENAME,
  buildPreExecutionFailureArtifacts,
} from './pipelineFailureArtifacts.js';

test('pre-execution provider schema failures produce resumable artifacts', () => {
  const artifacts = buildPreExecutionFailureArtifacts({
    runDir: 'C:\\Repos\\project repository\\runs\\example',
    error: new Error('[deepInfraApi] Zod validation failed: missing minimal_action_set'),
  });

  assert.equal(artifacts.executionReport.status, 'EXECUTION_HALTED');
  assert.equal(artifacts.executionReport.steps_executed, 0);
  assert.equal(artifacts.executionReport.pipeline_error.halted_at_step, 1);
  assert.match(artifacts.executionReport.pipeline_error.condition, /\[PRE_EXECUTION_FAILURE\]/);
  assert.equal(artifacts.failureCapsule.failure_code, 'PROVIDER_SCHEMA_INVALID');
  assert.equal(artifacts.failureCapsule.retryable, true);
  assert.equal(artifacts.failureCapsule.changed_files.length, 0);
  assert.match(artifacts.failureCapsulePath, new RegExp(`${PRE_EXECUTION_FAILURE_CAPSULE_FILENAME.replace('.', '\\.')}$`));
});
