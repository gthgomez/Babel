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
  localTimeoutMs?: number,
): {
  signal: AbortSignal;
  limiter: () => ChildBudgetLimiter | null;
  timedOut: () => boolean;
  dispose: () => void;
} {
  const controller = new AbortController();
  type StopCause = 'parent' | 'local' | ChildBudgetLimiter;
  let stopCause: StopCause | null = null;
  const localDeadline = localTimeoutMs === undefined ? null : Date.now() + Math.max(0, localTimeoutMs);
  const inheritedDeadline = allowance?.deadlineAtMs ?? null;
  const firstDeadline = inheritedDeadline === null
    ? localDeadline
    : localDeadline === null ? inheritedDeadline : Math.min(inheritedDeadline, localDeadline);
  const deadlineCause: StopCause = inheritedDeadline !== null && firstDeadline === inheritedDeadline ? 'wall' : 'local';
  const stop = (cause: StopCause): void => {
    if (stopCause !== null) return;
    stopCause = cause;
    controller.abort();
  };
  const checkStop = (): void => {
    if (stopCause !== null) return;
    if (parentSignal?.aborted) { stop('parent'); return; }
    if (firstDeadline !== null && Date.now() >= firstDeadline) { stop(deadlineCause); return; }
    const inherited = inheritedChildBudgetLimiter(allowance);
    if (inherited) stop(inherited);
  };
  const onParentAbort = (): void => stop('parent');
  parentSignal?.addEventListener('abort', onParentAbort, { once: true });
  checkStop();
  const deadlineTimer = firstDeadline === null || stopCause !== null
    ? undefined
    : setTimeout(() => stop(deadlineCause), Math.max(0, firstDeadline - Date.now()));
  // An explicit local timeout bounds even a never-settling standalone child.
  if (localTimeoutMs === undefined) deadlineTimer?.unref?.();

  return {
    signal: controller.signal,
    timedOut: () => { checkStop(); return stopCause === 'local'; },
    limiter: () => {
      checkStop();
      return stopCause === 'wall' || stopCause === 'cost' ? stopCause : null;
    },
    dispose: () => {
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      parentSignal?.removeEventListener('abort', onParentAbort);
    },
  };
}
