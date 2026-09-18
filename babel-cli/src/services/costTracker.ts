import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  MODEL_PRICING_REGISTRY,
  estimateProviderUsageCost,
  getModelPricingByModelId,
} from './modelPricingRegistry.js';
import { getGlobalTokenHistoryDb } from './tokenHistoryDb.js';

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  costUSD: number;
  /** P-3.1: DeepSeek context cache hit tokens (KV cache reuse across turns). */
  promptCacheHitTokens?: number;
  /** P-3.1: DeepSeek context cache miss tokens (new encoding required). */
  promptCacheMissTokens?: number;
}

export interface ProjectStats {
  totalCostUSD: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  lastSessionId?: string;
  modelBreakdown: Record<string, ModelUsage>;
}

/** This-turn billed usage from two session snapshots. Never negative. */
export function usageDelta(
  before: Pick<SessionUsageSummary, 'totalCostUSD' | 'totalTokens'>,
  after: Pick<SessionUsageSummary, 'totalCostUSD' | 'totalTokens'>,
): { costUsd: number; tokens: number } {
  return {
    costUsd: Math.max(0, after.totalCostUSD - before.totalCostUSD),
    tokens: Math.max(0, after.totalTokens - before.totalTokens),
  };
}

/** Capture the current global total as the start of an independent task. */
export function captureCostBaselineUsd(): number {
  return globalCostTracker.getSessionSummary().totalCostUSD;
}

/**
 * Return spend attributable to a task that started at `baselineUsd`.
 * Global tracker totals remain the accounting truth; this delta is the
 * enforcement truth for one task/run and is never negative after restore.
 */
export function costSpentSinceBaselineUsd(baselineUsd: number): number {
  return Math.max(
    0,
    globalCostTracker.getSessionSummary().totalCostUSD - baselineUsd,
  );
}

export interface SessionUsageSummary {
  totalCostUSD: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  /** P-3.1: Total prompt cache hit tokens across all models. */
  totalCacheHitTokens?: number;
  /** P-3.1: Total prompt cache miss tokens across all models. */
  totalCacheMissTokens?: number;
  modelBreakdown: Record<string, ModelUsage>;
}

/** Stable task attribution for one provider-billed usage charge. */
export interface UsageAttribution {
  /** Immutable owner of the task that initiated this provider boundary. */
  taskOwnerId: string;
  /** Stable provider request/attempt identity used for idempotent replay. */
  chargeId: string;
  /** Optional delegating task. Child usage is charged to this owner once. */
  parentTaskOwnerId?: string;
}

const PRICING: Record<string, { input: number; output: number }> = {
  ...Object.fromEntries(
    Object.values(MODEL_PRICING_REGISTRY).map((entry) => [
      entry.modelId,
      { input: entry.inputCostPer1M, output: entry.outputCostPer1M },
    ]),
  ),
};

export class CostTracker {
  private readonly accountingEpoch = randomUUID();
  private sessionUsage: Record<string, ModelUsage> = {};
  private sessionTotalCost = 0;
  private taskUsage = new Map<string, Record<string, ModelUsage>>();
  private taskTotalCost = new Map<string, number>();
  private taskChargeIds = new Map<string, Set<string>>();
  private recordedChargeIds = new Set<string>();
  private projectStatsPath: string;

  constructor(projectRoot?: string) {
    this.projectStatsPath = projectRoot
      ? join(projectRoot, 'project_stats.json')
      : join(process.cwd(), 'project_stats.json');
  }

  public trackUsage(
    modelId: string,
    inputTokens: number,
    outputTokens: number,
    cacheHitTokens?: number | null,
    cacheMissTokens?: number | null,
    attribution?: UsageAttribution,
  ): number {
    const pricingEntry = getModelPricingByModelId(modelId);
    const estimate = estimateProviderUsageCost({
      provider: pricingEntry?.provider ?? null,
      modelId,
      promptTokens: inputTokens,
      completionTokens: outputTokens,
    });
    const pricing = PRICING[modelId] || { input: 0.5, output: 1.5 };
    const cost =
      estimate.estimatedCostUsd ??
      (inputTokens / 1_000_000) * pricing.input + (outputTokens / 1_000_000) * pricing.output;

    if (attribution && this.recordedChargeIds.has(attribution.chargeId)) {
      return 0;
    }

    if (!this.sessionUsage[modelId]) {
      this.sessionUsage[modelId] = { inputTokens: 0, outputTokens: 0, costUSD: 0 };
    }

    this.sessionUsage[modelId].inputTokens += inputTokens;
    this.sessionUsage[modelId].outputTokens += outputTokens;
    this.sessionUsage[modelId].costUSD += cost;
    if (cacheHitTokens != null) {
      this.sessionUsage[modelId].promptCacheHitTokens =
        (this.sessionUsage[modelId].promptCacheHitTokens ?? 0) + cacheHitTokens;
    }
    if (cacheMissTokens != null) {
      this.sessionUsage[modelId].promptCacheMissTokens =
        (this.sessionUsage[modelId].promptCacheMissTokens ?? 0) + cacheMissTokens;
    }
    this.sessionTotalCost += cost;

    if (attribution) {
      this.recordedChargeIds.add(attribution.chargeId);
      const owners = new Set([
        attribution.taskOwnerId,
        ...(attribution.parentTaskOwnerId ? [attribution.parentTaskOwnerId] : []),
      ]);
      for (const ownerId of owners) {
        this.recordTaskUsage(
          ownerId,
          attribution.chargeId,
          modelId,
          inputTokens,
          outputTokens,
          cost,
          cacheHitTokens,
          cacheMissTokens,
        );
      }
    }

    return cost;
  }

  private recordTaskUsage(
    taskOwnerId: string,
    chargeId: string,
    modelId: string,
    inputTokens: number,
    outputTokens: number,
    costUSD: number,
    cacheHitTokens?: number | null,
    cacheMissTokens?: number | null,
  ): void {
    const usage = this.taskUsage.get(taskOwnerId) ?? {};
    const model = usage[modelId] ?? { inputTokens: 0, outputTokens: 0, costUSD: 0 };
    model.inputTokens += inputTokens;
    model.outputTokens += outputTokens;
    model.costUSD += costUSD;
    if (cacheHitTokens != null) {
      model.promptCacheHitTokens = (model.promptCacheHitTokens ?? 0) + cacheHitTokens;
    }
    if (cacheMissTokens != null) {
      model.promptCacheMissTokens = (model.promptCacheMissTokens ?? 0) + cacheMissTokens;
    }
    usage[modelId] = model;
    this.taskUsage.set(taskOwnerId, usage);
    this.taskTotalCost.set(taskOwnerId, (this.taskTotalCost.get(taskOwnerId) ?? 0) + costUSD);
    const charges = this.taskChargeIds.get(taskOwnerId) ?? new Set<string>();
    charges.add(chargeId);
    this.taskChargeIds.set(taskOwnerId, charges);
  }

  public resetSession(): void {
    this.sessionUsage = {};
    this.sessionTotalCost = 0;
    this.taskUsage.clear();
    this.taskTotalCost.clear();
    this.taskChargeIds.clear();
    this.recordedChargeIds.clear();
  }

  /** Identifies the in-process accounting epoch for durable task scoping. */
  public getAccountingEpoch(): string {
    return this.accountingEpoch;
  }

  /** Restore cost state from a saved session (resume). */
  public restoreSessionCost(totals: {
    totalCostUSD: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalTokens: number;
  }): void {
    this.sessionTotalCost = totals.totalCostUSD;
    // Best-effort: reconstruct a synthetic usage entry so getSessionSummary() returns non-zero
    if (totals.totalTokens > 0) {
      this.sessionUsage['__restored__'] = {
        inputTokens: totals.totalInputTokens,
        outputTokens: totals.totalOutputTokens,
        costUSD: totals.totalCostUSD,
        // Cache fields set to 0 since they can't be recovered from a previous session
        // but the structure must be consistent with ModelUsage.
        promptCacheHitTokens: 0,
        promptCacheMissTokens: 0,
      };
    }
  }

  public getSessionSummary(): SessionUsageSummary {
    const modelBreakdown = Object.fromEntries(
      Object.entries(this.sessionUsage).map(([modelId, usage]) => [modelId, { ...usage }]),
    );
    const totalInputTokens = Object.values(modelBreakdown).reduce(
      (sum, usage) => sum + usage.inputTokens,
      0,
    );
    const totalOutputTokens = Object.values(modelBreakdown).reduce(
      (sum, usage) => sum + usage.outputTokens,
      0,
    );

    const totalCacheHitTokens = Object.values(modelBreakdown).reduce(
      (sum, usage) => sum + (usage.promptCacheHitTokens ?? 0),
      0,
    );
    const totalCacheMissTokens = Object.values(modelBreakdown).reduce(
      (sum, usage) => sum + (usage.promptCacheMissTokens ?? 0),
      0,
    );

    const summary: SessionUsageSummary = {
      totalCostUSD: this.sessionTotalCost,
      totalInputTokens,
      totalOutputTokens,
      totalTokens: totalInputTokens + totalOutputTokens,
      modelBreakdown,
    };
    if (totalCacheHitTokens > 0) {
      summary.totalCacheHitTokens = totalCacheHitTokens;
    }
    if (totalCacheMissTokens > 0) {
      summary.totalCacheMissTokens = totalCacheMissTokens;
    }
    return summary;
  }

  /** Return usage attributed to one immutable task owner. */
  public getTaskSummary(taskOwnerId: string): SessionUsageSummary {
    const modelBreakdown = Object.fromEntries(
      Object.entries(this.taskUsage.get(taskOwnerId) ?? {}).map(([modelId, usage]) => [
        modelId,
        { ...usage },
      ]),
    );
    const totalInputTokens = Object.values(modelBreakdown).reduce(
      (sum, usage) => sum + usage.inputTokens,
      0,
    );
    const totalOutputTokens = Object.values(modelBreakdown).reduce(
      (sum, usage) => sum + usage.outputTokens,
      0,
    );
    const totalCacheHitTokens = Object.values(modelBreakdown).reduce(
      (sum, usage) => sum + (usage.promptCacheHitTokens ?? 0),
      0,
    );
    const totalCacheMissTokens = Object.values(modelBreakdown).reduce(
      (sum, usage) => sum + (usage.promptCacheMissTokens ?? 0),
      0,
    );
    return {
      totalCostUSD: this.taskTotalCost.get(taskOwnerId) ?? 0,
      totalInputTokens,
      totalOutputTokens,
      totalTokens: totalInputTokens + totalOutputTokens,
      modelBreakdown,
      ...(totalCacheHitTokens > 0 ? { totalCacheHitTokens } : {}),
      ...(totalCacheMissTokens > 0 ? { totalCacheMissTokens } : {}),
    };
  }

  /** Stable charge identities already applied to one task owner. */
  public getTaskChargeIds(taskOwnerId: string): string[] {
    return [...(this.taskChargeIds.get(taskOwnerId) ?? new Set<string>())];
  }

  /**
   * Seed durable task spend after cold resume without adding it to this
   * process's global aggregate. Existing in-process task usage wins.
   */
  public restoreTaskUsage(
    taskOwnerId: string,
    input: { totalCostUSD: number; chargeIds: readonly string[] },
  ): void {
    if (!this.taskTotalCost.has(taskOwnerId)) {
      this.taskTotalCost.set(taskOwnerId, input.totalCostUSD);
      this.taskUsage.set(
        taskOwnerId,
        input.totalCostUSD > 0
          ? {
              __restored__: {
                inputTokens: 0,
                outputTokens: 0,
                costUSD: input.totalCostUSD,
              },
            }
          : {},
      );
    }
    const charges = this.taskChargeIds.get(taskOwnerId) ?? new Set<string>();
    for (const chargeId of input.chargeIds) {
      charges.add(chargeId);
      this.recordedChargeIds.add(chargeId);
    }
    this.taskChargeIds.set(taskOwnerId, charges);
  }

  public saveToProjectStats(sessionId: string) {
    let stats: ProjectStats = {
      totalCostUSD: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      modelBreakdown: {},
    };

    if (existsSync(this.projectStatsPath)) {
      try {
        stats = JSON.parse(readFileSync(this.projectStatsPath, 'utf-8'));
      } catch (e) {
        // Ignore corruption, reset
      }
    }

    // Dedup: skip if this session was the last one persisted (prevents
    // double-counting when saveToProjectStats is called multiple times
    // within the same session, e.g., once per pipeline stage).
    if (stats.lastSessionId === sessionId) {
      return;
    }

    stats.lastSessionId = sessionId;

    for (const [model, usage] of Object.entries(this.sessionUsage)) {
      stats.totalCostUSD += usage.costUSD;
      stats.totalInputTokens += usage.inputTokens;
      stats.totalOutputTokens += usage.outputTokens;

      if (!stats.modelBreakdown[model]) {
        stats.modelBreakdown[model] = { inputTokens: 0, outputTokens: 0, costUSD: 0 };
      }
      stats.modelBreakdown[model].inputTokens += usage.inputTokens;
      stats.modelBreakdown[model].outputTokens += usage.outputTokens;
      stats.modelBreakdown[model].costUSD += usage.costUSD;
      if (usage.promptCacheHitTokens != null) {
        stats.modelBreakdown[model].promptCacheHitTokens =
          (stats.modelBreakdown[model].promptCacheHitTokens ?? 0) + usage.promptCacheHitTokens;
      }
      if (usage.promptCacheMissTokens != null) {
        stats.modelBreakdown[model].promptCacheMissTokens =
          (stats.modelBreakdown[model].promptCacheMissTokens ?? 0) + usage.promptCacheMissTokens;
      }
    }

    // Atomic write: temp file → rename, prevents corruption on crash.
    const tmpPath = `${this.projectStatsPath}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(stats, null, 2));
    renameSync(tmpPath, this.projectStatsPath);

    // Also upsert the session summary into SQLite for historical queries.
    // This is additive — JSON project_stats.json remains as the primary store.
    this._upsertSessionSummaryToSqlite(sessionId);
  }

  /**
   * Upsert the current session's usage summary into the SQLite session_summary table.
   * Best-effort — failures are caught silently.
   */
  private _upsertSessionSummaryToSqlite(sessionId: string): void {
    try {
      const summary = this.getSessionSummary();
      const projectRoot = dirname(this.projectStatsPath);

      const db = getGlobalTokenHistoryDb();
      db.upsertSessionSummary(sessionId, {
        startedAt: Date.now(),
        endedAt: null,
        totalInputTokens: summary.totalInputTokens,
        totalOutputTokens: summary.totalOutputTokens,
        totalCost: summary.totalCostUSD,
        turnCount: 1, // Each saveToProjectStats call counts as a batch save point
        projectRoot,
      });
    } catch {
      // Best-effort — silent if DB is unavailable
    }
  }

  /**
   * Query historical total cost for a project from SQLite.
   * Returns 0 if the database is unavailable or has no records.
   */
  public getProjectHistoricalCost(projectRoot?: string): number {
    try {
      const root = projectRoot ?? dirname(this.projectStatsPath);
      const db = getGlobalTokenHistoryDb();
      return db.getProjectTotalCost(root);
    } catch {
      return 0;
    }
  }
}

// Singleton for easy access in CLI turns
export const globalCostTracker = new CostTracker();
