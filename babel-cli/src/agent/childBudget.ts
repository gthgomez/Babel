/**
 * One bounded allowance contract shared by ChatEngine delegation and the
 * read-only/mutation child loops.
 *
 * The task-owner ledger is the accounting source. A parent supplies the
 * remaining cost/deadline; a child can only consume that
 * snapshot allowance and may further restrict itself by max rounds.
 */

import { randomUUID } from 'node:crypto';
import {
  captureCostBaselineUsd,
  globalCostTracker,
} from '../services/costTracker.js';

export type ChildBudgetLimiter = 'wall' | 'cost';

export interface InheritedChildAllowance {
  /** Immutable child owner for provider usage emitted by this delegation. */
  taskOwnerId?: string;
  /** Parent owner charged once for each child provider charge. */
  parentTaskOwnerId?: string;
  /** Reporting-only global cost at delegation; never a task budget source. */
  costBaselineUsd: number;
  /** Maximum additional owner-ledger cost available; null = unlimited. */
  remainingCostUsd: number | null;
  /** Absolute deadline inherited from the parent; null = no wall deadline. */
  deadlineAtMs: number | null;
  /** Child-local round cap, already clamped by the parent. */
  maxRounds: number;
}

export function deriveChildAllowance(input: {
  parentTaskOwnerId?: string;
  parentTaskBaselineUsd: number;
  parentTaskCarryoverUsd?: number;
  parentEffectiveCostCapUsd: number;
  parentDeadlineAtMs: number | null;
  childMaxRounds: number;
  childTimeoutMs?: number;
  nowMs?: number;
}): InheritedChildAllowance {
  const nowMs = input.nowMs ?? Date.now();
  const globalCost = captureCostBaselineUsd();
  const parentSpentUsd = input.parentTaskOwnerId
    ? globalCostTracker.getTaskSummary(input.parentTaskOwnerId).totalCostUSD
    : 0;
  const remainingCostUsd = Number.isFinite(input.parentEffectiveCostCapUsd)
    ? input.parentTaskOwnerId && globalCostTracker.getTaskSummary(input.parentTaskOwnerId).costComplete !== false
      ? Math.max(0, input.parentEffectiveCostCapUsd - parentSpentUsd)
      : 0
    : null;
  const childDeadline =
    input.childTimeoutMs !== undefined
      ? nowMs + Math.max(0, input.childTimeoutMs)
      : null;
  const deadlineAtMs =
    input.parentDeadlineAtMs === null
      ? childDeadline
      : childDeadline === null
        ? input.parentDeadlineAtMs
        : Math.min(input.parentDeadlineAtMs, childDeadline);

  return {
    ...(input.parentTaskOwnerId
      ? { taskOwnerId: randomUUID(), parentTaskOwnerId: input.parentTaskOwnerId }
      : {}),
    costBaselineUsd: globalCost,
    remainingCostUsd,
    deadlineAtMs,
    maxRounds: Math.max(1, Math.trunc(input.childMaxRounds)),
  };
}

export function inheritedChildBudgetLimiter(
  allowance: InheritedChildAllowance | undefined,
  nowMs = Date.now(),
): ChildBudgetLimiter | null {
  if (!allowance) return null;
  if (allowance.deadlineAtMs !== null && nowMs >= allowance.deadlineAtMs) {
    return 'wall';
  }
  if (
    allowance.remainingCostUsd !== null &&
    (!allowance.taskOwnerId ||
      globalCostTracker.getTaskSummary(allowance.taskOwnerId).costComplete === false ||
      globalCostTracker.getTaskSummary(allowance.taskOwnerId).totalCostUSD >= allowance.remainingCostUsd)
  ) {
    return 'cost';
  }
  return null;
}

/**
 * Link parent cancellation and the inherited absolute deadline to one signal
 * used by provider/tool activity. Cost is checked synchronously before and
 * after each child model boundary because usage becomes authoritative there.
 */
export function createChildBudgetController(
  allowance: InheritedChildAllowance | undefined,
  parentSignal?: AbortSignal,
): {
  signal: AbortSignal;
  limiter: () => ChildBudgetLimiter | null;
  dispose: () => void;
} {
  const controller = new AbortController();
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let expiredLimiter: ChildBudgetLimiter | null = null;

  const expireAtDeadline = (): void => {
    expiredLimiter = 'wall';
    controller.abort();
  };
  if (allowance?.deadlineAtMs !== null && allowance?.deadlineAtMs !== undefined) {
    const delayMs = Math.max(0, allowance.deadlineAtMs - Date.now());
    deadlineTimer = setTimeout(expireAtDeadline, delayMs);
    // A completed child must not keep the process alive until its parent
    // deadline. The controller is still cleared by dispose on normal exits.
    deadlineTimer.unref?.();
  }

  const onParentAbort = (): void => controller.abort();
  parentSignal?.addEventListener('abort', onParentAbort, { once: true });
  if (parentSignal?.aborted) controller.abort();

  return {
    signal: controller.signal,
    limiter: () => {
      if (expiredLimiter) return expiredLimiter;
      const current = inheritedChildBudgetLimiter(allowance);
      if (current) {
        expiredLimiter = current;
        controller.abort();
      }
      return expiredLimiter;
    },
    dispose: () => {
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      parentSignal?.removeEventListener('abort', onParentAbort);
    },
  };
}
