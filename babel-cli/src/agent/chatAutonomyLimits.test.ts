/**
 * Canary D — Autonomy Limits & Timeline Verification (F5, Probe P08).
 *
 * Covers:
 * - Declared vs effective allowances for 30m, 1h, 2h, 4h profiles.
 * - Standard clamping (max 60m) vs long-task profile expansion (up to 240m / 4h).
 * - Cost cap preservation: $2 default vs $10 explicit ceiling.
 * - Post-write repair budget protection: ensuring long-task / explicit ceiling runs
 *   do not shrink cost to 75c window unless thrash / repeated critic rejects occur.
 * - Earliest limiter selection (wall, cost, turns, stall, wall_repair, cost_repair).
 * - Terminal classification truth: ensuring repair budget terminations are never
 *   misclassified as model_failure.
 * - ChatEngineRunAllowanceReport generation and accuracy.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  classifyTerminalLimiter,
  createRunAllowanceReport,
  DEFAULT_CHILD_LIMITS,
  evaluateTimelineLimiter,
  resolveChatEngineLimits,
  shouldShrinkCostForPostWriteRepair,
  shouldShrinkWallForPostWriteRepair,
  type ChatEngineLimits,
} from '../config/chatEngineLimits.js';
import {
  checkCostWallBudgets,
  computeCriticRepairCostCap,
} from './chatEngineCriticBudget.js';

describe('Canary D: Autonomy Limits Timeline Profiles (30m, 1h, 2h, 4h)', () => {
  it('resolves 30m profile correctly: 30m declared, 30m effective', () => {
    const limits = resolveChatEngineLimits({
      maxWallMs: 30 * 60 * 1000,
    });
    assert.equal(limits.maxWallMs, 30 * 60 * 1000);
    assert.equal(limits.wallBudget?.requestedMs, 30 * 60 * 1000);
    assert.equal(limits.wallBudget?.effectiveMs, 30 * 60 * 1000);
    assert.equal(limits.wallBudget?.longTaskProfile, false);

    const report = createRunAllowanceReport(limits);
    assert.equal(report.declaredWallMs, 30 * 60 * 1000);
    assert.equal(report.effectiveWallMs, 30 * 60 * 1000);
  });

  it('resolves 1h profile correctly: 60m declared, 60m effective', () => {
    const limits = resolveChatEngineLimits({
      maxWallMs: 60 * 60 * 1000,
    });
    assert.equal(limits.maxWallMs, 60 * 60 * 1000);
    assert.equal(limits.wallBudget?.requestedMs, 60 * 60 * 1000);
    assert.equal(limits.wallBudget?.effectiveMs, 60 * 60 * 1000);

    const report = createRunAllowanceReport(limits);
    assert.equal(report.declaredWallMs, 60 * 60 * 1000);
    assert.equal(report.effectiveWallMs, 60 * 60 * 1000);
  });

  it('clamps 2h request to 1h without longTaskProfile', () => {
    const limits = resolveChatEngineLimits({
      maxWallMs: 120 * 60 * 1000,
    });
    // Declared was 120m, but clamped to 60m by default cap
    assert.equal(limits.wallBudget?.requestedMs, 120 * 60 * 1000);
    assert.equal(limits.wallBudget?.effectiveMs, 60 * 60 * 1000);
    assert.equal(limits.maxWallMs, 60 * 60 * 1000);

    const report = createRunAllowanceReport(limits);
    assert.equal(report.declaredWallMs, 120 * 60 * 1000);
    assert.equal(report.effectiveWallMs, 60 * 60 * 1000);
  });

  it('allows 2h request with explicit longTaskProfile', () => {
    const limits = resolveChatEngineLimits({
      maxWallMs: 120 * 60 * 1000,
      wallBudget: {
        longTaskProfile: true,
        requestedMs: 120 * 60 * 1000,
        effectiveMs: 120 * 60 * 1000,
        ceilingMs: 4 * 60 * 60 * 1000,
      },
    });
    assert.equal(limits.wallBudget?.requestedMs, 120 * 60 * 1000);
    assert.equal(limits.wallBudget?.effectiveMs, 120 * 60 * 1000);
    assert.equal(limits.maxWallMs, 120 * 60 * 1000);

    const report = createRunAllowanceReport(limits);
    assert.equal(report.declaredWallMs, 120 * 60 * 1000);
    assert.equal(report.effectiveWallMs, 120 * 60 * 1000);
  });

  it('allows 4h (240m) request with longTaskProfile', () => {
    const limits = resolveChatEngineLimits({
      maxWallMs: 240 * 60 * 1000,
      wallBudget: {
        longTaskProfile: true,
        requestedMs: 240 * 60 * 1000,
        effectiveMs: 240 * 60 * 1000,
        ceilingMs: 4 * 60 * 60 * 1000,
      },
    });
    assert.equal(limits.wallBudget?.requestedMs, 240 * 60 * 1000);
    assert.equal(limits.wallBudget?.effectiveMs, 240 * 60 * 1000);
    assert.equal(limits.maxWallMs, 240 * 60 * 1000);

    const report = createRunAllowanceReport(limits);
    assert.equal(report.declaredWallMs, 240 * 60 * 1000);
    assert.equal(report.effectiveWallMs, 240 * 60 * 1000);
  });
});

describe('Canary D: Cost Cap Allowance and Post-Write Repair Shrink (Probe P08)', () => {
  it('distinguishes default cost cap vs explicit $10 cost ceiling', () => {
    const defaultLimits = resolveChatEngineLimits();
    assert.equal(defaultLimits.maxCostUsd, 2.0); // default is 2.0

    const sweLimits = resolveChatEngineLimits({}, undefined, { taskClass: 'general_swe' });
    assert.equal(sweLimits.maxCostUsd, 3.0); // general_swe is 3.0

    const explicitLimits = resolveChatEngineLimits({
      maxCostUsd: 10.0,
      costBudget: {
        explicitCostCeiling: true,
        requestedCostUsd: 10.0,
        effectiveCostUsd: 10.0,
        ceilingCostUsd: 100.0,
        longTaskProfile: false,
      },
    });
    assert.equal(explicitLimits.maxCostUsd, 10.0);
    assert.equal(explicitLimits.costBudget?.explicitCostCeiling, true);

    const report = createRunAllowanceReport(explicitLimits);
    assert.equal(report.declaredCostUsd, 10.0);
    assert.equal(report.effectiveCostCapUsd, 10.0);
  });

  it('standard task shrinks post-write repair budget to 75c window', () => {
    const limits = resolveChatEngineLimits();
    assert.equal(shouldShrinkCostForPostWriteRepair(limits), true);

    const cap = computeCriticRepairCostCap({
      spentUsd: 1.0,
      sessionMaxCostUsd: 2.0,
      criticStrikes: 0,
      limits,
    });
    // 1.0 spent + 0.35 (35% of remaining $1.00) = 1.35 (capped under max $0.75 window)
    assert.equal(cap.capUsd, 1.35);
    assert.equal(cap.repairWindowUsd, 0.35);
  });

  it('longTaskProfile / explicitCostCeiling ($10) does NOT shrink cost to 75c window on first attempt', () => {
    const limits = resolveChatEngineLimits({
      maxCostUsd: 10.0,
      costBudget: {
        explicitCostCeiling: true,
        requestedCostUsd: 10.0,
        effectiveCostUsd: 10.0,
        ceilingCostUsd: 100.0,
        longTaskProfile: false,
      },
    });
    assert.equal(shouldShrinkCostForPostWriteRepair(limits), false);

    const cap = computeCriticRepairCostCap({
      spentUsd: 1.0,
      sessionMaxCostUsd: 10.0,
      criticStrikes: 0,
      limits,
    });
    // Preserves the full $10 budget!
    assert.equal(cap.capUsd, 10.0);
    assert.equal(cap.repairWindowUsd, 9.0);
  });

  it('longTaskProfile / explicitCostCeiling ($10) DOES shrink if thrashing / repeated critic rejects (strikes >= 2)', () => {
    const limits = resolveChatEngineLimits({
      maxCostUsd: 10.0,
      costBudget: {
        explicitCostCeiling: true,
        requestedCostUsd: 10.0,
        effectiveCostUsd: 10.0,
        ceilingCostUsd: 100.0,
        longTaskProfile: false,
      },
    });

    const capStrike2 = computeCriticRepairCostCap({
      spentUsd: 2.0,
      sessionMaxCostUsd: 10.0,
      criticStrikes: 2,
      limits,
    });
    // Thrashing detected: clamped to spent (2.0) + window (0.75) = 2.75
    assert.equal(capStrike2.capUsd, 2.75);
    assert.equal(capStrike2.repairWindowUsd, 0.75);
  });

  it('evaluates shouldShrinkWallForPostWriteRepair correctly', () => {
    assert.equal(shouldShrinkWallForPostWriteRepair({ longTaskProfile: false, requestedMs: 1000, effectiveMs: 1000, ceilingMs: 3600000 }), true);
    assert.equal(shouldShrinkWallForPostWriteRepair({ longTaskProfile: true, requestedMs: 1000, effectiveMs: 1000, ceilingMs: 14400000 }), false);
  });
});

describe('Canary D: Earliest Limiter Selection & Terminal Classification Truth', () => {
  const baseLimits: ChatEngineLimits = {
    maxTurns: 20,
    maxConversationMessages: 20,
    maxEstimatedTokens: 128000,
    maxWallMs: 60 * 1000, // 60s
    maxCostUsd: 5.0,
    stallTurns: 4,
    investigateModel: undefined,
    mutateModel: undefined,
    maxTokensPerRound: 200000,
  };

  it('selects cost limiter when cost cap reached first', () => {
    const result = evaluateTimelineLimiter({
      limits: baseLimits,
      elapsedMs: 10 * 1000,
      spentUsd: 5.01,
      turns: 5,
      consecutiveStallTurns: 0,
    });
    assert.equal(result.limiter, 'cost');
    assert.equal(result.classification, 'limit_cost');
    assert.ok(result.reason?.includes('Cost budget exceeded'));
  });

  it('selects cost_repair limiter when repair cost cap reached (never misclassified as model_failure)', () => {
    const result = evaluateTimelineLimiter({
      limits: baseLimits,
      elapsedMs: 10 * 1000,
      spentUsd: 2.10,
      turns: 5,
      consecutiveStallTurns: 0,
      criticRepairCostCapUsd: 2.0, // undisclosed repair cap
    });
    assert.equal(result.limiter, 'cost_repair');
    assert.equal(result.classification, 'limit_cost_repair');
    assert.notEqual(result.classification, 'model_failure');
    assert.ok(result.reason?.includes('[cost_repair]'));
  });

  it('selects wall limiter when wall time elapsed first', () => {
    const result = evaluateTimelineLimiter({
      limits: baseLimits,
      elapsedMs: 65 * 1000,
      spentUsd: 1.0,
      turns: 5,
      consecutiveStallTurns: 0,
    });
    assert.equal(result.limiter, 'wall');
    assert.equal(result.classification, 'limit_wall');
  });

  it('selects wall_repair limiter when post-write wall repair cap elapsed', () => {
    const result = evaluateTimelineLimiter({
      limits: baseLimits,
      elapsedMs: 35 * 1000,
      spentUsd: 1.0,
      turns: 5,
      consecutiveStallTurns: 0,
      postWriteRepairWallCapMs: 30 * 1000, // repair wall cap
    });
    assert.equal(result.limiter, 'wall_repair');
    assert.equal(result.classification, 'limit_wall_repair');
    assert.notEqual(result.classification, 'model_failure');
  });

  it('selects turns limiter when maxTurns reached', () => {
    const result = evaluateTimelineLimiter({
      limits: baseLimits,
      elapsedMs: 10 * 1000,
      spentUsd: 1.0,
      turns: 20,
      consecutiveStallTurns: 0,
    });
    assert.equal(result.limiter, 'turns');
    assert.equal(result.classification, 'limit_turns');
  });

  it('selects stall limiter when stallTurns reached', () => {
    const result = evaluateTimelineLimiter({
      limits: baseLimits,
      elapsedMs: 10 * 1000,
      spentUsd: 1.0,
      turns: 10,
      consecutiveStallTurns: 4,
    });
    assert.equal(result.limiter, 'stall');
    assert.equal(result.classification, 'limit_stall');
  });

  it('returns none and success when under all limits', () => {
    const result = evaluateTimelineLimiter({
      limits: baseLimits,
      elapsedMs: 10 * 1000,
      spentUsd: 1.0,
      turns: 5,
      consecutiveStallTurns: 0,
    });
    assert.equal(result.limiter, 'none');
    assert.equal(result.classification, 'success');
  });

  it('classifyTerminalLimiter correctly classifies all limiters without calling repair budgets model_failure', () => {
    assert.equal(classifyTerminalLimiter('wall'), 'limit_wall');
    assert.equal(classifyTerminalLimiter('wall_repair'), 'limit_wall_repair');
    assert.equal(classifyTerminalLimiter('cost'), 'limit_cost');
    assert.equal(classifyTerminalLimiter('cost_repair'), 'limit_cost_repair');
    assert.equal(classifyTerminalLimiter('turns'), 'limit_turns');
    assert.equal(classifyTerminalLimiter('stall'), 'limit_stall');
    assert.equal(classifyTerminalLimiter('critic_reject'), 'policy_block');
    assert.equal(classifyTerminalLimiter('none'), 'success');
    assert.equal(classifyTerminalLimiter('none', 'User cancelled'), 'cancelled');
  });

  it('checkCostWallBudgets accurately identifies cost_repair vs cost and wall_repair vs wall', () => {
    const normal = checkCostWallBudgets({
      totalCostUsd: 3.5,
      maxCostUsd: 3.0,
      sessionStartTime: 0,
      maxWallMs: 60000,
    });
    assert.equal(normal.ok, false);
    assert.equal(normal.limiter, 'cost');

    const repairCost = checkCostWallBudgets({
      totalCostUsd: 1.8,
      maxCostUsd: 1.5,
      declaredCostUsd: 3.0,
      criticRepairCostCapUsd: 1.5,
      sessionStartTime: 0,
      maxWallMs: 60000,
    });
    assert.equal(repairCost.ok, false);
    assert.equal(repairCost.limiter, 'cost_repair');

    const repairWall = checkCostWallBudgets({
      totalCostUsd: 0.5,
      maxCostUsd: 3.0,
      sessionStartTime: Date.now() - 25000,
      maxWallMs: 20000,
      declaredWallMs: 60000,
      postWriteRepairWallCapMs: 20000,
    });
    assert.equal(repairWall.ok, false);
    assert.equal(repairWall.limiter, 'wall_repair');
  });

  it('generates full ChatEngineRunAllowanceReport', () => {
    const limits = resolveChatEngineLimits({
      maxWallMs: 120 * 60 * 1000,
      wallBudget: {
        longTaskProfile: true,
        requestedMs: 120 * 60 * 1000,
        effectiveMs: 120 * 60 * 1000,
        ceilingMs: 4 * 60 * 60 * 1000,
      },
      maxCostUsd: 10.0,
      costBudget: {
        explicitCostCeiling: true,
        requestedCostUsd: 10.0,
        effectiveCostUsd: 10.0,
        ceilingCostUsd: 100.0,
        longTaskProfile: false,
      },
      maxTurns: 30,
      stallTurns: 5,
    });

    const report = createRunAllowanceReport(limits, {
      postWriteRepairWallCapMs: 90 * 60 * 1000,
      criticRepairCostCapUsd: 8.5,
      terminatingLimiter: 'cost_repair',
      terminalClassification: 'limit_cost_repair',
      terminalReason: 'Critic repair cost cap exceeded',
      childLimits: DEFAULT_CHILD_LIMITS,
    });

    assert.equal(report.declaredWallMs, 120 * 60 * 1000);
    assert.equal(report.effectiveWallMs, 90 * 60 * 1000); // capped by repair window
    assert.equal(report.declaredCostUsd, 10.0);
    assert.equal(report.effectiveCostCapUsd, 8.5); // capped by repair window
    assert.equal(report.turnCap, 30);
    assert.equal(report.stallLimit, 5);
    assert.equal(report.childLimits.maxRounds, 8);
    assert.equal(report.terminatingLimiter, 'cost_repair');
    assert.equal(report.terminalClassification, 'limit_cost_repair');
    assert.equal(report.terminalReason, 'Critic repair cost cap exceeded');
  });
});
