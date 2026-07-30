import {
  isBlockedOutcome,
  isFailureOutcome,
  isPassingOutcome,
  type TerminalOutcome,
} from '../schemas/agentContracts.js';

export type UserFacingStatus = 'success' | 'partial' | 'blocked' | 'failed' | 'not_verified';
type VerificationStatus = 'passed' | 'failed' | 'skipped' | 'not_required' | 'unknown';

interface UserFacingVerificationPayload {
  status: VerificationStatus;
  commands: string[];
  skipped_reason: string | null;
}

/**
 * Map TerminalOutcome → user-facing status (P0-D / B3 authoritative path).
 * Never maps blocked/cancelled/budget/agent failure to success.
 */
export function userFacingStatusFromOutcome(outcome: TerminalOutcome): UserFacingStatus {
  switch (outcome) {
    case 'VERIFIED_COMPLETE':
      return 'success';
    case 'UNVERIFIED_PATCH':
      // Completed without authoritative verification — not a silent pass.
      return 'not_verified';
    case 'BLOCKED_EXTERNAL':
    case 'BLOCKED_POLICY':
      return 'blocked';
    case 'BUDGET_EXHAUSTED':
    case 'CANCELLED':
    case 'INFRA_FAILURE':
    case 'AGENT_FAILURE':
      return 'failed';
  }
}

/** Process exit code from TerminalOutcome (0 only for passing outcomes). */
export function exitCodeFromOutcome(outcome: TerminalOutcome): number {
  return isPassingOutcome(outcome) ? 0 : 1;
}

/** Maps runtime status + optional TerminalOutcome to a user-facing status label.
 *  Two-phase design:
 *  1. When `outcome` is provided (honest terminal outcome), it is the
 *     authoritative source — the switch bypasses all legacy heuristics.
 *  2. Legacy heuristic path for callers that don't yet supply TerminalOutcome. */
export function getUserFacingStatus(input: {
  status: string;
  verification: UserFacingVerificationPayload;
  changedFiles: string[];
  /** Optional TerminalOutcome for honest status rendering. */
  outcome?: TerminalOutcome;
}): UserFacingStatus {
  // When TerminalOutcome is available, use it as the authoritative source.
  if (input.outcome !== undefined) {
    return userFacingStatusFromOutcome(input.outcome);
  }
  // Legacy heuristic path for callers that don't provide TerminalOutcome.
  if (input.verification.status === 'skipped') {
    return 'not_verified';
  }
  if (input.verification.status === 'failed') {
    return 'failed';
  }
  if (/FAILED|FAIL|HALTED|REJECTED|DENIED|DRIFT|UNSAFE|ROLLBACK_FAILED/.test(input.status)) {
    return 'failed';
  }
  if (/BUDGET/.test(input.status)) {
    return 'failed';
  }
  if (
    /APPROVAL_REQUIRED|BLOCKED|MANUAL_BRIDGE_REQUIRED|PLAN_READY|PATCH_READY|NEEDS_MORE_CONTEXT/.test(
      input.status,
    )
  ) {
    return input.status === 'PLAN_READY' || input.status === 'PATCH_READY' ? 'success' : 'blocked';
  }
  if (/PARTIAL/.test(input.status)) {
    return 'partial';
  }
  return 'success';
}

// Re-export outcome classifiers for CLI exit-code helpers.
export { isBlockedOutcome, isFailureOutcome, isPassingOutcome };
