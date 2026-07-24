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

const PRICING: Record<string, { input: number; output: number }> = {
  ...Object.fromEntries(
    Object.values(MODEL_PRICING_REGISTRY).map((entry) => [
      entry.modelId,
      { input: entry.inputCostPer1M, output: entry.outputCostPer1M },
    ]),
  ),
};

export class CostTracker {
  private sessionUsage: Record<string, ModelUsage> = {};
  private sessionTotalCost = 0;
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

    return cost;
  }

  public resetSession(): void {
    this.sessionUsage = {};
    this.sessionTotalCost = 0;
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
