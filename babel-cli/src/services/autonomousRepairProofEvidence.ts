import type { FailureCapsule } from './repairGovernance.js';

export type AutonomousRepairProofKind =
  | 'fully_autonomous'
  | 'deterministic_model_boundary_assisted'
  | 'deterministic_stub_assisted'
  | 'harness_injected';

export type AutonomousRepairProofAttemptKind =
  | 'live_cli'
  | 'deterministic_stub'
  | 'harness'
  | 'injected_failure';

export interface RepairProofFileHash {
  before: string | null;
  after: string | null;
}

export interface AutonomousRepairProofAttemptEvidence {
  attempt: number;
  kind: AutonomousRepairProofAttemptKind;
  status: 'REPAIR_ATTEMPT_FAILED' | 'REPAIR_ATTEMPT_PASSED';
  changed_files: string[];
  verifier_command: string | null;
  verifier_cwd: string | null;
  verifier_exit_code: number | null;
  verifier_stdout_summary: string | null;
  verifier_stderr_summary: string | null;
  failure_capsule_id: string | null;
  failure_capsule_path: string | null;
  failure_capsule: FailureCapsule | null;
  input_capsule_id: string | null;
  input_capsule_path: string | null;
  input_capsule_consumed: boolean;
  next_attempt_consumed_capsule: boolean | null;
  repeated_failure_signature: string | null;
  meaningful_diff_since_previous_attempt: boolean | null;
  file_hashes: Record<string, RepairProofFileHash>;
}

export interface CompletionGuardEvidence {
  status: 'pass' | 'fail' | 'not_run';
  semantic_failure: string | null;
  runtime_hook_event_count: number;
  benchmark_verification_status: string | null;
}

export interface AutonomousRepairProofTimeline {
  schema_version: 1;
  proof_id: string;
  proof_kind: AutonomousRepairProofKind;
  deterministic_test_double: boolean;
  max_attempts: number;
  attempt_count: number;
  attempts: AutonomousRepairProofAttemptEvidence[];
  final_status: string | null;
  final_completion_guard_result: CompletionGuardEvidence;
  changed_files: string[];
  verifier_command_log: Array<{
    attempt: number;
    command: string | null;
    cwd: string | null;
    exit_code: number | null;
  }>;
  notes: string[];
}

export interface RepairProofValidationResult {
  pass: boolean;
  notes: string[];
}

export function parseJsonObjectStdout(stdout: string): {
  parsed: Record<string, unknown> | null;
  parseError: string | null;
} {
  try {
    const value = JSON.parse(stdout.trim()) as unknown;
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      return { parsed: value as Record<string, unknown>, parseError: null };
    }
    return { parsed: null, parseError: 'stdout JSON root was not an object' };
  } catch (error) {
    return {
      parsed: null,
      parseError: error instanceof Error ? error.message : String(error),
    };
  }
}

export function validateAutonomousLiveFailThenPassTimeline(
  timeline: AutonomousRepairProofTimeline,
): RepairProofValidationResult {
  const first = timeline.attempts[0];
  const second = timeline.attempts[1];
  const sameVerifier =
    first?.verifier_command !== null &&
    first?.verifier_command === second?.verifier_command;
  const secondConsumedFirstCapsule =
    first?.failure_capsule_path !== null &&
    first?.failure_capsule_path === second?.input_capsule_path;
  const finalPass =
    timeline.final_status === 'COMPLETE' &&
    timeline.final_completion_guard_result.status === 'pass';

  const checks: Array<{ pass: boolean; note: string }> = [
    {
      pass: timeline.proof_kind === 'deterministic_model_boundary_assisted' ||
        timeline.proof_kind === 'deterministic_stub_assisted' ||
        timeline.proof_kind === 'fully_autonomous',
      note: `proof_kind=${timeline.proof_kind}`,
    },
    {
      pass: timeline.proof_kind !== 'harness_injected',
      note: timeline.proof_kind === 'harness_injected'
        ? 'proof is still harness-injected'
        : 'proof is not harness-injected',
    },
    {
      pass: timeline.attempt_count >= 2 && timeline.attempts.length >= 2,
      note: `attempt_count=${timeline.attempt_count}`,
    },
    {
      pass: first?.status === 'REPAIR_ATTEMPT_FAILED',
      note: `attempt_1_status=${first?.status ?? '(none)'}`,
    },
    {
      pass: (first?.changed_files ?? []).length > 0,
      note: `attempt_1_changed_files=${first?.changed_files.join(',') ?? '(none)'}`,
    },
    {
      pass: first?.verifier_exit_code !== null && first?.verifier_exit_code !== 0,
      note: `attempt_1_verifier_exit=${first?.verifier_exit_code ?? '(null)'}`,
    },
    {
      pass: first?.failure_capsule?.failure_code === 'TEST_FAILED',
      note: `attempt_1_capsule=${first?.failure_capsule?.failure_code ?? '(none)'}`,
    },
    {
      pass: first?.failure_capsule_path !== null,
      note: `attempt_1_capsule_path=${first?.failure_capsule_path ?? '(none)'}`,
    },
    {
      pass: second?.status === 'REPAIR_ATTEMPT_PASSED',
      note: `attempt_2_status=${second?.status ?? '(none)'}`,
    },
    {
      pass: secondConsumedFirstCapsule,
      note: secondConsumedFirstCapsule
        ? 'attempt_2_consumed_attempt_1_capsule'
        : 'attempt_2_capsule_input_mismatch',
    },
    {
      pass: first?.next_attempt_consumed_capsule === true && second?.input_capsule_consumed === true,
      note: `capsule_consumption_flag=${first?.next_attempt_consumed_capsule === true && second?.input_capsule_consumed === true ? 'pass' : 'fail'}`,
    },
    {
      pass: (second?.changed_files ?? []).length > 0,
      note: `attempt_2_changed_files=${second?.changed_files.join(',') ?? '(none)'}`,
    },
    {
      pass: sameVerifier,
      note: sameVerifier
        ? 'same verifier command rerun'
        : `verifier mismatch: ${first?.verifier_command ?? '(none)'} / ${second?.verifier_command ?? '(none)'}`,
    },
    {
      pass: second?.verifier_exit_code === 0,
      note: `attempt_2_verifier_exit=${second?.verifier_exit_code ?? '(null)'}`,
    },
    {
      pass: finalPass,
      note: `final_status=${timeline.final_status ?? '(none)'}, guards=${timeline.final_completion_guard_result.status}`,
    },
  ];

  return {
    pass: checks.every(check => check.pass),
    notes: checks.map(check => check.note),
  };
}
