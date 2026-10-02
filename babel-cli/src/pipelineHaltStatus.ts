import { type TerminalStatus } from './services/terminalStatus.js';


type ExecutorTerminalStatus =
  | 'EXECUTION_COMPLETE'
  | 'EXECUTION_HALTED'
  | 'ACTIVATION_REFUSED'
  | 'PARTIAL';

// ─── Executor halt resolution ──────────────────────────────────────────────────

interface ExecutorHaltResolution {
  haltedStatus: TerminalStatus;
  matchedConditions: string[];
}


export function resolveExecutorHaltStatus(
  haltCondition: string,
  haltTag: string | undefined,
): ExecutorHaltResolution {
  const matchedConditions: string[] = [];
  let haltedStatus: TerminalStatus = 'EXECUTOR_HALTED';

  if (/\[ROLLBACK_FAILED\]/.test(haltCondition)) {
    haltedStatus = 'ROLLBACK_FAILED';
    matchedConditions.push('ROLLBACK_FAILED');
  }
  if (/\[ROLLBACK_APPLIED\]/.test(haltCondition)) {
    if (haltedStatus === 'EXECUTOR_HALTED') haltedStatus = 'ROLLBACK_APPLIED';
    matchedConditions.push('ROLLBACK_APPLIED');
  }
  if (/\[WORKTREE_DIRTY_UNSAFE\]/.test(haltCondition)) {
    if (haltedStatus === 'EXECUTOR_HALTED') haltedStatus = 'WORKTREE_DIRTY_UNSAFE';
    matchedConditions.push('WORKTREE_DIRTY_UNSAFE');
  }
  if (/\[VERIFIER_NOT_FOUND\]/.test(haltCondition)) {
    if (haltedStatus === 'EXECUTOR_HALTED') haltedStatus = 'VERIFIER_NOT_FOUND';
    matchedConditions.push('VERIFIER_NOT_FOUND');
  }
  if (/\[REPAIR_REPEATED_FAILURE\]/.test(haltCondition)) {
    if (haltedStatus === 'EXECUTOR_HALTED') haltedStatus = 'REPAIR_REPEATED_FAILURE';
    matchedConditions.push('REPAIR_REPEATED_FAILURE');
  }
  if (
    haltTag === 'REPAIR_BUDGET_EXCEEDED' ||
    /\[REPAIR_MAX_ATTEMPTS_REACHED\]/.test(haltCondition)
  ) {
    if (haltedStatus === 'EXECUTOR_HALTED') haltedStatus = 'REPAIR_MAX_ATTEMPTS_REACHED';
    matchedConditions.push('REPAIR_MAX_ATTEMPTS_REACHED');
  }
  if (/\[SHELL_COMMAND_DENIED\]/.test(haltCondition)) {
    if (haltedStatus === 'EXECUTOR_HALTED') haltedStatus = 'SHELL_COMMAND_DENIED';
    matchedConditions.push('SHELL_COMMAND_DENIED');
  }
  if (/\[SHELL_COMMAND_FAILED\]/.test(haltCondition)) {
    if (haltedStatus === 'EXECUTOR_HALTED') haltedStatus = 'SHELL_COMMAND_FAILED';
    matchedConditions.push('SHELL_COMMAND_FAILED');
  }
  if (/\[VERIFIER_FAILED\]/.test(haltCondition)) {
    if (haltedStatus === 'EXECUTOR_HALTED') haltedStatus = 'VERIFIER_FAILED';
    matchedConditions.push('VERIFIER_FAILED');
  }

  return { haltedStatus, matchedConditions };
}
