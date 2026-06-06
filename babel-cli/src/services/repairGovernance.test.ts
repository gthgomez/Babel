import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildFailureCapsule,
  classifyRepairFailure,
  isRetryableRepairFailure,
  maxAttemptsForRepairMode,
} from './repairGovernance.js';

test('repair governance exposes autonomous and repair-run attempt limits', () => {
  assert.equal(maxAttemptsForRepairMode('autonomous'), 3);
  assert.equal(maxAttemptsForRepairMode('repair-run'), 5);
});

test('repair governance classifies verifier test failures as retryable with evidence', () => {
  const capsule = buildFailureCapsule({
    attempt: 1,
    verifierStatus: 'fail',
    failedCommand: 'npm test',
    stderr: 'AssertionError: expected 5 but got -1',
    changedFiles: ['src/math.js'],
  });

  assert.equal(capsule.failure_code, 'TEST_FAILED');
  assert.equal(capsule.retryable, true);
  assert.match(capsule.next_repair_hypothesis, /failing test output/);
});

test('repair governance blocks ambiguous and no-effect retries', () => {
  assert.equal(
    classifyRepairFailure({
      pipelineStatus: 'AMBIGUOUS_LITERAL_BINDING',
      error: 'multiple filenames and multiple exact literals',
    }),
    'AMBIGUOUS_LITERAL_BINDING',
  );
  assert.equal(isRetryableRepairFailure({ code: 'AMBIGUOUS_LITERAL_BINDING', summary: 'ambiguous' }), false);

  const noEffects = buildFailureCapsule({
    attempt: 2,
    pipelineStatus: 'COMPLETE',
    verifierStatus: 'fail',
    failedCommand: 'pytest',
    stderr: 'still failing',
    changedFiles: [],
  });
  assert.equal(noEffects.failure_code, 'NO_EFFECTS_DETECTED');
  assert.equal(noEffects.retryable, false);
});

test('repair governance classifies provider schema and network failures as retryable', () => {
  const schemaCapsule = buildFailureCapsule({
    attempt: 1,
    pipelineStatus: 'FATAL_ERROR',
    error: '[deepInfraApi] Zod validation failed: risks expected array',
    changedFiles: [],
  });

  assert.equal(schemaCapsule.failure_code, 'PROVIDER_SCHEMA_INVALID');
  assert.equal(schemaCapsule.retryable, true);
  assert.match(schemaCapsule.next_repair_hypothesis, /structured-output retry/i);

  const networkCapsule = buildFailureCapsule({
    attempt: 1,
    pipelineStatus: 'FATAL_ERROR',
    error: '[deepInfraApi] Network error: fetch failed',
    changedFiles: [],
  });

  assert.equal(networkCapsule.failure_code, 'PROVIDER_UNAVAILABLE');
  assert.equal(networkCapsule.retryable, true);
  assert.match(networkCapsule.next_repair_hypothesis, /provider\/network/i);
});

test('repair governance preserves exact-invariant failures in capsules', () => {
  const capsule = buildFailureCapsule({
    attempt: 1,
    pipelineStatus: 'EXACT_INSTRUCTION_DRIFT',
    error: 'literal invariant "verified live ok" is missing',
    changedFiles: ['src/verifiedMode.js'],
  });

  assert.equal(capsule.failure_code, 'EXACT_INSTRUCTION_DRIFT');
  assert.equal(capsule.exact_invariant_status, 'fail');
  assert.equal(capsule.retryable, true);
});
