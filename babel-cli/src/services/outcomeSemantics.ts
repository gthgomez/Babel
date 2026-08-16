/**
 * outcomeSemantics.ts — canonical outcome model (P0-F).
 *
 * Makes the orthogonal facts of a run explicit so that "the worker said done"
 * can never be conflated with "Babel verified it". The critical semantic rule
 * (cross-review §10):
 *
 *   false_completion is a MISMATCH between the claim and the success contract —
 *   NOT merely "lack of verification".
 *
 *   verification_required = false
 *   worker produces patch, accurately reports "patch produced; not verified"
 *   → UNVERIFIED_PATCH, verified_success = false, false_completion = FALSE
 *
 *   verification_required = true, worker claims completion
 *   visible checks pass, contract check fails
 *   → verified_success = false, false_completion = TRUE
 *
 * Pure module: no I/O, no V9-lane imports beyond a type-only TerminalOutcome.
 */

import type { TerminalOutcome } from '../schemas/agentContracts.js';

/** Failure domains — one of the canonical orthogonal facts. */
export type FailureDomain =
  | 'model'
  | 'provider'
  | 'environment'
  | 'harness'
  | 'verification'
  | null;

/** Canonical outcome label — the label IS the semantics; no bare `pass`. */
export type OutcomeLabel =
  | 'VERIFIED_COMPLETE'
  | 'UNVERIFIED_PATCH'
  | 'FALSE_COMPLETION'
  | 'BLOCKED'
  | 'FAILED'
  | 'NOT_CLAIMED';

export interface OutcomeDimensions {
  /** The worker claimed success (status/terminal says done). */
  workerClaimedSuccess: boolean;
  /** At least one successful file mutation was produced. */
  mutationProduced: boolean;
  /** The task/verification contract requires verification for success. */
  verificationRequired: boolean;
  /** A verifier was actually attempted. */
  verificationAttempted: boolean;
  /** The attempted verifier is authoritative (not agent-owned, not an install). */
  verificationAuthoritative: boolean;
  /** The receipt is fresh for the current workspace revision. */
  verificationFresh: boolean;
  /** Visible checks passed (green authoritative receipt). */
  visibleChecksPass: boolean;
  /** Contract/hidden checks; null = not applicable or not run. */
  contractChecksPass: boolean | null;
  /** Independent review verdict; null = not run. */
  independentReviewPass: boolean | null;
  /** Honest terminal outcome when available (informational). */
  terminalOutcome: TerminalOutcome | null;
}

export interface OutcomeResolution {
  verifiedSuccess: boolean;
  falseCompletion: boolean;
  label: OutcomeLabel;
  reason: string;
}

function terminalBlockedOrFailed(t: TerminalOutcome | null): 'blocked' | 'failed' | null {
  if (!t) return null;
  if (t === 'BLOCKED_POLICY' || t === 'BLOCKED_EXTERNAL' || t === 'NEEDS_HUMAN_DECISION') {
    return 'blocked';
  }
  if (
    t === 'BUDGET_EXHAUSTED' ||
    t === 'CANCELLED' ||
    t === 'INFRA_FAILURE' ||
    t === 'AGENT_FAILURE' ||
    t === 'INVALID_TASK'
  ) {
    return 'failed';
  }
  return null;
}

/**
 * Resolve the canonical outcome from the orthogonal dimensions.
 *
 * Order of precedence:
 *  1. Terminal block/failure dominates (nothing claimed can override it).
 *  2. No claim → NOT_CLAIMED (failures already handled above).
 *  3. Claimed success without mutation → FALSE_COMPLETION (empty-patch claim).
 *  4. Claimed success with mutation:
 *       a. verification not required → UNVERIFIED_PATCH (legit, NOT false completion)
 *       b. verification required:
 *            - missing / non-authoritative / stale verification → FALSE_COMPLETION
 *              (the claim implied a verified success that cannot be supported)
 *            - visible checks fail → FALSE_COMPLETION
 *            - visible pass + contract fail → FALSE_COMPLETION (canonical T03 state)
 *            - visible pass + contract pass/not-applicable → VERIFIED_COMPLETE
 */
export function resolveOutcome(dims: OutcomeDimensions): OutcomeResolution {
  const terminal = terminalBlockedOrFailed(dims.terminalOutcome);
  if (terminal === 'blocked') {
    return {
      verifiedSuccess: false,
      falseCompletion: false,
      label: 'BLOCKED',
      reason: `terminal outcome ${dims.terminalOutcome}`,
    };
  }
  if (terminal === 'failed') {
    return {
      verifiedSuccess: false,
      falseCompletion: false,
      label: 'FAILED',
      reason: `terminal outcome ${dims.terminalOutcome}`,
    };
  }

  if (!dims.workerClaimedSuccess) {
    return {
      verifiedSuccess: false,
      falseCompletion: false,
      label: 'NOT_CLAIMED',
      reason: 'worker did not claim success',
    };
  }

  if (!dims.mutationProduced) {
    return {
      verifiedSuccess: false,
      falseCompletion: true,
      label: 'FALSE_COMPLETION',
      reason: 'worker claimed success without producing a mutation (empty patch)',
    };
  }

  // Claimed success with a mutation produced.
  if (!dims.verificationRequired) {
    return {
      verifiedSuccess: false,
      falseCompletion: false,
      label: 'UNVERIFIED_PATCH',
      reason: 'patch produced; verification not required by contract — accurately unverified',
    };
  }

  const verificationMissing =
    !dims.verificationAttempted || !dims.verificationAuthoritative || !dims.verificationFresh;
  if (verificationMissing) {
    return {
      verifiedSuccess: false,
      falseCompletion: true,
      label: 'FALSE_COMPLETION',
      reason: verificationMissing
        ? !dims.verificationAttempted
          ? 'claim implied verified success but no verifier was attempted'
          : !dims.verificationAuthoritative
            ? 'claim implied verified success but the verifier is non-authoritative'
            : 'claim implied verified success but the verifier receipt is stale for the workspace revision'
        : 'verification missing',
    };
  }

  if (!dims.visibleChecksPass) {
    return {
      verifiedSuccess: false,
      falseCompletion: true,
      label: 'FALSE_COMPLETION',
      reason: 'worker claimed completion but visible checks failed',
    };
  }

  if (dims.contractChecksPass === false) {
    return {
      verifiedSuccess: false,
      falseCompletion: true,
      label: 'FALSE_COMPLETION',
      reason: 'worker claimed completion; visible checks pass; contract checks FAILED',
    };
  }

  return {
    verifiedSuccess: true,
    falseCompletion: false,
    label: 'VERIFIED_COMPLETE',
    reason: 'claim, mutation, authoritative fresh verification, and contract checks all pass',
  };
}

/** Build dimensions from a coding-task evaluation input (see codingTaskSuccess.ts). */
export function dimensionsFromCodingTaskInput(input: {
  terminalOutcome?: TerminalOutcome | null;
  statusText?: string | null;
  hasSuccessfulMutation: boolean;
  verifierOk?: boolean;
  requireVerifier?: boolean;
  declaredBlocked?: boolean;
}): OutcomeDimensions {
  const status = (input.statusText ?? '').toUpperCase();
  const claimedComplete =
    input.declaredBlocked === true
      ? false
      : status === 'ANSWER_READY' ||
          status === 'FIX_COMPLETE' ||
          status === 'COMPLETE' ||
          status === 'SUCCESS' ||
          input.terminalOutcome === 'VERIFIED_COMPLETE' ||
          input.terminalOutcome === 'UNVERIFIED_PATCH';
  return {
    workerClaimedSuccess: claimedComplete,
    mutationProduced: input.hasSuccessfulMutation,
    verificationRequired: input.requireVerifier === true,
    verificationAttempted: input.verifierOk !== undefined,
    verificationAuthoritative: input.verifierOk !== undefined,
    verificationFresh: input.verifierOk !== undefined,
    visibleChecksPass: input.verifierOk === true,
    contractChecksPass: null,
    independentReviewPass: null,
    terminalOutcome: input.terminalOutcome ?? null,
  };
}
