/**
 * Per-turn routing receipt — records which model+phase served each turn,
 * plus effort/cost telemetry for causal benchmark cell rollups (Slice 2).
 */

export type ChatPhase = 'investigate' | 'mutate' | 'verify' | 'escalate' | null;

/**
 * Where the cell-level "effective" effort value was taken from.
 * Prefer observed → sent → normalized → requested; never invent a level.
 */
export type EffortEffectiveSource =
  | 'observed'
  | 'sent'
  | 'normalized'
  | 'requested'
  | 'unknown';

/**
 * Cost basis for estimated_usd (plan terminology).
 * Estimates use provider_usage_x_pinned_rate; never claim provider_billed without invoice.
 */
export type ReceiptCostBasis =
  | 'provider_billed'
  | 'provider_usage_x_pinned_rate'
  | 'unknown';

export interface TurnRoutingReceipt {
  turn: number;
  phase: ChatPhase;
  model: string;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
  cache_hit_tokens?: number;
  cache_miss_tokens?: number;

  // ── Effort telemetry (four fields + source; no ambiguous single effective without source)
  requested_reasoning_effort?: string | null;
  normalized_reasoning_effort?: string | null;
  sent_reasoning_effort?: string | null;
  observed_reasoning_effort?: string | null;
  /** Derived: which of the four fields is used as the effective value. */
  effective_source?: EffortEffectiveSource;
  /** Derived: true when requested !== sent (or requested !== normalized when sent null). */
  effort_aliased?: boolean;

  // ── Model identity (requested/sent/observed)
  requested_model_id?: string | null;
  normalized_model_id?: string | null;
  sent_model_id?: string | null;
  observed_model_id?: string | null;

  // ── Cost terminology (plan)
  cost_basis?: ReceiptCostBasis;
  pricing_verified_at?: string | null;
  pricing_source_url?: string | null;
  cost_precision?: string | null;
  /** Only set when real billing evidence exists (rare). */
  billing_observed_at?: string | null;
}

export interface RoutingSummary {
  models_used: string[];
  cost_by_model: Record<string, number | null>;
  phase_histogram: Record<string, number>;
  pro_cost_share: number | null; // unknown if any cost is unpriced
  total_cost_usd: number | null;
  known_total_cost_usd: number;
  unknown_cost_turn_count: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_hit_tokens: number;
  total_cache_miss_tokens: number;
  /** Any turn had effort_aliased === true */
  effort_aliased_any: boolean;
  /** Last turn's effort snapshot (most recent non-empty) */
  last_requested_effort: string | null;
  last_sent_effort: string | null;
  last_observed_effort: string | null;
  last_effective_source: EffortEffectiveSource;
}

/**
 * Cell-level effort summary derived from per-turn receipts.
 * Rule: last turn with any effort field wins for requested/sent/observed;
 * effective_source is recomputed from that snapshot; effort_aliased is OR across turns.
 */
export interface CellEffortSummary {
  requested_reasoning_effort: string | null;
  normalized_reasoning_effort: string | null;
  sent_reasoning_effort: string | null;
  observed_reasoning_effort: string | null;
  effective_source: EffortEffectiveSource;
  /** The value selected by effective_source (null if unknown). */
  effective_reasoning_effort: string | null;
  effort_aliased: boolean;
  turns_with_effort: number;
}

export interface CellCostSummary {
  estimated_usd: number | null;
  known_estimated_usd: number;
  unknown_cost_turn_count: number;
  cost_basis: ReceiptCostBasis;
  pricing_verified_at: string | null;
  pricing_source_url: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_hit_tokens: number;
  cache_miss_tokens: number;
  turn_count: number;
  /** Sum of per-turn cost_usd must equal estimated_usd (within 1e-9). */
  reconciled: boolean;
}

/**
 * Derive whether effort was aliased (requested label differs from what was sent).
 * Prefer requested vs sent; if sent missing, compare requested vs normalized.
 */
export function deriveEffortAliased(
  requested: string | null | undefined,
  sent: string | null | undefined,
  normalized?: string | null | undefined,
): boolean {
  const req = normalizeEffortLabel(requested);
  if (!req) return false;
  const sentN = normalizeEffortLabel(sent);
  if (sentN) return req !== sentN;
  const norm = normalizeEffortLabel(normalized);
  if (norm) return req !== norm;
  return false;
}

export function normalizeEffortLabel(value: string | null | undefined): string | null {
  if (value == null) return null;
  const t = String(value).trim().toLowerCase();
  return t.length ? t : null;
}

/**
 * Prefer observed → sent → normalized → requested.
 */
export function resolveEffectiveEffortSource(input: {
  requested?: string | null;
  normalized?: string | null;
  sent?: string | null;
  observed?: string | null;
}): { source: EffortEffectiveSource; value: string | null } {
  const observed = normalizeEffortLabel(input.observed);
  if (observed) return { source: 'observed', value: observed };
  const sent = normalizeEffortLabel(input.sent);
  if (sent) return { source: 'sent', value: sent };
  const normalized = normalizeEffortLabel(input.normalized);
  if (normalized) return { source: 'normalized', value: normalized };
  const requested = normalizeEffortLabel(input.requested);
  if (requested) return { source: 'requested', value: requested };
  return { source: 'unknown', value: null };
}

export function mapCostPrecisionToBasis(
  precision: string | null | undefined,
): ReceiptCostBasis {
  if (precision === 'exact' || precision === 'conservative' || precision === 'estimated') {
    return 'provider_usage_x_pinned_rate';
  }
  if (precision === 'billed' || precision === 'invoice') {
    return 'provider_billed';
  }
  // Unrecognized precision cannot prove a pinned price.
  return 'unknown';
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

/**
 * Aggregate per-turn receipts into a cell-level effort summary.
 */
export function summarizeCellEffort(
  receipts: ReadonlyArray<TurnRoutingReceipt>,
): CellEffortSummary {
  let last: TurnRoutingReceipt | null = null;
  let turns_with_effort = 0;
  let effort_aliased = false;

  for (const r of receipts) {
    const has =
      r.requested_reasoning_effort != null ||
      r.normalized_reasoning_effort != null ||
      r.sent_reasoning_effort != null ||
      r.observed_reasoning_effort != null;
    if (has) {
      turns_with_effort += 1;
      last = r;
    }
    if (r.effort_aliased) effort_aliased = true;
  }

  if (!last) {
    return {
      requested_reasoning_effort: null,
      normalized_reasoning_effort: null,
      sent_reasoning_effort: null,
      observed_reasoning_effort: null,
      effective_source: 'unknown',
      effective_reasoning_effort: null,
      effort_aliased: false,
      turns_with_effort: 0,
    };
  }

  const requested = normalizeEffortLabel(last.requested_reasoning_effort);
  const normalized = normalizeEffortLabel(last.normalized_reasoning_effort);
  const sent = normalizeEffortLabel(last.sent_reasoning_effort);
  const observed = normalizeEffortLabel(last.observed_reasoning_effort);
  const { source, value } = resolveEffectiveEffortSource({
    requested,
    normalized,
    sent,
    observed,
  });
  if (!effort_aliased) {
    effort_aliased = deriveEffortAliased(requested, sent, normalized);
  }

  return {
    requested_reasoning_effort: requested,
    normalized_reasoning_effort: normalized,
    sent_reasoning_effort: sent,
    observed_reasoning_effort: observed,
    effective_source: source,
    effective_reasoning_effort: value,
    effort_aliased,
    turns_with_effort,
  };
}

/**
 * Aggregate cost from receipts; mark reconciled when sum matches total.
 */
export function summarizeCellCost(
  receipts: ReadonlyArray<TurnRoutingReceipt>,
): CellCostSummary {
  let estimated_usd = 0;
  let unknown_cost_turn_count = 0;
  let input_tokens = 0;
  let output_tokens = 0;
  let cache_hit_tokens = 0;
  let cache_miss_tokens = 0;
  let pricing_verified_at: string | null = null;
  let pricing_source_url: string | null = null;
  let cost_basis: ReceiptCostBasis = 'unknown';

  for (const r of receipts) {
    if (r.cost_usd === null) unknown_cost_turn_count++;
    else estimated_usd += r.cost_usd;
    input_tokens += r.input_tokens ?? 0;
    output_tokens += r.output_tokens ?? 0;
    cache_hit_tokens += r.cache_hit_tokens ?? 0;
    cache_miss_tokens += r.cache_miss_tokens ?? 0;
    if (r.pricing_verified_at) pricing_verified_at = r.pricing_verified_at;
    if (r.pricing_source_url) pricing_source_url = r.pricing_source_url;
    if (r.cost_basis && r.cost_basis !== 'unknown') cost_basis = r.cost_basis;
  }

  // Floating sum: treat near-equal as reconciled
  const rounded = Math.round(estimated_usd * 1e9) / 1e9;
  const reSum = receipts.reduce((s, r) => s + (r.cost_usd ?? 0), 0);
  const reconciled = unknown_cost_turn_count === 0 && Math.abs(rounded - reSum) < 1e-9;

  return {
    estimated_usd: unknown_cost_turn_count === 0 ? rounded : null,
    known_estimated_usd: rounded,
    unknown_cost_turn_count,
    cost_basis: receipts.length === 0 || unknown_cost_turn_count > 0 ? 'unknown' : cost_basis,
    pricing_verified_at,
    pricing_source_url,
    input_tokens,
    output_tokens,
    cache_hit_tokens,
    cache_miss_tokens,
    turn_count: receipts.length,
    reconciled,
  };
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
    const costByModel: Record<string, number | null> = {};
    const phaseHist: Record<string, number> = {};
    let totalCost = 0;
    let proCost = 0;
    let unknownCostTurnCount = 0;
    let total_input_tokens = 0;
    let total_output_tokens = 0;
    let total_cache_hit_tokens = 0;
    let total_cache_miss_tokens = 0;
    let effort_aliased_any = false;
    let last_requested_effort: string | null = null;
    let last_sent_effort: string | null = null;
    let last_observed_effort: string | null = null;
    let last_effective_source: EffortEffectiveSource = 'unknown';

    for (const r of this.receipts) {
      models.add(r.model);
      if (r.cost_usd === null) {
        unknownCostTurnCount++;
        costByModel[r.model] = null;
      } else if (costByModel[r.model] !== null) {
        costByModel[r.model] = (costByModel[r.model] ?? 0) + r.cost_usd;
        totalCost += r.cost_usd;
        if (r.model.includes('pro')) proCost += r.cost_usd;
      } else {
        totalCost += r.cost_usd;
        if (r.model.includes('pro')) proCost += r.cost_usd;
      }
      const phaseKey = r.phase ?? 'unknown';
      phaseHist[phaseKey] = (phaseHist[phaseKey] ?? 0) + 1;
      total_input_tokens += r.input_tokens ?? 0;
      total_output_tokens += r.output_tokens ?? 0;
      total_cache_hit_tokens += r.cache_hit_tokens ?? 0;
      total_cache_miss_tokens += r.cache_miss_tokens ?? 0;
      if (r.effort_aliased) effort_aliased_any = true;
      if (r.requested_reasoning_effort != null) {
        last_requested_effort = normalizeEffortLabel(r.requested_reasoning_effort);
      }
      if (r.sent_reasoning_effort != null) {
        last_sent_effort = normalizeEffortLabel(r.sent_reasoning_effort);
      }
      if (r.observed_reasoning_effort != null) {
        last_observed_effort = normalizeEffortLabel(r.observed_reasoning_effort);
      }
      if (r.effective_source) last_effective_source = r.effective_source;
    }

    return {
      models_used: [...models].sort(),
      cost_by_model: costByModel,
      phase_histogram: phaseHist,
      pro_cost_share: unknownCostTurnCount > 0 ? null : totalCost > 0 ? proCost / totalCost : 0,
      total_cost_usd: unknownCostTurnCount > 0 ? null : totalCost,
      known_total_cost_usd: totalCost,
      unknown_cost_turn_count: unknownCostTurnCount,
      total_input_tokens,
      total_output_tokens,
      total_cache_hit_tokens,
      total_cache_miss_tokens,
      effort_aliased_any,
      last_requested_effort,
      last_sent_effort,
      last_observed_effort,
      last_effective_source,
    };
  }

  toJSON(): TurnRoutingReceipt[] {
    return [...this.receipts];
  }

  clear(): void {
    this.receipts = [];
  }
}
