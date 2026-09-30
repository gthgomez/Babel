/**
 * Shared failure classification for Chat surfaces.
 * Unknown causes stay inconclusive — never default to AGENT_FAILURE.
 */

import type { TerminalOutcome } from '../schemas/agentContracts.js';

export type ChatStatus = 'completed' | 'failed' | 'cancelled' | 'blocked' | 'budget_exhausted';

export interface ChatTerminalProjection {
  status: ChatStatus;
  /** Omitted when the terminal cause is genuinely unknown. */
  outcome?: TerminalOutcome;
}

/** Local OS resource errnos: disk/fs/IO/fd exhaustion on this machine. */
const LOCAL_ENV_CODE_RE = /\b(?:ENOSPC|EROFS|EIO|EBUSY|EMFILE|ENFILE)\b/i;

/** Network/transport errnos: an external endpoint/transport is implicated. */
const NETWORK_CODE_RE = /\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EHOSTUNREACH)\b/i;

/**
 * Local machine/environment failure (disk full, read-only filesystem, IO error,
 * file-descriptor exhaustion). This is not provider blame and must never be
 * classified as infrastructure/provider failure.
 */
export function isLocalEnvironmentErrorText(error: string): boolean {
  if (!error) return false;
  return LOCAL_ENV_CODE_RE.test(error);
}

/** Detect provider/network/transport failure text without inventing agent blame. */
export function isInfrastructureErrorText(error: string): boolean {
  if (!error) return false;
  // Local environment failures are attributed to the environment, never the
  // provider, even though they share the "infrastructure" umbrella.
  if (isLocalEnvironmentErrorText(error)) return false;
  return (
    NETWORK_CODE_RE.test(error) ||
    /runtime-invariant/i.test(error) ||
    /socket hang up|connection reset|fetch failed|undici|network (?:error|timeout)|broken pipe/i.test(error) ||
    /provider (?:startup|stream) idle|idle timeout|request deadline|request timeout|timeout exceeded/i.test(error) ||
    /stream closed before terminal|malformed sse|provider stream error|finish_reason: error/i.test(error) ||
    /\[(?:deepSeekApi|deepInfraApi|openRouterApi|provider)\]/i.test(error) ||
    /provider (?:error|disconnected)|overloaded|service unavailable|bad gateway|rate limit|502 Bad Gateway|503 Service Unavailable|504 Gateway Timeout/i.test(error)
  );
}

/** Provider output-token exhaustion is a budget condition, not transport failure. */
export function isProviderOutputLimitText(error: string): boolean {
  return /finish_reason:\s*length/i.test(error) || /output (?:token )?limit/i.test(error);
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
  if (isProviderOutputLimitText(error)) return 'BUDGET_EXHAUSTED';
  if (isBudgetErrorText(error)) return 'BUDGET_EXHAUSTED';
  if (isPolicyErrorText(error)) return 'BLOCKED_POLICY';
  if (isLocalEnvironmentErrorText(error)) return 'BLOCKED_EXTERNAL';
  if (isEnvironmentErrorText(error)) return 'BLOCKED_EXTERNAL';
  if (isInfrastructureErrorText(error)) return 'INFRA_FAILURE';
  return undefined;
}

/**
 * Canonical Chat terminal projection. A known TerminalOutcome is authoritative
 * over any legacy status supplied by an adapter; an unknown outcome stays
 * unknown and preserves only the observed status.
 */
export function projectChatTerminal(input: {
  outcome?: TerminalOutcome;
  status?: ChatStatus;
}): ChatTerminalProjection {
  const outcome = input.outcome;
  if (outcome === undefined) {
    return { status: input.status ?? 'failed' };
  }
  if (outcome === 'CANCELLED') return { status: 'cancelled', outcome };
  if (outcome === 'BUDGET_EXHAUSTED') return { status: 'budget_exhausted', outcome };
  if (
    outcome === 'BLOCKED_POLICY' ||
    outcome === 'BLOCKED_EXTERNAL' ||
    outcome === 'INVALID_TASK' ||
    outcome === 'NEEDS_HUMAN_DECISION'
  ) {
    return { status: 'blocked', outcome };
  }
  if (
    outcome === 'VERIFIED_COMPLETE' ||
    outcome === 'UNVERIFIED_PATCH' ||
    outcome === 'NO_CHANGE_REQUIRED'
  ) {
    return { status: 'completed', outcome };
  }
  return { status: 'failed', outcome };
}

export function statusForOutcome(outcome: TerminalOutcome): ChatStatus {
  return projectChatTerminal({ outcome }).status;
}

/** Preserve an authoritative failed-event outcome, otherwise classify its text conservatively. */
export function resolveFailedEventOutcome(
  error: string,
  explicit?: TerminalOutcome,
): TerminalOutcome | undefined {
  if (explicit) return explicit;
  const fromText = classifyFailureText(error);
  if (fromText) return fromText;
  return undefined;
}
