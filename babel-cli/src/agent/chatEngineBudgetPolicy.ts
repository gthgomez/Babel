import {
  buildPostWriteRepairMessage,
  computeCriticRepairCostCap,
  computePostWriteRepairWallMs,
  shouldEnterRepairBudget,
} from './chatEngineCriticBudget.js';
import { shouldShrinkWallForPostWriteRepair, type ChatEngineLimits } from '../config/chatEngineLimits.js';
import type { PolicyEvent } from './policyEventLog.js';

export interface PostWriteRepairUpdate {
  postWriteRepairWallCapMs: number | null;
  criticRepairCostCapUsd: number | null;
  costEvent: PolicyEvent | null;
  conversationMessage: string;
  wallEvent: PolicyEvent;
}

/** Compute the first-mutation repair window and its user-facing policy events. */
export function computePostWriteRepairBudget(input: {
  postWriteRepairWallCapMs: number | null;
  postWriteRepairRestrict: boolean;
  taskClass: string;
  hasMutation: boolean;
  currentVerifierFailed: boolean;
  criticRejected: boolean;
  intervention: Parameters<typeof shouldEnterRepairBudget>[0]['intervention'];
  elapsedMs: number;
  limits: ChatEngineLimits;
  criticRepairCostCapUsd: number | null;
  spentUsd: number;
  criticStrikes: number;
  turnIndex: number;
}): PostWriteRepairUpdate | null {
  if (input.postWriteRepairWallCapMs != null || input.postWriteRepairRestrict) return null;
  if (input.taskClass === 'investigate') return null;
  if (!shouldEnterRepairBudget({
    hasMutation: input.hasMutation,
    currentVerifierFailed: input.currentVerifierFailed,
    criticRejected: input.criticRejected,
    intervention: input.intervention,
  })) return null;

  const shrinkWall = shouldShrinkWallForPostWriteRepair(input.limits.wallBudget);
  const repairWall = shrinkWall
    ? computePostWriteRepairWallMs({ elapsedMs: input.elapsedMs, sessionMaxWallMs: input.limits.maxWallMs })
    : { capMs: input.limits.maxWallMs, repairWindowMs: Math.max(0, input.limits.maxWallMs - input.elapsedMs) };
  const { capMs, repairWindowMs } = repairWall;

  let criticRepairCostCapUsd: number | null = null;
  let costEvent: PolicyEvent | null = null;
  if (input.criticRepairCostCapUsd == null) {
    const { capUsd, repairWindowUsd } = computeCriticRepairCostCap({
      spentUsd: input.spentUsd,
      sessionMaxCostUsd: input.limits.maxCostUsd,
      longTaskProfile: input.limits.costBudget?.longTaskProfile === true,
      explicitCostCeiling: input.limits.costBudget?.explicitCostCeiling === true,
      criticStrikes: input.criticStrikes,
      limits: input.limits,
    });
    criticRepairCostCapUsd = capUsd;
    costEvent = {
      at_turn: input.turnIndex,
      kind: 'progress_policy',
      detail:
        `post_write_repair_cost spent=${input.spentUsd.toFixed(3)} ` +
        `repair_window=${repairWindowUsd.toFixed(3)} cap=${capUsd.toFixed(3)}`,
    };
  }

  const remainingWallSec = Math.max(0, Math.round((input.limits.maxWallMs - input.elapsedMs) / 1000));
  const conversationMessage = buildPostWriteRepairMessage({
    repairWindowSec: Math.round(repairWindowMs / 1000),
    remainingWallSec,
  });
  const wallEvent: PolicyEvent = {
    at_turn: input.turnIndex,
    kind: 'progress_policy',
    detail:
      `post_write_repair_wall elapsed_ms=${input.elapsedMs} ` +
      `repair_window_ms=${repairWindowMs} cap_ms=${capMs} ` +
      `session_max_ms=${input.limits.maxWallMs} tools=act_or_verify`,
  };

  return {
    postWriteRepairWallCapMs: Number.isFinite(capMs) ? capMs : null,
    criticRepairCostCapUsd,
    costEvent,
    conversationMessage,
    wallEvent,
  };
}

export interface CriticRepairCostUpdate {
  capUsd: number;
  event: PolicyEvent;
}

/** Compute the critic-repair cost cap and its accounting event. */
export function computeCriticRepairCostBudget(input: {
  spentUsd: number;
  limits: ChatEngineLimits;
  criticStrikes: number;
  turnIndex: number;
}): CriticRepairCostUpdate {
  const { capUsd, repairWindowUsd } = computeCriticRepairCostCap({
    spentUsd: input.spentUsd,
    sessionMaxCostUsd: input.limits.maxCostUsd,
    longTaskProfile: input.limits.costBudget?.longTaskProfile === true,
    explicitCostCeiling: input.limits.costBudget?.explicitCostCeiling === true,
    criticStrikes: input.criticStrikes,
    limits: input.limits,
  });
  return {
    capUsd,
    event: {
      at_turn: input.turnIndex,
      kind: 'progress_policy',
      detail:
        `critic_repair_budget spent=${input.spentUsd.toFixed(3)} ` +
        `repair_window=${repairWindowUsd.toFixed(3)} cap=${capUsd.toFixed(3)} ` +
        `session_max=${input.limits.maxCostUsd.toFixed(2)}`,
    },
  };
}
