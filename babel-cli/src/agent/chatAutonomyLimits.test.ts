/**
 * F5 — effective autonomy limits / budget truth.
 *
 * Exercises declared vs effective allowances, limiter classification, JSON
 * persistence, and the real ChatEngine.checkBudgets / repair-budget path.
 * Long-task matrix uses injected elapsed/spent — no multi-hour sleeps.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

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
import { ChatEngine, type ChatResult } from './chatEngine.js';
import { globalCostTracker } from '../services/costTracker.js';

const envKeys = [
  'BABEL_CHAT_LONG_TASK',
  'BABEL_CHAT_MAX_COST',
  'BABEL_CHAT_MAX_WALL_MS',
  'BABEL_CHAT_TASK_CLASS',
  'BABEL_CHAT_SWE_PROFILE',
] as const;

const previousEnv: Record<string, string | undefined> = {};
for (const key of envKeys) previousEnv[key] = process.env[key];

function restoreEnv(): void {
  for (const key of envKeys) {
    const value = previousEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  globalCostTracker.resetSession();
}

afterEach(() => {
  restoreEnv();
});

type BudgetHarness = {
  checkBudgets: () => { ok: boolean; reason?: string; limiter?: string };
  applyPostWriteRepairBudget: () => void;
  applyCriticRepairCostBudget: () => void;
  buildResult: (
    status: ChatResult['status'],
    callbacks: object,
    answer?: string,
  ) => ChatResult;
  limits: ChatEngineLimits;
  criticRepairCostCapUsd: number | null;
  postWriteRepairWallCapMs: number | null;
  criticStrikes: number;
  _sessionStartTime: number;
  taskClass: string;
};

function harness(engine: ChatEngine): BudgetHarness {
  return engine as unknown as BudgetHarness;
}

function makeEngine(overrides?: {
  maxWallMs?: number;
  maxCostUsd?: number;
  maxTurns?: number;
}): ChatEngine {
  const root = mkdtempSync(join(tmpdir(), 'babel-f5-limits-'));
  return new ChatEngine({
    task: 'fix a small bug',
    projectRoot: root,
    ...(overrides?.maxWallMs !== undefined ? { maxWallMs: overrides.maxWallMs } : {}),
    ...(overrides?.maxCostUsd !== undefined ? { maxCostUsd: overrides.maxCostUsd } : {}),
    ...(overrides?.maxTurns !== undefined ? { maxTurns: overrides.maxTurns } : {}),
  });
}

describe('Canary D: Autonomy Limits Timeline Profiles (30m, 1h, 2h, 4h)', () => {
  it('resolves 30m profile correctly: 30m declared, 30m effective', () => {
    const limits = resolveChatEngineLimits({ maxWallMs: 30 * 60 * 1000 });
    assert.equal(limits.maxWallMs, 30 * 60 * 1000);
    assert.equal(limits.wallBudget?.requestedMs, 30 * 60 * 1000);
    assert.equal(limits.wallBudget?.effectiveMs, 30 * 60 * 1000);
    assert.equal(limits.wallBudget?.longTaskProfile, false);
    const report = createRunAllowanceReport(limits);
    assert.equal(report.declaredWallMs, 30 * 60 * 1000);
    assert.equal(report.effectiveWallMs, 30 * 60 * 1000);
  });

  it('resolves 1h profile correctly: 60m declared, 60m effective', () => {
    const limits = resolveChatEngineLimits({ maxWallMs: 60 * 60 * 1000 });
    assert.equal(limits.maxWallMs, 60 * 60 * 1000);
    const report = createRunAllowanceReport(limits);
    assert.equal(report.declaredWallMs, 60 * 60 * 1000);
    assert.equal(report.effectiveWallMs, 60 * 60 * 1000);
  });

  it('clamps 2h request to 1h without longTaskProfile', () => {
    const limits = resolveChatEngineLimits({ maxWallMs: 120 * 60 * 1000 });
    assert.equal(limits.wallBudget?.requestedMs, 120 * 60 * 1000);
    assert.equal(limits.wallBudget?.effectiveMs, 60 * 60 * 1000);
    assert.equal(limits.maxWallMs, 60 * 60 * 1000);
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
    assert.equal(limits.maxWallMs, 120 * 60 * 1000);
    assert.equal(limits.wallBudget?.longTaskProfile, true);
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
    assert.equal(limits.maxWallMs, 240 * 60 * 1000);
    const report = createRunAllowanceReport(limits);
    assert.equal(report.declaredWallMs, 240 * 60 * 1000);
    assert.equal(report.effectiveWallMs, 240 * 60 * 1000);
  });
});

describe('Canary D: Cost cap, JSON persistence, repair shrink flags', () => {
  it('costBudget and runAllowance survive JSON serialization and spreads', () => {
    const limits = resolveChatEngineLimits({ maxCostUsd: 10.0, maxWallMs: 30 * 60 * 1000 });
    const json = JSON.parse(JSON.stringify(limits)) as ChatEngineLimits;
    assert.ok(json.costBudget, 'costBudget must be enumerable');
    assert.ok(json.runAllowance, 'runAllowance must be enumerable');
    assert.equal(json.costBudget?.requestedCostUsd, 10.0);
    assert.equal(json.costBudget?.explicitCostCeiling, true);
    assert.equal(json.runAllowance?.declaredCostUsd, 10.0);
    const spread = { ...limits };
    assert.ok(spread.costBudget);
    assert.ok(spread.runAllowance);
    const keys = Object.keys(JSON.parse(JSON.stringify(limits)));
    assert.ok(keys.includes('costBudget'), `serialized keys: ${keys.join(',')}`);
    assert.ok(keys.includes('runAllowance'), `serialized keys: ${keys.join(',')}`);
  });

  it('standard task shrinks post-write repair budget to the 75c window', () => {
    delete process.env['BABEL_CHAT_MAX_COST'];
    const limits = resolveChatEngineLimits();
    assert.equal(shouldShrinkCostForPostWriteRepair(limits), true);
    const cap = computeCriticRepairCostCap({
      spentUsd: 1.0,
      sessionMaxCostUsd: 2.0,
      criticStrikes: 0,
      limits,
    });
    assert.equal(cap.capUsd, 1.35);
    assert.equal(cap.repairWindowUsd, 0.35);
  });

  it('$10 without flags still shrinks ($1 spent → $1.75) — amount alone is not a skip', () => {
    const cap = computeCriticRepairCostCap({
      spentUsd: 1.0,
      sessionMaxCostUsd: 10.0,
    });
    assert.equal(cap.capUsd, 1.75);
    assert.equal(cap.repairWindowUsd, 0.75);
  });

  it('explicit $10 ceiling does not shrink unless criticStrikes >= 2', () => {
    const limits = resolveChatEngineLimits({ maxCostUsd: 10.0 });
    assert.equal(shouldShrinkCostForPostWriteRepair(limits), false);
    const first = computeCriticRepairCostCap({
      spentUsd: 1.0,
      sessionMaxCostUsd: 10.0,
      criticStrikes: 0,
      explicitCostCeiling: true,
      limits,
    });
    assert.equal(first.capUsd, 10.0);
    const thrash = computeCriticRepairCostCap({
      spentUsd: 2.0,
      sessionMaxCostUsd: 10.0,
      criticStrikes: 2,
      explicitCostCeiling: true,
      limits,
    });
    assert.equal(thrash.capUsd, 2.75);
  });

  it('long-task wall profile does not by itself disable cost-repair shrink', () => {
    assert.equal(
      shouldShrinkCostForPostWriteRepair({
        maxCostUsd: 2,
        wallBudget: {
          longTaskProfile: true,
          requestedMs: 7_200_000,
          effectiveMs: 7_200_000,
          ceilingMs: 14_400_000,
        },
      }),
      true,
    );
    assert.equal(shouldShrinkWallForPostWriteRepair({
      longTaskProfile: true,
      requestedMs: 7_200_000,
      effectiveMs: 7_200_000,
      ceilingMs: 14_400_000,
    }), false);
  });
});

describe('Canary D: Earliest limiter selection (never SUCCESS when none fired)', () => {
  const baseLimits: ChatEngineLimits = {
    maxTurns: 20,
    maxConversationMessages: 20,
    maxEstimatedTokens: 128000,
    maxWallMs: 60 * 1000,
    maxCostUsd: 5.0,
    stallTurns: 4,
    investigateModel: undefined,
    mutateModel: undefined,
    maxTokensPerRound: 200000,
  };

  it('selects cost / cost_repair / wall / wall_repair / turns / stall', () => {
    assert.equal(
      evaluateTimelineLimiter({
        limits: baseLimits,
        elapsedMs: 10_000,
        spentUsd: 5.01,
        turns: 5,
        consecutiveStallTurns: 0,
      }).limiter,
      'cost',
    );
    const repair = evaluateTimelineLimiter({
      limits: baseLimits,
      elapsedMs: 10_000,
      spentUsd: 2.10,
      turns: 5,
      consecutiveStallTurns: 0,
      criticRepairCostCapUsd: 2.0,
    });
    assert.equal(repair.limiter, 'cost_repair');
    assert.equal(repair.classification, 'limit_cost_repair');
    assert.notEqual(repair.classification, 'model_failure');
    assert.equal(
      evaluateTimelineLimiter({
        limits: baseLimits,
        elapsedMs: 65_000,
        spentUsd: 1.0,
        turns: 5,
        consecutiveStallTurns: 0,
      }).limiter,
      'wall',
    );
    assert.equal(
      evaluateTimelineLimiter({
        limits: baseLimits,
        elapsedMs: 35_000,
        spentUsd: 1.0,
        turns: 5,
        consecutiveStallTurns: 0,
        postWriteRepairWallCapMs: 30_000,
      }).limiter,
      'wall_repair',
    );
    assert.equal(
      evaluateTimelineLimiter({
        limits: baseLimits,
        elapsedMs: 10_000,
        spentUsd: 1.0,
        turns: 20,
        consecutiveStallTurns: 0,
      }).limiter,
      'turns',
    );
    assert.equal(
      evaluateTimelineLimiter({
        limits: baseLimits,
        elapsedMs: 10_000,
        spentUsd: 1.0,
        turns: 10,
        consecutiveStallTurns: 4,
      }).limiter,
      'stall',
    );
  });

  it('under all limits is no_limit_triggered, not success', () => {
    const result = evaluateTimelineLimiter({
      limits: baseLimits,
      elapsedMs: 10_000,
      spentUsd: 1.0,
      turns: 5,
      consecutiveStallTurns: 0,
    });
    assert.equal(result.limiter, 'none');
    assert.equal(result.classification, 'no_limit_triggered');
    assert.notEqual(result.classification, 'success');
  });

  it('child_exhaustion is a child limit, not model_failure', () => {
    assert.equal(classifyTerminalLimiter('child_exhaustion'), 'limit_child');
    assert.notEqual(classifyTerminalLimiter('child_exhaustion'), 'model_failure');
    assert.equal(classifyTerminalLimiter('none'), 'no_limit_triggered');
    assert.equal(classifyTerminalLimiter('none', 'User cancelled'), 'cancelled');
    assert.equal(classifyTerminalLimiter('cost_repair'), 'limit_cost_repair');
  });

  it('checkCostWallBudgets distinguishes declared vs repair limiters', () => {
    const normal = checkCostWallBudgets({
      totalCostUsd: 3.5,
      maxCostUsd: 3.0,
      sessionStartTime: 0,
      maxWallMs: 60_000,
    });
    assert.equal(normal.ok, false);
    assert.equal(normal.limiter, 'cost');

    const repairCost = checkCostWallBudgets({
      totalCostUsd: 1.8,
      maxCostUsd: 1.5,
      declaredCostUsd: 3.0,
      criticRepairCostCapUsd: 1.5,
      sessionStartTime: 0,
      maxWallMs: 60_000,
    });
    assert.equal(repairCost.limiter, 'cost_repair');

    const now = 1_000_000;
    const repairWall = checkCostWallBudgets({
      totalCostUsd: 0.5,
      maxCostUsd: 3.0,
      sessionStartTime: now - 25_000,
      nowMs: now,
      maxWallMs: 20_000,
      declaredWallMs: 60_000,
      postWriteRepairWallCapMs: 20_000,
    });
    assert.equal(repairWall.limiter, 'wall_repair');
  });
});

describe('PRODUCTION PATH: ChatEngine.checkBudgets / repair budgets', () => {
  it('checkBudgets reports cost_repair vs declared cost using real engine state', () => {
    const engine = makeEngine({ maxCostUsd: 3.0, maxWallMs: 60_000 });
    const h = harness(engine);
    globalCostTracker.resetSession();
    globalCostTracker.restoreSessionCost({
      totalCostUSD: 1.8,
      totalInputTokens: 100,
      totalOutputTokens: 50,
      totalTokens: 150,
    });
    h.criticRepairCostCapUsd = 1.5;
    h._sessionStartTime = Date.now();
    const budget = h.checkBudgets();
    assert.equal(budget.ok, false);
    assert.equal(budget.limiter, 'cost_repair');
    assert.match(budget.reason ?? '', /\[cost_repair\]/);
  });

  it('checkBudgets reports wall_repair vs declared wall using injected elapsed time', () => {
    const engine = makeEngine({ maxCostUsd: 10.0, maxWallMs: 60_000 });
    const h = harness(engine);
    globalCostTracker.resetSession();
    h.postWriteRepairWallCapMs = 20_000;
    h._sessionStartTime = Date.now() - 25_000;
    const budget = h.checkBudgets();
    assert.equal(budget.ok, false);
    assert.equal(budget.limiter, 'wall_repair');
    assert.match(budget.reason ?? '', /\[wall_repair\]/);
  });

  it('applyPostWriteRepairBudget passes explicit-ceiling flags so $10/$1 does not shrink', () => {
    const engine = makeEngine({ maxCostUsd: 10.0, maxWallMs: 600_000 });
    const h = harness(engine);
    globalCostTracker.resetSession();
    globalCostTracker.restoreSessionCost({
      totalCostUSD: 1.0,
      totalInputTokens: 10,
      totalOutputTokens: 10,
      totalTokens: 20,
    });
    h._sessionStartTime = Date.now() - 1_000;
    h.criticStrikes = 0;
    assert.equal(h.limits.costBudget?.explicitCostCeiling, true);
    h.applyPostWriteRepairBudget();
    assert.equal(h.criticRepairCostCapUsd, 10.0);
  });

  it('applyCriticRepairCostBudget still shrinks default $2 cap after first reject', () => {
    delete process.env['BABEL_CHAT_MAX_COST'];
    const engine = makeEngine({ maxWallMs: 600_000 });
    const h = harness(engine);
    globalCostTracker.resetSession();
    globalCostTracker.restoreSessionCost({
      totalCostUSD: 1.0,
      totalInputTokens: 10,
      totalOutputTokens: 10,
      totalTokens: 20,
    });
    h.criticStrikes = 1;
    // Default engine may have task-class cost; force a non-explicit $2 cap.
    h.limits.maxCostUsd = 2.0;
    if (h.limits.costBudget) {
      h.limits.costBudget.explicitCostCeiling = false;
      h.limits.costBudget.requestedCostUsd = 2.0;
      h.limits.costBudget.effectiveCostUsd = 2.0;
      h.limits.costBudget.longTaskProfile = false;
    }
    h.applyCriticRepairCostBudget();
    assert.equal(h.criticRepairCostCapUsd, 1.35);
  });

  it('buildResult JSON contains costBudget and runAllowance keys', () => {
    const engine = makeEngine({ maxCostUsd: 4.0, maxWallMs: 30_000 });
    const h = harness(engine);
    const result = h.buildResult('completed', {}, 'done');
    const json = JSON.parse(JSON.stringify(result)) as ChatResult;
    const keys = Object.keys(json);
    assert.ok(keys.includes('costBudget'), `serialized keys: ${keys.join(',')}`);
    assert.ok(keys.includes('runAllowance'), `serialized keys: ${keys.join(',')}`);
    assert.equal(json.costBudget?.requestedCostUsd, 4.0);
    assert.equal(json.runAllowance?.declaredCostUsd, 4.0);
    assert.equal(json.runAllowance?.childLimits.maxRounds, 4);
    assert.notEqual(json.runAllowance?.terminalClassification, 'success');
    const allowancePath = join(result.runDir ?? '', 'run-allowance.json');
    assert.equal(existsSync(allowancePath), true);
    const disk = JSON.parse(readFileSync(allowancePath, 'utf8')) as { declaredCostUsd: number };
    assert.equal(disk.declaredCostUsd, 4.0);
  });

  it('long-task wall skip does not skip cost-repair on ChatEngine without explicit cost ceiling', () => {
    process.env['BABEL_CHAT_LONG_TASK'] = '1';
    const engine = makeEngine({ maxWallMs: 7_200_000 });
    const h = harness(engine);
    globalCostTracker.resetSession();
    globalCostTracker.restoreSessionCost({
      totalCostUSD: 1.0,
      totalInputTokens: 10,
      totalOutputTokens: 10,
      totalTokens: 20,
    });
    h._sessionStartTime = Date.now() - 1_000;
    h.criticStrikes = 0;
    // Wall long-task is on; cost ceiling is not explicit unless maxCostUsd was passed.
    h.applyPostWriteRepairBudget();
    // Wall should not shrink (cap stays at session wall).
    assert.equal(h.postWriteRepairWallCapMs, h.limits.maxWallMs);
    assert.equal(h.limits.costBudget?.longTaskProfile, false);
    assert.ok(
      h.criticRepairCostCapUsd != null && h.criticRepairCostCapUsd <= 1.0 + 0.75 + 1e-9,
      `long-task wall must not disable cost-repair; cap=${h.criticRepairCostCapUsd}`,
    );
  });
});

describe('ChatEngineRunAllowanceReport completeness', () => {
  it('includes declared/effective/repair/child fields', () => {
    const limits = resolveChatEngineLimits({
      maxWallMs: 120 * 60 * 1000,
      wallBudget: {
        longTaskProfile: true,
        requestedMs: 120 * 60 * 1000,
        effectiveMs: 120 * 60 * 1000,
        ceilingMs: 4 * 60 * 60 * 1000,
      },
      maxCostUsd: 10.0,
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
    assert.equal(report.effectiveWallMs, 90 * 60 * 1000);
    assert.equal(report.declaredCostUsd, 10.0);
    assert.equal(report.effectiveCostCapUsd, 8.5);
    assert.equal(report.turnCap, 30);
    assert.equal(report.stallLimit, 5);
    assert.equal(report.childLimits.maxRounds, 8);
    assert.equal(report.terminatingLimiter, 'cost_repair');
  });
});
