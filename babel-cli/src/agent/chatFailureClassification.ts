/**
 * Shared failure classification for Chat surfaces.
 * Unknown causes stay inconclusive — never default to AGENT_FAILURE.
 */

import type { TerminalOutcome } from '../schemas/agentContracts.js';

type ChatStatus = 'completed' | 'failed' | 'cancelled' | 'blocked' | 'budget_exhausted';

const INFRA_CODE_RE =
  /\b(?:ENOSPC|EROFS|EIO|EBUSY|EMFILE|ENFILE|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EHOSTUNREACH)\b/i;

/** Detect infrastructure/network/provider failure text without inventing agent blame. */
export function isInfrastructureErrorText(error: string): boolean {
  if (!error) return false;
  return (
    INFRA_CODE_RE.test(error) ||
    /runtime-invariant/i.test(error) ||
    /socket hang up|connection reset|fetch failed|undici|network (?:error|timeout)|broken pipe/i.test(error) ||
    /provider (?:startup|stream) idle|idle timeout|request deadline|request timeout|timeout exceeded/i.test(error) ||
    /stream closed before terminal|malformed sse|provider stream error|finish_reason: (?:error|length)/i.test(error) ||
    /\[(?:deepSeekApi|deepInfraApi|openRouterApi|provider)\]/i.test(error) ||
    /provider (?:error|disconnected)|overloaded|service unavailable|bad gateway|rate limit|502 Bad Gateway|503 Service Unavailable|504 Gateway Timeout/i.test(error)
  );
}

export function isBudgetErrorText(error: string): boolean {
  return /budget.*exceed(?:ed|s)|cost budget|wall (?:time|clock|budget)|token explosion|turn limit exceeded|max turns reached/i.test(error);
}

export function isPolicyErrorText(error: string): boolean {
  return /blocked_policy|policy (?:block|intervention|denied)|permission denied by policy/i.test(error);
}

export function isEnvironmentErrorText(error: string): boolean {
  return /env(?:ironment)?[ _]blocked|toolchain cannot|missing (?:runtime|dependency)|permission denied(?! by policy)/i.test(error);
}

/**
 * Classify failure text into an established TerminalOutcome.
 * Returns undefined when the cause is not established (UNKNOWN/INCONCLUSIVE).
 * Never defaults to AGENT_FAILURE.
 */
export function classifyFailureText(error: string): TerminalOutcome | undefined {
  if (!error) return undefined;
  if (isBudgetErrorText(error)) return 'BUDGET_EXHAUSTED';
  if (isPolicyErrorText(error)) return 'BLOCKED_POLICY';
  if (isEnvironmentErrorText(error)) return 'BLOCKED_EXTERNAL';
  if (isInfrastructureErrorText(error)) return 'INFRA_FAILURE';
  return undefined;
}

export function statusForOutcome(outcome: TerminalOutcome): ChatStatus {
  if (outcome === 'CANCELLED') return 'cancelled';
  if (outcome === 'BUDGET_EXHAUSTED') return 'budget_exhausted';
  if (
    outcome === 'BLOCKED_POLICY' ||
    outcome === 'BLOCKED_EXTERNAL' ||
    outcome === 'INVALID_TASK' ||
    outcome === 'NEEDS_HUMAN_DECISION'
  ) {
    return 'blocked';
  }
  if (outcome === 'VERIFIED_COMPLETE' || outcome === 'UNVERIFIED_PATCH' || outcome === 'NO_CHANGE_REQUIRED') {
    return 'completed';
  }
  return 'failed';
}

/** Resolve a failed-event outcome without treating engine AGENT_FAILURE as proof. */
export function resolveFailedEventOutcome(
  error: string,
  explicit?: TerminalOutcome,
): TerminalOutcome | undefined {
  const fromText = classifyFailureText(error);
  if (fromText) return fromText;
  if (explicit && explicit !== 'AGENT_FAILURE') return explicit;
  return undefined;
}
