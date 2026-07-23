import { randomUUID } from 'node:crypto';
import type { SessionUsageSummary } from './costTracker.js';
import { estimateProviderUsageCost, type CostPrecision } from './modelPricingRegistry.js';

export const COST_LEDGER_FILENAME = 'cost_ledger.json';

export interface CostLedgerEntry {
  entry_id: string;
  stage: string;
  tier_name: string | null;
  tier_index: number | null;
  attempt: number | null;
  succeeded: boolean | null;
  provider: string | null;
  model_id: string | null;
  latency_ms: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  prompt_cache_hit_tokens: number | null;
  prompt_cache_miss_tokens: number | null;
  input_cost_per_1m: number | null;
  output_cost_per_1m: number | null;
  input_cache_hit_cost_per_1m: number | null;
  input_cache_miss_cost_per_1m: number | null;
  estimated_cost_usd: number | null;
  cost_precision: CostPrecision;
  pricing_source_url: string | null;
  pricing_verified_at: string | null;
  warning: string | null;
}

export interface CostLedger {
  schema_version: 1;
  artifact_type: 'babel_cost_ledger';
  run_id: string;
  task: string;
  lane: string;
  created_at: string;
  pricing_mode: 'pinned_runtime_rates';
  totals: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    estimated_cost_usd: number;
    by_precision: Record<CostPrecision, number>;
    by_provider: Record<
      string,
      {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
        estimated_cost_usd: number;
      }
    >;
    by_model: Record<
      string,
      {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
        estimated_cost_usd: number;
      }
    >;
    by_stage: Record<
      string,
      {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
        estimated_cost_usd: number;
      }
    >;
  };
  entries: CostLedgerEntry[];
  warnings: string[];
}

interface WaterfallAttempt {
  tier_name?: string | null;
  tier_index?: number | null;
  attempt?: number | null;
  succeeded?: boolean | null;
  provider?: string | null;
  provider_model_id?: string | null;
  latency_ms?: number | null;
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  total_tokens?: number | null;
  prompt_cache_hit_tokens?: number | null;
  prompt_cache_miss_tokens?: number | null;
  estimated_cost_usd?: number | null;
  cost_precision?: unknown;
  pricing_source_url?: string | null;
  pricing_verified_at?: string | null;
  input_cost_per_1m?: number | null;
  output_cost_per_1m?: number | null;
  input_cache_hit_cost_per_1m?: number | null;
  input_cache_miss_cost_per_1m?: number | null;
}

interface WaterfallEntry {
  stage?: string;
  tier_succeeded?: string | null;
  tier_index?: number | null;
  total_latency_ms?: number | null;
  total_prompt_tokens?: number | null;
  total_completion_tokens?: number | null;
  total_tokens?: number | null;
  total_estimated_cost_usd?: number | null;
  attempts_detail?: WaterfallAttempt[];
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function roundCost(value: number): number {
  return Number(value.toFixed(12));
}

function emptyBucket(): {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  estimated_cost_usd: number;
} {
  return {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    estimated_cost_usd: 0,
  };
}

function addToBucket(
  buckets: Record<string, ReturnType<typeof emptyBucket>>,
  key: string | null,
  entry: CostLedgerEntry,
): void {
  if (!key) {
    return;
  }
  const bucket = buckets[key] ?? emptyBucket();
  bucket.prompt_tokens += entry.prompt_tokens ?? 0;
  bucket.completion_tokens += entry.completion_tokens ?? 0;
  bucket.total_tokens += entry.total_tokens ?? 0;
  bucket.estimated_cost_usd = roundCost(
    bucket.estimated_cost_usd + (entry.estimated_cost_usd ?? 0),
  );
  buckets[key] = bucket;
}

function normalizeCostPrecision(value: unknown): CostPrecision | null {
  return value === 'exact' || value === 'conservative' || value === 'unknown' ? value : null;
}

function toLedgerEntry(stage: string, attempt: WaterfallAttempt, index: number): CostLedgerEntry {
  const provider = attempt.provider ?? null;
  const modelId = attempt.provider_model_id ?? null;
  const estimate = estimateProviderUsageCost({
    provider,
    modelId,
    promptTokens: attempt.prompt_tokens,
    completionTokens: attempt.completion_tokens,
    promptCacheHitTokens: attempt.prompt_cache_hit_tokens,
    promptCacheMissTokens: attempt.prompt_cache_miss_tokens,
  });
  const promptTokens = asNumber(attempt.prompt_tokens);
  const completionTokens = asNumber(attempt.completion_tokens);
  const totalTokens =
    asNumber(attempt.total_tokens) ??
    (promptTokens !== null && completionTokens !== null ? promptTokens + completionTokens : null);
  const cost = asNumber(attempt.estimated_cost_usd) ?? estimate.estimatedCostUsd;
  const rawPrecision = attempt.cost_precision;
  const normalizedPrecision = normalizeCostPrecision(rawPrecision);
  const precision =
    normalizedPrecision ??
    (rawPrecision === null || rawPrecision === undefined ? estimate.precision : 'unknown');
  const precisionWarning =
    rawPrecision !== null && rawPrecision !== undefined && normalizedPrecision === null
      ? `Invalid cost precision "${String(rawPrecision)}" was normalized to unknown.`
      : null;
  const warning =
    [precisionWarning, estimate.warning]
      .filter((item): item is string => typeof item === 'string')
      .join(' ') || null;

  return {
    entry_id: `${stage}-${randomUUID().slice(0, 8)}`,
    stage,
    tier_name: attempt.tier_name ?? null,
    tier_index: asNumber(attempt.tier_index),
    attempt: asNumber(attempt.attempt),
    succeeded: typeof attempt.succeeded === 'boolean' ? attempt.succeeded : null,
    provider,
    model_id: modelId,
    latency_ms: asNumber(attempt.latency_ms),
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
    prompt_cache_hit_tokens: asNumber(attempt.prompt_cache_hit_tokens),
    prompt_cache_miss_tokens: asNumber(attempt.prompt_cache_miss_tokens),
    input_cost_per_1m: asNumber(attempt.input_cost_per_1m) ?? estimate.inputCostPer1M,
    output_cost_per_1m: asNumber(attempt.output_cost_per_1m) ?? estimate.outputCostPer1M,
    input_cache_hit_cost_per_1m:
      asNumber(attempt.input_cache_hit_cost_per_1m) ?? estimate.inputCacheHitCostPer1M,
    input_cache_miss_cost_per_1m:
      asNumber(attempt.input_cache_miss_cost_per_1m) ?? estimate.inputCacheMissCostPer1M,
    estimated_cost_usd: cost !== null ? roundCost(cost) : null,
    cost_precision: precision,
    pricing_source_url: attempt.pricing_source_url ?? estimate.pricingSourceUrl,
    pricing_verified_at: attempt.pricing_verified_at ?? estimate.pricingVerifiedAt,
    warning,
  };
}

export function buildCostLedger(options: {
  runId: string;
  task: string;
  lane: string;
  waterfallEntries: object[];
  createdAt?: Date;
}): CostLedger {
  const entries: CostLedgerEntry[] = [];
  const warnings = new Set<string>();

  for (const waterfall of options.waterfallEntries as WaterfallEntry[]) {
    const stage = waterfall.stage ?? 'unknown';
    const attempts =
      Array.isArray(waterfall.attempts_detail) && waterfall.attempts_detail.length > 0
        ? waterfall.attempts_detail
        : [
            {
              tier_name: waterfall.tier_succeeded ?? null,
              tier_index: waterfall.tier_index ?? null,
              attempt: 1,
              succeeded: waterfall.tier_succeeded ? true : null,
              latency_ms: waterfall.total_latency_ms ?? null,
              prompt_tokens: waterfall.total_prompt_tokens ?? null,
              completion_tokens: waterfall.total_completion_tokens ?? null,
              total_tokens: waterfall.total_tokens ?? null,
              estimated_cost_usd: waterfall.total_estimated_cost_usd ?? null,
            },
          ];

    for (const attempt of attempts) {
      const entry = toLedgerEntry(stage, attempt, entries.length);
      entries.push(entry);
      if (entry.cost_precision !== 'exact') {
        warnings.add(
          `${entry.entry_id}: ${entry.cost_precision} pricing for ${entry.provider ?? 'unknown'}:${entry.model_id ?? 'unknown'}.`,
        );
      }
      if (entry.warning) {
        warnings.add(`${entry.entry_id}: ${entry.warning}`);
      }
    }
  }

  const totals = {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    estimated_cost_usd: 0,
    by_precision: { exact: 0, conservative: 0, unknown: 0 } as Record<CostPrecision, number>,
    by_provider: {} as CostLedger['totals']['by_provider'],
    by_model: {} as CostLedger['totals']['by_model'],
    by_stage: {} as CostLedger['totals']['by_stage'],
  };

  for (const entry of entries) {
    totals.prompt_tokens += entry.prompt_tokens ?? 0;
    totals.completion_tokens += entry.completion_tokens ?? 0;
    totals.total_tokens += entry.total_tokens ?? 0;
    totals.estimated_cost_usd = roundCost(
      totals.estimated_cost_usd + (entry.estimated_cost_usd ?? 0),
    );
    totals.by_precision[entry.cost_precision] = roundCost(
      totals.by_precision[entry.cost_precision] + (entry.estimated_cost_usd ?? 0),
    );
    addToBucket(totals.by_provider, entry.provider, entry);
    addToBucket(totals.by_model, entry.model_id, entry);
    addToBucket(totals.by_stage, entry.stage, entry);
  }

  return {
    schema_version: 1,
    artifact_type: 'babel_cost_ledger',
    run_id: options.runId,
    task: options.task,
    lane: options.lane,
    created_at: (options.createdAt ?? new Date()).toISOString(),
    pricing_mode: 'pinned_runtime_rates',
    totals,
    entries,
    warnings: [...warnings],
  };
}

export function usageSummaryFromCostLedger(ledger: CostLedger): SessionUsageSummary {
  return {
    totalCostUSD: ledger.totals.estimated_cost_usd,
    totalInputTokens: ledger.totals.prompt_tokens,
    totalOutputTokens: ledger.totals.completion_tokens,
    totalTokens: ledger.totals.total_tokens,
    modelBreakdown: Object.fromEntries(
      Object.entries(ledger.totals.by_model).map(([model, usage]) => [
        model,
        {
          inputTokens: usage.prompt_tokens,
          outputTokens: usage.completion_tokens,
          costUSD: usage.estimated_cost_usd,
        },
      ]),
    ),
  };
}

export function buildSingleCallCostLedger(options: {
  runId: string;
  task: string;
  lane: string;
  stage: string;
  provider: string | null;
  modelId: string | null;
  latencyMs?: number | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  totalTokens?: number | null;
  createdAt?: Date;
}): CostLedger {
  return buildCostLedger({
    runId: options.runId,
    task: options.task,
    lane: options.lane,
    waterfallEntries: [
      {
        stage: options.stage,
        attempts_detail: [
          {
            tier_name: `${options.stage}-direct`,
            tier_index: 0,
            attempt: 1,
            succeeded: true,
            provider: options.provider,
            provider_model_id: options.modelId,
            latency_ms: options.latencyMs ?? null,
            prompt_tokens: options.promptTokens ?? null,
            completion_tokens: options.completionTokens ?? null,
            total_tokens: options.totalTokens ?? null,
          },
        ],
      },
    ],
    ...(options.createdAt ? { createdAt: options.createdAt } : {}),
  });
}
