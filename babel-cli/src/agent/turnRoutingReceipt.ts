/**
 * Per-turn routing receipt — records which model+phase served each turn.
 */

export type ChatPhase = 'investigate' | 'mutate' | 'verify' | 'escalate' | null;

export interface TurnRoutingReceipt {
  turn: number;
  phase: ChatPhase;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  cache_hit_tokens?: number;
  cache_miss_tokens?: number;
}

export interface RoutingSummary {
  models_used: string[];
  cost_by_model: Record<string, number>;
  phase_histogram: Record<string, number>;
  pro_cost_share: number;  // fraction of total cost from pro-tier models
}

/**
 * Derive a human-readable model tier label from a provider model ID.
 * Extracts short tier labels (Flash/Pro) from model IDs like
 * "deepseek-v4-flash" or "deepseek-v4-pro". Falls back to the raw
 * model ID when the tier cannot be determined.
 */
function deriveModelTier(model: string): string {
  const lower = model.toLowerCase();
  if (lower.includes('flash')) return 'Flash';
  if (lower.includes('pro')) return 'Pro';
  if (lower.includes('sonnet')) return 'Sonnet';
  if (lower.includes('opus')) return 'Opus';
  if (lower.includes('haiku')) return 'Haiku';
  if (lower.includes('fable')) return 'Fable';
  // Return a compact fallback — last segment of the model ID
  const parts = model.split(/[/-]/);
  return parts[parts.length - 1] ?? model;
}

/**
 * Format a compact routing-status label for the REPL status bar.
 *
 * Produces labels like "Flash·mutate", "Pro·investigate", or "Flash" when
 * no phase is recorded. Returns an empty string when the receipt has no
 * usable model or phase.
 */
export function formatRoutingStatusLabel(receipt: TurnRoutingReceipt): string {
  const tier = deriveModelTier(receipt.model);
  const phase = receipt.phase;
  if (tier && phase) return `${tier}·${phase}`;
  if (tier) return tier;
  if (phase) return phase;
  return '';
}

export class TurnRoutingReceiptLog {
  private receipts: TurnRoutingReceipt[] = [];

  /** Push a receipt after a deliberate turn completes. */
  push(receipt: TurnRoutingReceipt): void {
    this.receipts.push(receipt);
  }

  all(): ReadonlyArray<TurnRoutingReceipt> {
    return this.receipts;
  }

  /** Compute a summary useful for harness rollups. */
  summarize(): RoutingSummary {
    const models = new Set<string>();
    const costByModel: Record<string, number> = {};
    const phaseHist: Record<string, number> = {};
    let totalCost = 0;
    let proCost = 0;

    for (const r of this.receipts) {
      models.add(r.model);
      costByModel[r.model] = (costByModel[r.model] ?? 0) + r.cost_usd;
      const phaseKey = r.phase ?? 'unknown';
      phaseHist[phaseKey] = (phaseHist[phaseKey] ?? 0) + 1;
      totalCost += r.cost_usd;
      if (r.model.includes('pro')) {
        proCost += r.cost_usd;
      }
    }

    return {
      models_used: [...models].sort(),
      cost_by_model: costByModel,
      phase_histogram: phaseHist,
      pro_cost_share: totalCost > 0 ? proCost / totalCost : 0,
    };
  }

  toJSON(): TurnRoutingReceipt[] {
    return [...this.receipts];
  }

  clear(): void {
    this.receipts = [];
  }
}
