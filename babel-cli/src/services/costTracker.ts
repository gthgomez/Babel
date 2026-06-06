import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  MODEL_PRICING_REGISTRY,
  estimateProviderUsageCost,
  getModelPricingByModelId,
} from './modelPricingRegistry.js';

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  costUSD: number;
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
  modelBreakdown: Record<string, ModelUsage>;
}

const PRICING: Record<string, { input: number; output: number }> = {
  ...Object.fromEntries(Object.values(MODEL_PRICING_REGISTRY).map(entry => [
    entry.modelId,
    { input: entry.inputCostPer1M, output: entry.outputCostPer1M },
  ])),
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

  public trackUsage(modelId: string, inputTokens: number, outputTokens: number): number {
    const pricingEntry = getModelPricingByModelId(modelId);
    const estimate = estimateProviderUsageCost({
      provider: pricingEntry?.provider ?? null,
      modelId,
      promptTokens: inputTokens,
      completionTokens: outputTokens,
    });
    const pricing = PRICING[modelId] || { input: 0.50, output: 1.50 };
    const cost = estimate.estimatedCostUsd
      ?? (inputTokens / 1_000_000 * pricing.input) + (outputTokens / 1_000_000 * pricing.output);

    if (!this.sessionUsage[modelId]) {
      this.sessionUsage[modelId] = { inputTokens: 0, outputTokens: 0, costUSD: 0 };
    }

    this.sessionUsage[modelId].inputTokens += inputTokens;
    this.sessionUsage[modelId].outputTokens += outputTokens;
    this.sessionUsage[modelId].costUSD += cost;
    this.sessionTotalCost += cost;

    return cost;
  }

  public resetSession(): void {
    this.sessionUsage = {};
    this.sessionTotalCost = 0;
  }

  public getSessionSummary(): SessionUsageSummary {
    const modelBreakdown = Object.fromEntries(
      Object.entries(this.sessionUsage).map(([modelId, usage]) => [
        modelId,
        { ...usage },
      ]),
    );
    const totalInputTokens = Object.values(modelBreakdown).reduce((sum, usage) => sum + usage.inputTokens, 0);
    const totalOutputTokens = Object.values(modelBreakdown).reduce((sum, usage) => sum + usage.outputTokens, 0);

    return {
      totalCostUSD: this.sessionTotalCost,
      totalInputTokens,
      totalOutputTokens,
      totalTokens: totalInputTokens + totalOutputTokens,
      modelBreakdown,
    };
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
    }

    writeFileSync(this.projectStatsPath, JSON.stringify(stats, null, 2));
  }
}

// Singleton for easy access in CLI turns
export const globalCostTracker = new CostTracker();
