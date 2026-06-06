import assert from 'node:assert/strict';
import test from 'node:test';

import { shouldHaltAutonomousWithoutApprovedPlan } from '../pipeline.js';
import type { VerifierContractSummary } from '../services/requiredVerifierContract.js';
import type { WorktreeRollbackSummary } from '../services/worktreeSafety.js';
import { buildPipelineFinalTerminalState, type PipelineTerminalContext } from './finalization.js';

test('characterization: autonomous execution halts without an approved plan', () => {
  assert.equal(shouldHaltAutonomousWithoutApprovedPlan('autonomous', null), true);
  assert.equal(shouldHaltAutonomousWithoutApprovedPlan('verified', null), false);
});

test('characterization: QA rejection remains non-executing terminal status', () => {
  const state = buildPipelineFinalTerminalState({
    resultStatus: 'QA_REJECTED_MAX_LOOPS',
    terminalContext: emptyTerminalContext(),
    verifierContractSummary: verifierSummary({ verifierCompletionSatisfied: true }),
  });

  assert.equal(state.status, 'QA_REJECTED_MAX_LOOPS');
  assert.equal(state.terminalSummary.reason_category, 'qa_rejected');
  assert.deepEqual(state.terminalSummary.changed_files, []);
});

test('characterization: verifier failure blocks COMPLETE', () => {
  const state = buildPipelineFinalTerminalState({
    resultStatus: 'COMPLETE',
    terminalContext: emptyTerminalContext(),
    verifierContractSummary: verifierSummary({
      requiredVerifierCount: 1,
      requiredVerifierFailedCount: 1,
      verifierCompletionSatisfied: false,
      failedRequiredVerifiers: ['npm test'],
      completionBlockingStatus: 'REQUIRED_VERIFIER_FAILED',
    }),
  });

  assert.equal(state.contractStatus, 'REQUIRED_VERIFIER_FAILED');
  assert.equal(state.status, 'REQUIRED_VERIFIER_FAILED');
  assert.equal(state.terminalSummary.reason_category, 'verifier_contract');
});

test('characterization: missing required verifier blocks COMPLETE', () => {
  const state = buildPipelineFinalTerminalState({
    resultStatus: 'COMPLETE',
    terminalContext: emptyTerminalContext(),
    verifierContractSummary: verifierSummary({
      requiredVerifierCount: 1,
      verifierCompletionSatisfied: false,
      missingRequiredVerifiers: ['npm test'],
      completionBlockingStatus: 'REQUIRED_VERIFIER_MISSING',
    }),
  });

  assert.equal(state.contractStatus, 'REQUIRED_VERIFIER_MISSING');
  assert.equal(state.status, 'REQUIRED_VERIFIER_MISSING');
  assert.equal(state.terminalSummary.verifier_contract?.missingRequiredVerifiers[0], 'npm test');
});

test('characterization: rollback failure maps to rollback terminal status', () => {
  const terminalContext = emptyTerminalContext({
    rollbackSummaryPath: 'run/rollback_summary.json',
    rollbackSummary: rollbackSummary('rollback_failed'),
  });
  const state = buildPipelineFinalTerminalState({
    resultStatus: 'EXACT_INSTRUCTION_DRIFT',
    terminalContext,
    verifierContractSummary: verifierSummary({ verifierCompletionSatisfied: true }),
  });

  assert.equal(state.rollbackMode, 'rollback_failed');
  assert.equal(state.status, 'ROLLBACK_FAILED');
  assert.equal(state.terminalSummary.reason_category, 'rollback');
});

test('characterization: exact-instruction drift maps correctly', () => {
  const state = buildPipelineFinalTerminalState({
    resultStatus: 'EXECUTOR_HALTED',
    terminalContext: emptyTerminalContext({
      condition: '[EXACT_INSTRUCTION_DRIFT] requested literal was paraphrased',
    }),
    verifierContractSummary: verifierSummary({ verifierCompletionSatisfied: true }),
  });

  assert.equal(state.status, 'EXACT_INSTRUCTION_DRIFT');
  assert.equal(state.terminalSummary.reason_category, 'exact_contract_failure');
});

function emptyTerminalContext(overrides: Partial<PipelineTerminalContext> = {}): PipelineTerminalContext {
  return {
    toolCallLog: [],
    condition: null,
    failureCapsulePath: null,
    repairAttemptTimelinePath: null,
    attemptSafetySummaryPath: null,
    attemptSafetySummary: null,
    rollbackSummaryPath: null,
    rollbackSummary: null,
    worktreeSafetySummaryPath: null,
    worktreeSafetySummary: null,
    ...overrides,
  };
}

function verifierSummary(overrides: Partial<VerifierContractSummary>): VerifierContractSummary {
  return {
    schema_version: 1,
    artifact_type: 'babel_verifier_execution_summary',
    requiredVerifierCount: 0,
    requiredVerifierPassedCount: 0,
    requiredVerifierFailedCount: 0,
    requiredVerifierSkippedCount: 0,
    verifierCompletionSatisfied: true,
    missingRequiredVerifiers: [],
    skippedRequiredVerifiers: [],
    failedRequiredVerifiers: [],
    completionBlockingStatus: null,
    verifiers: [],
    ...overrides,
  };
}

function rollbackSummary(status: WorktreeRollbackSummary['status']): WorktreeRollbackSummary {
  return {
    schema_version: 1,
    artifact_type: 'babel_rollback_summary',
    status,
    reason: 'characterization fixture',
    restored_files: [],
    removed_files: [],
    rollback_not_needed_files: [],
    dirty_files_preserved: [],
    unrelated_untracked_files_preserved: [],
    target_dirty_conflicts: [],
    protected_path_conflicts: [],
    failed_files: status === 'rollback_failed' ? [{ path: 'src/app.ts', error: 'locked' }] : [],
    changed_files_before_rollback: [],
    changed_files_after_rollback: [],
    next_recommended_operator_action: 'inspect manually',
  };
}
