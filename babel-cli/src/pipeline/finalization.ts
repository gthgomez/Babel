import type { ToolCallLog } from '../schemas/agentContracts.js';
import {
  buildTerminalStatusSummary,
  resolveTerminalStatus,
  type AttemptSafetySummary,
  type RollbackMode,
  type TerminalStatus,
  type TerminalStatusSummary,
} from '../services/terminalStatus.js';
import type { VerifierContractSummary } from '../services/requiredVerifierContract.js';
import type {
  WorktreeRollbackSummary,
  WorktreeSafetySummary,
} from '../services/worktreeSafety.js';

export interface PipelineTerminalContext {
  toolCallLog: ToolCallLog[];
  condition: string | null;
  failureCapsulePath: string | null;
  repairAttemptTimelinePath: string | null;
  attemptSafetySummaryPath: string | null;
  attemptSafetySummary: AttemptSafetySummary | null;
  rollbackSummaryPath: string | null;
  rollbackSummary: WorktreeRollbackSummary | null;
  worktreeSafetySummaryPath: string | null;
  worktreeSafetySummary: WorktreeSafetySummary | null;
}

export interface PipelineFinalTerminalState {
  status: TerminalStatus;
  contractStatus: string;
  rollbackMode: RollbackMode;
  terminalSummary: TerminalStatusSummary;
}

export function buildPipelineFinalTerminalState(input: {
  resultStatus: string;
  terminalContext: PipelineTerminalContext;
  verifierContractSummary: VerifierContractSummary;
}): PipelineFinalTerminalState {
  const rollbackMode = input.terminalContext.rollbackSummary?.status ??
    input.terminalContext.attemptSafetySummary?.rollback_mode ??
    'none';
  const contractStatus =
    (input.resultStatus === 'COMPLETE' || input.resultStatus === 'COMPLETE_NO_MODIFICATION') &&
    !input.verifierContractSummary.verifierCompletionSatisfied
      ? input.verifierContractSummary.completionBlockingStatus ?? 'VERIFIER_CONTRACT_UNSATISFIED'
      : input.resultStatus;
  const status = resolveTerminalStatus({
    status: contractStatus,
    condition: input.terminalContext.condition,
    toolCallLog: input.terminalContext.toolCallLog,
    failureCapsulePath: input.terminalContext.failureCapsulePath,
    rollbackMode,
    rollbackSummaryPath: input.terminalContext.rollbackSummaryPath,
    worktreeSafetySummaryPath: input.terminalContext.worktreeSafetySummaryPath,
    targetDirtyConflicts: input.terminalContext.worktreeSafetySummary?.target_dirty_conflicts ?? [],
  });
  const terminalSummary = buildTerminalStatusSummary({
    status,
    condition: input.terminalContext.condition,
    toolCallLog: input.terminalContext.toolCallLog,
    failureCapsulePath: input.terminalContext.failureCapsulePath,
    rollbackMode,
    attemptSafetySummaryPath: input.terminalContext.attemptSafetySummaryPath,
    repairAttemptTimelinePath: input.terminalContext.repairAttemptTimelinePath,
    rollbackSummaryPath: input.terminalContext.rollbackSummaryPath,
    worktreeSafetySummaryPath: input.terminalContext.worktreeSafetySummaryPath,
    targetDirtyConflicts: input.terminalContext.worktreeSafetySummary?.target_dirty_conflicts ?? [],
    verifierContractSummary: input.verifierContractSummary,
  });

  return {
    status,
    contractStatus,
    rollbackMode,
    terminalSummary,
  };
}
