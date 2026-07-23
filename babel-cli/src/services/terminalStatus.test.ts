import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildAttemptSafetySummary,
  buildTerminalStatusSummary,
  isVerifierCommand,
  isReadOnlyNoModificationRequest,
  resolveTerminalStatus,
  parseVerifierCommand,
} from './terminalStatus.js';
import type { AutonomousRepairProofTimeline } from './autonomousRepairProofEvidence.js';
import type { ToolCallLog } from '../schemas/agentContracts.js';

function failedShell(command: string): ToolCallLog {
  return {
    step: 1,
    tool: 'shell_exec',
    target: command,
    exit_code: 1,
    stdout: '',
    stderr: 'boom',
    verified: false,
  };
}

test('terminal status precedence keeps exact and ambiguous failures specific', () => {
  assert.equal(
    resolveTerminalStatus({
      status: 'EXECUTOR_HALTED',
      condition: '[EXACT_INSTRUCTION_DRIFT] missing exact literal',
    }),
    'EXACT_INSTRUCTION_DRIFT',
  );

  assert.equal(
    resolveTerminalStatus({
      status: 'EXECUTOR_HALTED',
      condition: '[AMBIGUOUS_LITERAL_BINDING] a.txt and b.txt both possible',
    }),
    'AMBIGUOUS_LITERAL_BINDING',
  );
});

test('RUN_FAILED replacement mapping uses verifier and shell evidence', () => {
  assert.equal(
    resolveTerminalStatus({
      status: 'RUN_FAILED',
      toolCallLog: [failedShell('npm test')],
    }),
    'VERIFIER_FAILED',
  );

  assert.equal(
    resolveTerminalStatus({
      status: 'RUN_FAILED',
      toolCallLog: [failedShell('node scripts/fail.mjs')],
    }),
    'SHELL_COMMAND_FAILED',
  );

  assert.equal(
    resolveTerminalStatus({
      status: 'RUN_FAILED',
      condition: 'planner failed before execution',
    }),
    'EXECUTOR_HALTED',
  );
});

test('verifier command-path canonicalization for terminal status', () => {
  assert.equal(isVerifierCommand('npm test'), true);
  assert.equal(isVerifierCommand('/tmp/node_modules/.bin/npm test'), true);
  assert.equal(isVerifierCommand('\"C:/Program Files/nodejs/npm.cmd\" run build'), true);
  assert.equal(isVerifierCommand('node --test'), true);
  assert.equal(isVerifierCommand('\"/usr/bin/node\" --test'), true);

  const parsed = parseVerifierCommand('\"/tmp/node_modules/.bin/npm\" run build');
  assert.equal(parsed?.executable, 'npm');
  assert.deepEqual(parsed?.args, ['run', 'build']);
});

test('read-only no-modification requests get a useful terminal status', () => {
  assert.equal(
    isReadOnlyNoModificationRequest({
      task: 'Inspect src/info.txt and determine whether it mentions ready. Do not modify files.',
      mode: 'deep',
      allowedTools: ['directory_list', 'file_read'],
    }),
    true,
  );

  assert.equal(
    resolveTerminalStatus({
      status: 'RUN_FAILED',
      readOnlyNoModification: true,
    }),
    'READ_ONLY_NO_MODIFICATION',
  );
});

test('terminal summary carries status, failed command, and operator action', () => {
  const summary = buildTerminalStatusSummary({
    status: 'EXECUTOR_HALTED',
    condition: '[SHELL_COMMAND_DENIED] command blocked',
    toolCallLog: [failedShell('npm install')],
  });

  assert.equal(summary.status, 'SHELL_COMMAND_DENIED');
  assert.equal(summary.reason_category, 'shell_command_denied');
  assert.equal(summary.failed_command, 'npm install');
  assert.match(summary.next_recommended_operator_action, /That command is not allowed/i);
});

test('terminal status resolves small-fix outcomes and next actions', () => {
  assert.equal(resolveTerminalStatus({ status: 'SMALL_FIX_COMPLETE' }), 'SMALL_FIX_COMPLETE');
  assert.equal(resolveTerminalStatus({ status: 'SMALL_FIX_FAILED' }), 'SMALL_FIX_FAILED');
});

test('repair repeated failure status stays specific', () => {
  assert.equal(
    resolveTerminalStatus({
      status: 'EXECUTOR_HALTED',
      condition: '[REPAIR_REPEATED_FAILURE] same verifier failed again',
    }),
    'REPAIR_REPEATED_FAILURE',
  );
});

test('required verifier contract statuses stay specific', () => {
  assert.equal(
    resolveTerminalStatus({
      status: 'REQUIRED_VERIFIER_MISSING',
    }),
    'REQUIRED_VERIFIER_MISSING',
  );

  assert.equal(
    resolveTerminalStatus({
      status: 'REQUIRED_VERIFIER_SKIPPED',
    }),
    'REQUIRED_VERIFIER_SKIPPED',
  );

  assert.equal(
    resolveTerminalStatus({
      status: 'REQUIRED_VERIFIER_FAILED',
    }),
    'REQUIRED_VERIFIER_FAILED',
  );
});

test('terminal summary carries verifier contract details', () => {
  const summary = buildTerminalStatusSummary({
    status: 'REQUIRED_VERIFIER_MISSING',
    verifierContractSummary: {
      schema_version: 1,
      artifact_type: 'babel_verifier_execution_summary',
      requiredVerifierCount: 1,
      requiredVerifierPassedCount: 0,
      requiredVerifierFailedCount: 0,
      requiredVerifierSkippedCount: 1,
      verifierCompletionSatisfied: false,
      missingRequiredVerifiers: ['npm test'],
      skippedRequiredVerifiers: [],
      failedRequiredVerifiers: [],
      completionBlockingStatus: 'REQUIRED_VERIFIER_MISSING',
      verifiers: [],
    },
  });

  assert.equal(summary.status, 'REQUIRED_VERIFIER_MISSING');
  assert.equal(summary.reason_category, 'verifier_contract');
  assert.equal(summary.verifier_contract?.requiredVerifierCount, 1);
});

test('terminal summary carries small-fix completion category and action', () => {
  const summary = buildTerminalStatusSummary({
    status: 'SMALL_FIX_FAILED',
    condition: '[SMALL_FIX_FAILED] verifier failed',
  });

  assert.equal(summary.status, 'SMALL_FIX_FAILED');
  assert.equal(summary.reason_category, 'small_fix_failed');
  assert.match(summary.next_recommended_operator_action, /The fix didn't pass checks/i);
});

test('rollback and worktree safety statuses take precedence over exact drift', () => {
  assert.equal(
    resolveTerminalStatus({
      status: 'EXACT_INSTRUCTION_DRIFT',
      condition: '[ROLLBACK_APPLIED] restored touched files after [EXACT_INSTRUCTION_DRIFT]',
    }),
    'ROLLBACK_APPLIED',
  );

  assert.equal(
    resolveTerminalStatus({
      status: 'EXACT_INSTRUCTION_DRIFT',
      condition: 'later executor halt without rollback marker',
      rollbackMode: 'rollback_applied',
    }),
    'ROLLBACK_APPLIED',
  );

  assert.equal(
    resolveTerminalStatus({
      status: 'EXACT_INSTRUCTION_DRIFT',
      condition: '[WORKTREE_DIRTY_UNSAFE] target already dirty before [EXACT_INSTRUCTION_DRIFT]',
    }),
    'WORKTREE_DIRTY_UNSAFE',
  );
});

test('attempt safety summary records snapshots and unrelated preservation', () => {
  const timeline: AutonomousRepairProofTimeline = {
    schema_version: 1,
    proof_id: 'test',
    proof_kind: 'fully_autonomous',
    deterministic_test_double: false,
    max_attempts: 3,
    attempt_count: 1,
    final_status: 'REPAIR_REPEATED_FAILURE',
    final_completion_guard_result: {
      status: 'fail',
      semantic_failure: 'verifier failed',
      runtime_hook_event_count: 0,
      benchmark_verification_status: null,
    },
    changed_files: ['src/math.js'],
    verifier_command_log: [{ attempt: 1, command: 'npm test', cwd: '.', exit_code: 1 }],
    notes: [],
    attempts: [
      {
        attempt: 1,
        kind: 'live_cli',
        status: 'REPAIR_ATTEMPT_FAILED',
        changed_files: ['src/math.js'],
        verifier_command: 'npm test',
        verifier_cwd: '.',
        verifier_exit_code: 1,
        verifier_stdout_summary: null,
        verifier_stderr_summary: 'AssertionError',
        failure_capsule_id: 'repair_failure_capsule_attempt_1',
        failure_capsule_path: 'run/12_repair_failure_capsule_attempt_1.json',
        failure_capsule: null,
        input_capsule_id: null,
        input_capsule_path: null,
        input_capsule_consumed: false,
        next_attempt_consumed_capsule: false,
        repeated_failure_signature: null,
        meaningful_diff_since_previous_attempt: null,
        file_hashes: {
          'src/math.js': { before: 'old', after: 'bad' },
        },
      },
    ],
  };

  const summary = buildAttemptSafetySummary({
    timeline,
    initialSnapshot: {
      root: 'fixture',
      files: {
        'src/math.js': 'old',
        'src/dirty.txt': 'keep',
      },
      file_count: 2,
      truncated: false,
      ignored_directories: [],
    },
    finalSnapshot: {
      root: 'fixture',
      files: {
        'src/math.js': 'bad',
        'src/dirty.txt': 'keep',
      },
      file_count: 2,
      truncated: false,
      ignored_directories: [],
    },
  });

  assert.equal(summary.rollback_mode, 'snapshot_only');
  assert.deepEqual(summary.touched_files, ['src/math.js']);
  assert.equal(summary.pre_run_file_hashes['src/math.js'], 'old');
  assert.equal(summary.final_file_hashes['src/math.js'], 'bad');
  assert.equal(summary.unrelated_dirty_file_preservation.status, 'preserved');
  assert.equal(summary.user_change_preservation_summary.status, 'preserved');
});
