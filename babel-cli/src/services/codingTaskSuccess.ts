/**
 * codingTaskSuccess.ts — honest coding-task gate classification (P0-E / HF-05).
 *
 * Coding-task success means a correct, verified (or explicitly unverified-with-patch)
 * outcome. Rich early BLOCKED artifacts are valuable diagnostics — they are never
 * treated as coding-task pass. See Codex harness parity plan P0-E and teardown HF-05.
 *
 * P0-F semantics note: the legacy `pass` verdict is "real completion with mutation
 * (and verifier if required)". It is NOT synonymous with verified_success when
 * `requireVerifier` is false — an UNVERIFIED_PATCH can legitimately be `pass`.
 * Routing / eval consumers that need the verified dimension MUST use
 * `classifyCodingTaskGateDetailed` (or `resolveOutcome`) so that
 * generic_pass ≠ verified_success unless the contract defines them as equal.
 */

import {
  isPassingOutcome,
  type TerminalOutcome,
} from '../schemas/agentContracts.js';
import {
  dimensionsFromCodingTaskInput,
  resolveOutcome,
  type CodingTaskOutcomeInput,
  type OutcomeLabel,
} from './outcomeSemantics.js';

/** Gate verdict for coding-task evaluation (not smoke-honesty). */
export type CodingTaskGateVerdict = 'pass' | 'fail' | 'diagnostic';

/**
 * Coding-task success input. Extends the canonical outcome source so the
 * detailed classification can derive the P0-F dimensions from a real
 * verifier receipt + workspace revision + completion-gate result instead of
 * the bare `verifierOk` boolean (regression-gate O05/O06).
 */
export interface CodingTaskSuccessInput extends CodingTaskOutcomeInput {
  /** Agent answer / blocked narrative. */
  answerText?: string | null;
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

/**
 * P0-F: detailed coding-task classification exposing the canonical outcome
 * dimensions (verified_success / false_completion / label) alongside the legacy
 * verdict. Consumers that feed routing or evaluation statistics MUST use this
 * (or resolveOutcome directly) so generic `pass` is never silently interpreted
 * as verified_success.
 */
export function classifyCodingTaskGateDetailed(input: CodingTaskSuccessInput): {
  verdict: CodingTaskGateVerdict;
  verifiedSuccess: boolean;
  falseCompletion: boolean;
  label: OutcomeLabel;
} {
  const verdict = classifyCodingTaskGate(input);
  const resolved = resolveOutcome(dimensionsFromCodingTaskInput(input));
  // Keep the legacy verdict authoritative for the pass/fail/diagnostic gate and
  // expose the canonical dimensions alongside it.
  return {
    verdict,
    verifiedSuccess: resolved.verifiedSuccess,
    falseCompletion: resolved.falseCompletion,
    label: resolved.label,
  };
}
