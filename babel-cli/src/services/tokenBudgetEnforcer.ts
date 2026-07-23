/**
 * tokenBudgetEnforcer.ts — Proactive token budget enforcement for the pipeline.
 *
 * The budgetPolicy.ts module defines budget thresholds and diagnostics.
 * This module adds proactive enforcement: before each pipeline stage,
 * check the accumulated token count against the effective budget limit
 * and halt the pipeline if the budget would be exceeded.
 */

import { getEffectiveBudgetLimit } from '../budgetPolicy.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface BudgetEnforcementResult {
  /** Whether the pipeline should proceed (true) or halt (false). */
  proceed: boolean;
  /** The effective budget limit being enforced. */
  budgetLimit: number;
  /** Token count used so far (0 if tracking unavailable). */
  tokensUsed: number;
  /** Budget remaining (budgetLimit - tokensUsed). */
  tokensRemaining: number;
  /** Reason for halting, if proceed is false. */
  reason?: string;
}

// ── Enforcement ───────────────────────────────────────────────────────────────

/**
 * Check whether the pipeline should proceed given the current token usage.
 *
 * @param tokensUsed  - Number of tokens consumed so far (from costTracker or compiler).
 * @param cliOverride - Optional CLI --budget flag override.
 * @returns A BudgetEnforcementResult indicating whether to proceed or halt.
 */
export function checkTokenBudget(
  tokensUsed: number = 0,
  cliOverride?: number,
): BudgetEnforcementResult {
  const budgetLimit = getEffectiveBudgetLimit(process.env, cliOverride);
  const tokensRemaining = budgetLimit - tokensUsed;

  if (tokensRemaining <= 0) {
    return {
      proceed: false,
      budgetLimit,
      tokensUsed,
      tokensRemaining,
      reason: `Token budget exhausted: ${tokensUsed} tokens used of ${budgetLimit} limit.`,
    };
  }

  // Warn when within 20% of budget
  const warnThreshold = Math.floor(budgetLimit * 0.8);
  if (tokensUsed >= warnThreshold) {
    return {
      proceed: true,
      budgetLimit,
      tokensUsed,
      tokensRemaining,
      reason: `Token budget warning: ${tokensUsed}/${budgetLimit} tokens used (${Math.round((tokensUsed / budgetLimit) * 100)}%).`,
    };
  }

  return {
    proceed: true,
    budgetLimit,
    tokensUsed,
    tokensRemaining,
  };
}

/**
 * Get the effective budget limit from environment or CLI override.
 * Convenience wrapper around getEffectiveBudgetLimit for pipeline use.
 */
export function resolveBudgetLimit(cliOverride?: number): number {
  return getEffectiveBudgetLimit(process.env, cliOverride);
}

/**
 * Format a budget enforcement result as a human-readable status line.
 */
export function formatBudgetStatus(result: BudgetEnforcementResult): string {
  if (!result.proceed) {
    return `[BUDGET_EXCEEDED] ${result.reason}`;
  }
  if (result.reason) {
    return `[BUDGET_WARNING] ${result.reason}`;
  }
  return `[BUDGET_OK] ${result.tokensUsed}/${result.budgetLimit} tokens (${result.tokensRemaining} remaining)`;
}
