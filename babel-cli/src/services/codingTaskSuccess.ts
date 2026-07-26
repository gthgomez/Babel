/**
 * codingTaskSuccess.ts — honest coding-task gate classification (P0-E / HF-05).
 *
 * Coding-task success means a correct, verified (or explicitly unverified-with-patch)
 * outcome. Rich early BLOCKED artifacts are valuable diagnostics — they are never
 * treated as coding-task pass. See Codex harness parity plan P0-E and teardown HF-05.
 */

import {
  isPassingOutcome,
  type TerminalOutcome,
} from '../schemas/agentContracts.js';

/** Gate verdict for coding-task evaluation (not smoke-honesty). */
export type CodingTaskGateVerdict = 'pass' | 'fail' | 'diagnostic';

export interface CodingTaskSuccessInput {
  /** Honest terminal outcome when available. */
  terminalOutcome?: TerminalOutcome | null;
  /** Legacy payload status (ANSWER_READY, BLOCKED, …). */
  statusText?: string | null;
  /** Agent answer / blocked narrative. */
  answerText?: string | null;
  /** True when the session produced at least one successful file mutation. */
  hasSuccessfulMutation: boolean;
  /** Verifier commands passed when run. */
  verifierOk?: boolean;
  /** When true, verifierOk must be true for pass (default false → patch without verifier can pass). */
  requireVerifier?: boolean;
  /** Explicit blocked_report present. */
  declaredBlocked?: boolean;
}

/**
 * True when status/answer indicates a policy or external block (including EARLY_BLOCK_RICH).
 * These exits may be "honest" for smoke tests but never coding-task success.
 */
export function isEarlyOrPolicyBlock(input: {
  terminalOutcome?: TerminalOutcome | null;
  statusText?: string | null;
  answerText?: string | null;
  declaredBlocked?: boolean;
}): boolean {
  if (input.declaredBlocked) return true;
  if (input.terminalOutcome === 'BLOCKED_POLICY' || input.terminalOutcome === 'BLOCKED_EXTERNAL') {
    return true;
  }
  const status = (input.statusText ?? '').toUpperCase();
  if (status === 'BLOCKED' || status === 'NEEDS_MORE_CONTEXT') return true;
  if (/\bBLOCKED\b/i.test(input.answerText ?? '')) return true;
  if (/\bEARLY_BLOCK(?:_RICH)?\b/i.test(input.answerText ?? '')) return true;
  return false;
}

/**
 * Classify a coding-task cell for gates that must not reward rich failure.
 *
 * - `pass` — real completion with mutation (and verifier if required)
 * - `diagnostic` — honest early/policy BLOCKED (smoke may accept; coding gate must not)
 * - `fail` — false complete, infra, empty patch, budget, cancel, agent error
 */
export function classifyCodingTaskGate(input: CodingTaskSuccessInput): CodingTaskGateVerdict {
  if (isEarlyOrPolicyBlock(input)) {
    return 'diagnostic';
  }

  if (input.terminalOutcome) {
    if (input.terminalOutcome === 'BUDGET_EXHAUSTED' || input.terminalOutcome === 'CANCELLED') {
      return 'fail';
    }
    if (input.terminalOutcome === 'INFRA_FAILURE' || input.terminalOutcome === 'AGENT_FAILURE') {
      return 'fail';
    }
    if (!isPassingOutcome(input.terminalOutcome)) {
      return 'fail';
    }
  }

  const status = (input.statusText ?? '').toUpperCase();
  const claimedComplete =
    status === 'ANSWER_READY' ||
    status === 'FIX_COMPLETE' ||
    status === 'COMPLETE' ||
    status === 'SUCCESS' ||
    input.terminalOutcome === 'VERIFIED_COMPLETE' ||
    input.terminalOutcome === 'UNVERIFIED_PATCH';

  if (!input.hasSuccessfulMutation) {
    // Empty patch claimed complete = fail; empty with no claim = fail for coding gate.
    return 'fail';
  }

  if (input.requireVerifier && !input.verifierOk) {
    return claimedComplete ? 'fail' : 'fail';
  }

  if (input.terminalOutcome && isPassingOutcome(input.terminalOutcome)) {
    return 'pass';
  }

  if (claimedComplete && input.hasSuccessfulMutation && (!input.requireVerifier || input.verifierOk)) {
    return 'pass';
  }

  return 'fail';
}

/** Coding-task success predicate used by eval gates (never true for EARLY_BLOCK_RICH). */
export function isCodingTaskSuccess(input: CodingTaskSuccessInput): boolean {
  return classifyCodingTaskGate(input) === 'pass';
}
