/**
 * D03 — structured terminal reason taxonomy.
 *
 * The arbiter/engine already knows *why* a turn terminated, but every
 * downstream surface used to see only `TerminalOutcome` (and, worse, the card
 * text-matched prose). This module is the single, pure translation layer from
 * the concrete policy source / failure text / limiter classification into a
 * closed reason code plus a separately-classified cause domain.
 *
 * Rules:
 *  - Additive only: `TerminalOutcome`, `ChatStatus` and friends are unchanged.
 *  - The free-text `reason`/`message` stays diagnostic; UIs branch on
 *    {@link TerminalReason.code}, never on prose.
 *  - Unknown causes stay `unknown`/absent — never fabricated.
 */

import type { TerminalOutcome, TerminalReasonCode } from '../schemas/agentContracts.js';
import type { FailureDomain } from '../services/outcomeSemantics.js';
import type { ChatTerminalClassification } from '../config/chatEngineLimits.js';
import {
  isBudgetErrorText,
  isEnvironmentErrorText,
  isInfrastructureErrorText,
  isLocalEnvironmentErrorText,
  isPolicyErrorText,
  isProviderOutputLimitText,
} from './chatFailureClassification.js';

export type { TerminalReasonCode };

/**
 * A structured terminal reason. `cause_class` is intentionally a separate axis
 * from `code` (e.g. a recovery exhaustion can be model- or harness-caused) and
 * may be `null` when the cause genuinely is not established.
 */
export interface TerminalReason {
  code: TerminalReasonCode;
  cause_class: FailureDomain;
  /** Short machine note (the precise policy source / limiter). Not UI authority. */
  detail?: string;
}

export interface TerminalReasonGuidance {
  message: string;
  nextActions: string[];
}

const GUIDANCE: Record<TerminalReasonCode, TerminalReasonGuidance> = {
  recovery_exhausted: {
    message: 'No progress after recovery; inspect diagnostics / narrow scope',
    nextActions: ['Inspect diagnostics', 'Narrow scope', 'Continue with guidance'],
  },
  permission_denied: {
    message: 'Blocked by policy — an action was not permitted',
    nextActions: ['Review permission', 'Request access'],
  },
  external_dependency: {
    message: 'Blocked by an external dependency / toolchain',
    nextActions: ['Provide dependency', 'Re-run when available'],
  },
  provider_failure: {
    message: 'Provider / infrastructure failure',
    nextActions: ['Retry'],
  },
  verification_failed: {
    message: 'Authoritative verification failed — the change did not pass its verifier',
    nextActions: ['Inspect verifier output', 'Fix the failing check', 'Re-run verification'],
  },
  unsupported_operation: {
    message: 'The requested mode or operation is not supported',
    nextActions: ['Use a supported mode/operation'],
  },
  cancelled: {
    message: 'Cancelled',
    nextActions: [],
  },
  budget_exhausted: {
    message: 'Budget limit reached',
    nextActions: ['Follow-up to continue'],
  },
  unknown: {
    message: 'Cause was not established',
    nextActions: ['Inspect diagnostics — cause was not established'],
  },
};

/** Reason-first operator guidance. Returns fresh arrays (callers may mutate). */
export function terminalReasonGuidance(
  code: TerminalReasonCode,
  detail?: string,
): TerminalReasonGuidance {
  const base = GUIDANCE[code];
  const message =
    code === 'recovery_exhausted' && detail === 'zero_write_hard_stop'
      ? 'No successful write before the turn ceiling; inspect diagnostics / narrow scope'
      : base.message;
  return { message, nextActions: [...base.nextActions] };
}

/**
 * Map an arbiter policy winner source to its terminal reason.
 * Returns `undefined` for nudge-only sources (no terminal was selected).
 */
export function classifyPolicySource(
  source: string | null | undefined,
  opts: {
    noProgressReason?: string;
  } = {},
): TerminalReason | undefined {
  if (!source) return undefined;
  switch (source) {
    case 'progress_terminal':
      return {
        code: 'recovery_exhausted',
        cause_class:
          opts.noProgressReason === 'repeated_unchanged_reads' ? 'model' : null,
        detail: opts.noProgressReason ?? 'progress_terminal',
      };
    case 'zero_write':
      return { code: 'recovery_exhausted', cause_class: 'harness', detail: 'zero_write_hard_stop' };
    case 'hard_ceiling':
      return { code: 'budget_exhausted', cause_class: 'harness', detail: 'hard_ceiling' };
    case 'investigate_hard_cap':
      return { code: 'budget_exhausted', cause_class: 'harness', detail: 'investigate_tool_cap' };
    case 'read_only_hard_cap':
      return { code: 'budget_exhausted', cause_class: 'harness', detail: 'inspection_tool_cap' };
    case 'env_blocked':
      return { code: 'external_dependency', cause_class: 'environment', detail: 'env_blocked' };
    case 'external_blocker':
      return { code: 'external_dependency', cause_class: 'environment' };
    case 'explicit_deny':
      return { code: 'permission_denied', cause_class: 'harness', detail: 'explicit_deny' };
    case 'circuit_breaker':
      return { code: 'permission_denied', cause_class: 'harness', detail: 'circuit_breaker' };
    default:
      return undefined;
  }
}

/** Map free-text failure error into a reason, mirroring `classifyFailureText` order. */
export function terminalReasonFromFailureText(
  error: string | null | undefined,
): TerminalReason | undefined {
  if (!error) return undefined;
  if (isProviderOutputLimitText(error) || isBudgetErrorText(error)) {
    return { code: 'budget_exhausted', cause_class: 'harness' };
  }
  // The kernel/adapters produce these themselves for a genuinely unsupported
  // mode/operation — a harness-origin fact, not model prose.
  if (
    /cannot execute unsupported|unsupported (?:operation|tool request|tool|mode|action)|operation (?:is )?not supported|mode .*not supported/i.test(
      error,
    )
  ) {
    return { code: 'unsupported_operation', cause_class: 'harness' };
  }
  // Only an explicit denial establishes a permission cause. A generic policy
  // block may be zero-write / tamper / gate / stall / auto-continue and must
  // not fabricate a missing permission.
  if (/permission denied by policy|explicit_deny|circuit_breaker/i.test(error)) {
    return { code: 'permission_denied', cause_class: 'harness' };
  }
  if (isPolicyErrorText(error)) {
    return { code: 'unknown', cause_class: null, detail: 'policy_block' };
  }
  if (isLocalEnvironmentErrorText(error)) {
    return { code: 'external_dependency', cause_class: 'environment', detail: 'local_environment' };
  }
  if (isEnvironmentErrorText(error)) {
    return { code: 'external_dependency', cause_class: 'environment' };
  }
  if (isInfrastructureErrorText(error)) {
    return { code: 'provider_failure', cause_class: 'provider' };
  }
  return undefined;
}

/**
 * Fallback mapping when only a canonical `TerminalOutcome` is known (e.g. a
 * resumed session or a surface that predates the reason code). Success-family
 * outcomes carry no reason.
 */
export function terminalReasonFromOutcome(
  outcome: TerminalOutcome | null | undefined,
): TerminalReason | undefined {
  switch (outcome) {
    case 'CANCELLED':
      return { code: 'cancelled', cause_class: null };
    case 'BUDGET_EXHAUSTED':
      return { code: 'budget_exhausted', cause_class: 'harness' };
    case 'BLOCKED_EXTERNAL':
      return { code: 'external_dependency', cause_class: 'environment' };
    case 'BLOCKED_POLICY':
      // BLOCKED_POLICY is the broad bucket for zero_write / tamper / critic /
      // gate / auto-continue / stall etc. Without an explicit source we cannot
      // assert a permission cause — do not fabricate one.
      return { code: 'unknown', cause_class: null };
    case 'INFRA_FAILURE':
      return { code: 'provider_failure', cause_class: 'provider' };
    case 'AGENT_FAILURE':
      // Crash / unrecoverable — the specific cause is not established.
      return { code: 'unknown', cause_class: null };
    default:
      return undefined;
  }
}

/** Map a limiter classification (turns/wall/cost/tokens/child/stall) into a reason. */
export function terminalReasonFromClassification(
  classification: ChatTerminalClassification | null | undefined,
): TerminalReason | undefined {
  switch (classification) {
    case 'cancelled':
      return { code: 'cancelled', cause_class: null, detail: 'cancelled' };
    case 'limit_stall':
      return { code: 'recovery_exhausted', cause_class: null, detail: 'limit_stall' };
    case 'limit_wall':
    case 'limit_cost':
    case 'limit_wall_repair':
    case 'limit_cost_repair':
    case 'limit_turns':
    case 'limit_tokens':
    case 'limit_child':
      return { code: 'budget_exhausted', cause_class: 'harness', detail: classification };
    case 'model_failure':
      return { code: 'provider_failure', cause_class: 'provider', detail: 'model_failure' };
    case 'policy_block':
      // Broad policy bucket; the specific source is not established here, so
      // do not assert a permission cause.
      return { code: 'unknown', cause_class: null, detail: 'policy_block' };
    default:
      return undefined;
  }
}
