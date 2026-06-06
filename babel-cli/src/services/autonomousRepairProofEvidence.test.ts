import assert from 'node:assert/strict';
import test from 'node:test';

import type { AutonomousRepairProofTimeline } from './autonomousRepairProofEvidence.js';
import {
  parseJsonObjectStdout,
  validateAutonomousLiveFailThenPassTimeline,
} from './autonomousRepairProofEvidence.js';
import { maxAttemptsForRepairMode } from './repairGovernance.js';

function baseTimeline(): AutonomousRepairProofTimeline {
  const capsule = {
    schema_version: 1 as const,
    attempt: 1,
    failure_code: 'TEST_FAILED' as const,
    failed_command: 'node --test',
    concise_failure_summary: 'TEST_FAILED: AssertionError [ERR_ASSERTION]: Expected values to be strictly equal',
    changed_files: ['src/math.js'],
    exact_invariant_status: 'unknown' as const,
    next_repair_hypothesis: 'Use the failing test output to make the smallest source patch, then rerun the same test command before advancing.',
    retryable: true,
  };
  return {
    schema_version: 1,
    proof_id: 'autonomous_live_fail_then_pass_repair',
    proof_kind: 'deterministic_model_boundary_assisted',
    deterministic_test_double: true,
    max_attempts: 3,
    attempt_count: 2,
    attempts: [
      {
        attempt: 1,
        kind: 'deterministic_stub',
        status: 'REPAIR_ATTEMPT_FAILED',
        changed_files: ['src/math.js'],
        verifier_command: 'node --test',
        verifier_cwd: '.',
        verifier_exit_code: 1,
        verifier_stdout_summary: 'AssertionError [ERR_ASSERTION]',
        verifier_stderr_summary: null,
        failure_capsule_id: 'repair_failure_capsule_attempt_1',
        failure_capsule_path: 'run/12_repair_failure_capsule_attempt_1.json',
        failure_capsule: capsule,
        input_capsule_id: null,
        input_capsule_path: null,
        input_capsule_consumed: false,
        next_attempt_consumed_capsule: true,
        repeated_failure_signature: null,
        meaningful_diff_since_previous_attempt: null,
        file_hashes: { 'src/math.js': { before: 'before', after: 'bad' } },
      },
      {
        attempt: 2,
        kind: 'deterministic_stub',
        status: 'REPAIR_ATTEMPT_PASSED',
        changed_files: ['src/math.js'],
        verifier_command: 'node --test',
        verifier_cwd: '.',
        verifier_exit_code: 0,
        verifier_stdout_summary: 'pass 1',
        verifier_stderr_summary: null,
        failure_capsule_id: null,
        failure_capsule_path: null,
        failure_capsule: null,
        input_capsule_id: 'repair_failure_capsule_attempt_1',
        input_capsule_path: 'run/12_repair_failure_capsule_attempt_1.json',
        input_capsule_consumed: true,
        next_attempt_consumed_capsule: null,
        repeated_failure_signature: null,
        meaningful_diff_since_previous_attempt: true,
        file_hashes: { 'src/math.js': { before: 'bad', after: 'good' } },
      },
    ],
    final_status: 'COMPLETE',
    final_completion_guard_result: {
      status: 'pass',
      semantic_failure: null,
      runtime_hook_event_count: 0,
      benchmark_verification_status: null,
    },
    changed_files: ['src/math.js'],
    verifier_command_log: [
      { attempt: 1, command: 'node --test', cwd: '.', exit_code: 1 },
      { attempt: 2, command: 'node --test', cwd: '.', exit_code: 0 },
    ],
    notes: ['Deterministic model-boundary response provider enabled for live fail-then-pass reliability proof.'],
  };
}

test('autonomous repair proof evidence accepts a verifier-backed fail then pass timeline', () => {
  const result = validateAutonomousLiveFailThenPassTimeline(baseTimeline());
  assert.equal(result.pass, true);
  assert.match(result.notes.join('\n'), /same verifier command rerun/);
  assert.match(result.notes.join('\n'), /attempt_2_consumed_attempt_1_capsule/);
});

test('autonomous repair proof evidence requires capsule consumption on retry', () => {
  const timeline = baseTimeline();
  timeline.attempts[1]!.input_capsule_path = 'run/different.json';
  const result = validateAutonomousLiveFailThenPassTimeline(timeline);
  assert.equal(result.pass, false);
  assert.match(result.notes.join('\n'), /attempt_2_capsule_input_mismatch/);
});

test('autonomous repair proof evidence requires the same verifier to be rerun', () => {
  const timeline = baseTimeline();
  timeline.attempts[1]!.verifier_command = 'npm test';
  const result = validateAutonomousLiveFailThenPassTimeline(timeline);
  assert.equal(result.pass, false);
  assert.match(result.notes.join('\n'), /verifier mismatch/);
});

test('autonomous repair proof evidence blocks COMPLETE if final verifier still fails', () => {
  const timeline = baseTimeline();
  timeline.attempts[1]!.verifier_exit_code = 1;
  const result = validateAutonomousLiveFailThenPassTimeline(timeline);
  assert.equal(result.pass, false);
  assert.match(result.notes.join('\n'), /attempt_2_verifier_exit=1/);
});

test('autonomous repair proof evidence keeps the autonomous max-attempt cap visible', () => {
  const timeline = baseTimeline();
  timeline.max_attempts = maxAttemptsForRepairMode('autonomous');
  assert.equal(timeline.max_attempts, 3);
});

test('autonomous repair proof evidence rejects harness-injected repair proof as the new live proof', () => {
  const timeline = baseTimeline();
  timeline.proof_kind = 'harness_injected';
  const result = validateAutonomousLiveFailThenPassTimeline(timeline);
  assert.equal(result.pass, false);
  assert.match(result.notes.join('\n'), /proof is still harness-injected/);
});

test('repair proof JSON stdout parsing accepts success and non-complete JSON objects', () => {
  assert.deepEqual(parseJsonObjectStdout('{"status":"COMPLETE"}\n'), {
    parsed: { status: 'COMPLETE' },
    parseError: null,
  });
  assert.deepEqual(parseJsonObjectStdout('{"status":"REPAIR_MAX_ATTEMPTS_REACHED"}\n'), {
    parsed: { status: 'REPAIR_MAX_ATTEMPTS_REACHED' },
    parseError: null,
  });
  assert.equal(parseJsonObjectStdout('npm banner\n{"status":"COMPLETE"}').parsed, null);
});
