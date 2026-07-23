/**
 * Pure helpers for honest budget-kill terminal classification.
 * Unit-tested; no I/O.
 */

export type BudgetKillKind = 'wall' | 'cost' | 'token_explosion' | 'unknown';

export function classifyBudgetKillReason(reason: string): BudgetKillKind {
  const r = reason.toLowerCase();
  if (r.includes('time budget') || r.includes('wall')) return 'wall';
  if (r.includes('cost budget') || r.includes('$')) return 'cost';
  if (r.includes('token') && (r.includes('explod') || r.includes('zero mutation') || r.includes('zero write'))) {
    return 'token_explosion';
  }
  if (r.includes('budget')) return 'unknown';
  return 'unknown';
}

/** True when an answer/reason string is a budget kill (not generic NEEDS_MORE_CONTEXT). */
export function isBudgetExceededText(text: string | null | undefined): boolean {
  if (!text) return false;
  return (
    /\bBUDGET_EXCEEDED\b/i.test(text) ||
    /Time budget exceeded/i.test(text) ||
    /Cost budget exceeded/i.test(text) ||
    /token explosion/i.test(text) ||
    /Budget limit exceeded/i.test(text)
  );
}

/**
 * Map ChatResult-like status + answer to payload answer status.
 * Budget kills get BUDGET_EXCEEDED (explicit), not NEEDS_MORE_CONTEXT.
 */
export function mapChatResultToPayloadStatus(input: {
  status: 'completed' | 'failed' | 'cancelled' | 'blocked';
  answer?: string;
  budgetExceeded?: boolean;
}): 'ANSWER_READY' | 'BLOCKED' | 'BUDGET_EXCEEDED' | 'NEEDS_MORE_CONTEXT' | 'CANCELLED' {
  if (input.status === 'completed') return 'ANSWER_READY';
  if (input.status === 'cancelled') return 'CANCELLED';
  // Budget exhaustion takes priority over generic blocked/failed — wall/cost
  // safety ceilings always report BUDGET_EXCEEDED even when the final status
  // is 'blocked' (e.g. last-chance critic rejection during budget kill).
  if (input.budgetExceeded || isBudgetExceededText(input.answer)) {
    return 'BUDGET_EXCEEDED';
  }
  if (input.status === 'blocked') return 'BLOCKED';
  return 'NEEDS_MORE_CONTEXT';
}

/** Format a terminal budget-kill answer that stays machine-classifiable. */
export function formatBudgetExceededAnswer(
  reason: string,
  extras?: { hadWrites?: boolean; criticVerdict?: string | null },
): string {
  const kind = classifyBudgetKillReason(reason);
  const lines = [
    `BUDGET_EXCEEDED: ${reason}`,
    `budget_kind=${kind}`,
  ];
  if (extras?.hadWrites !== undefined) {
    lines.push(`had_writes=${extras.hadWrites ? '1' : '0'}`);
  }
  if (extras?.criticVerdict) {
    lines.push(`critic_verdict=${extras.criticVerdict}`);
  }
  return lines.join('\n');
}

/**
 * Early-abort policy: tokens this turn explode with zero mutations across session.
 * Pure decision helper.
 *
 * Call AFTER the turn's LLM usage is tracked — never with tokensAtTurnStart
 * equal to tokensNow from a pre-turn reset (that always yields delta 0).
 */
export function shouldAbortTokenExplosion(input: {
  tokensThisTurn: number;
  maxTokensPerRound: number;
  hasAnyWrites: boolean;
  /** Multiplier of maxTokensPerRound before abort (default 1.0). */
  multiplier?: number;
}): boolean {
  if (input.hasAnyWrites) return false;
  const mult = input.multiplier ?? 1.0;
  return input.tokensThisTurn > input.maxTokensPerRound * mult;
}

/**
 * End-of-turn token-explosion evaluation using turn-start vs turn-end counters.
 * This is the shipped entry for ChatEngine (submitMessage + stream).
 */
export function evaluateTokenExplosionAfterTurn(input: {
  tokensAtTurnStart: number;
  tokensNow: number;
  maxTokensPerRound: number;
  hasAnyWrites: boolean;
  multiplier?: number;
}): { abort: boolean; tokensThisTurn: number } {
  const tokensThisTurn = Math.max(0, input.tokensNow - input.tokensAtTurnStart);
  return {
    tokensThisTurn,
    abort: shouldAbortTokenExplosion({
      tokensThisTurn,
      maxTokensPerRound: input.maxTokensPerRound,
      hasAnyWrites: input.hasAnyWrites,
      ...(input.multiplier !== undefined ? { multiplier: input.multiplier } : {}),
    }),
  };
}

/** Zero-write force-mutate escalation after N execute turns with no mutation. */
export function shouldForceMutateEscalation(input: {
  executeIntent: boolean;
  turnsWithoutWrite: number;
  threshold: number;
  hasAnyWrites: boolean;
}): boolean {
  if (!input.executeIntent) return false;
  if (input.hasAnyWrites) return false;
  return input.turnsWithoutWrite >= input.threshold;
}

export function buildForceMutateMessage(turnsWithoutWrite: number): string {
  return [
    `STOP READING. ${turnsWithoutWrite} turns without a file mutation.`,
    '',
    'You have already localized the bug. Do NOT grep, read_file, or read_range again.',
    'Apply the fix NOW:',
    '',
    '1. Use str_replace with the exact old_string and new_string',
    '2. The fix should be minimal — typically 1-5 lines changed',
    '3. After str_replace succeeds, run the verifier',
    '',
    'Do NOT complete or describe the fix — you must apply it with str_replace.',
  ].join('\n');
}

/**
 * Hard-stop policy: execute tasks with zero successful mutations after N
 * completed turns → honest BLOCKED (no burning the full turn/cost budget).
 *
 * threshold <= 0 disables the fuse.
 */
export function shouldHardBlockZeroWrite(input: {
  executeIntent: boolean;
  completedTurns: number;
  threshold: number;
  hasAnyWrites: boolean;
}): boolean {
  if (!input.executeIntent) return false;
  if (input.hasAnyWrites) return false;
  if (input.threshold <= 0) return false;
  return input.completedTurns >= input.threshold;
}

export function buildZeroWriteHardStopMessage(completedTurns: number, threshold: number): string {
  return [
    `BLOCKED: ${completedTurns} turns completed with zero successful file mutations ` +
      `(hard-stop threshold: ${threshold}).`,
    'Execute-intent tasks must apply a real patch (str_replace / write_file / apply_patch) ' +
      'or declare BLOCKED earlier with a concrete missing dependency.',
    'Shell-only exploration without a mutation is treated as failure — not progress.',
  ].join('\n');
}
