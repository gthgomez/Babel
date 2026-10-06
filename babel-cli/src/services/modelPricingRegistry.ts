import {
  CANONICAL_PRICE_QUOTES,
  computeQuoteCostUsd,
  resolvePriceQuote,
  type PriceQuote,
} from '../intelligence/price-quote.js'

export {
  DEEPSEEK_PRICING_SOURCE_URL,
  DEEPINFRA_PRICING_SOURCE_URL,
  MODEL_PRICING_VERIFIED_AT,
  OPENROUTER_PRICING_SOURCE_URL,
} from '../intelligence/price-quote.js'

/**
 * Deprecated DeepSeek allowlisting compatibility surface.
 *
 * The allowlist now lives in `deepSeekPricing` (provider capability, not
 * pricing). These re-exports exist only until C06 migrates the remaining
 * callers and must not gain new consumers.
 */
export {
  DEEPSEEK_SUPPORTED_MODELS,
  assertSupportedDeepSeekModel,
  isSupportedDeepSeekModel,
  supportedDeepSeekModelsText,
  type DeepSeekModelId,
} from './deepSeekPricing.js'

export type PricingProvider = 'deepinfra' | 'deepseek' | 'openrouter'
export type CostPrecision = 'exact' | 'conservative' | 'unknown'

export interface ModelPricingEntry {
  provider: PricingProvider
  modelId: string
  inputCostPer1M: number
  outputCostPer1M: number
  sourceUrl: string
  verifiedAt: string
  inputCacheHitCostPer1M?: number
  inputCacheMissCostPer1M?: number
  cacheInputDiscountAvailable?: boolean
}

export interface UsageCostInput {
  provider: string | null | undefined
  modelId: string | null | undefined
  promptTokens?: number | null | undefined
  completionTokens?: number | null | undefined
  promptCacheHitTokens?: number | null | undefined
  promptCacheMissTokens?: number | null | undefined
}

export interface UsageCostEstimate {
  estimatedCostUsd: number | null
  inputCostUsd: number | null
  outputCostUsd: number | null
  precision: CostPrecision
  pricingSourceUrl: string | null
  pricingVerifiedAt: string | null
  inputCostPer1M: number | null
  outputCostPer1M: number | null
  inputCacheHitCostPer1M: number | null
  inputCacheMissCostPer1M: number | null
  warning: string | null
}

function registryKey(
  provider: string | null | undefined,
  modelId: string | null | undefined,
): string | null {
  if (!provider || !modelId) {
    return null
  }
  return `${provider}:${modelId}`
}

function normalizeTokenCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

/** Project one unconditioned quote into the legacy per-million entry shape. */
function entryFromQuote(quote: PriceQuote): ModelPricingEntry | null {
  if (
    Object.keys(quote.conditions).length > 0 ||
    typeof quote.inputCost !== 'number' ||
    typeof quote.outputCost !== 'number'
  ) {
    return null
  }
  const entry: ModelPricingEntry = {
    provider: quote.provider as PricingProvider,
    modelId: quote.modelId,
    inputCostPer1M: quote.inputCost,
    outputCostPer1M: quote.outputCost,
    sourceUrl: quote.sourceUrl,
    verifiedAt: quote.verifiedAt,
  }
  if (quote.cacheReadCost !== null) {
    entry.inputCacheHitCostPer1M = quote.cacheReadCost
  }
  if (quote.cacheWriteCost !== null) {
    entry.inputCacheMissCostPer1M = quote.cacheWriteCost
  }
  if (quote.cacheDiscountAvailable) {
    entry.cacheInputDiscountAvailable = true
  }
  return entry
}

/**
 * Derived per-million lookup table.
 *
 * Rates have one owner, `CANONICAL_PRICE_QUOTES` in the price-quote module.
 * This registry is a compatibility projection until C06 migrates callers; it
 * must not regain hard-coded rates.
 */
export const MODEL_PRICING_REGISTRY: Record<string, ModelPricingEntry> = Object.fromEntries(
  CANONICAL_PRICE_QUOTES.flatMap((quote) => {
    const entry = entryFromQuote(quote)
    return entry === null ? [] : [[`${entry.provider}:${entry.modelId}`, entry] as const]
  }),
)

/** Look up a derived per-million entry for an exact provider/model pair. */
export function getModelPricing(
  provider: string | null | undefined,
  modelId: string | null | undefined,
): ModelPricingEntry | null {
  const key = registryKey(provider, modelId)
  return key ? (MODEL_PRICING_REGISTRY[key] ?? null) : null
}

/** First derived entry whose model id matches, independent of provider. */
export function getModelPricingByModelId(modelId: string): ModelPricingEntry | null {
  return Object.values(MODEL_PRICING_REGISTRY).find((entry) => entry.modelId === modelId) ?? null
}

/** All derived DeepInfra entries, used by the pricing audit script. */
export function getDeepInfraPricingEntries(): ModelPricingEntry[] {
  return Object.values(MODEL_PRICING_REGISTRY).filter((entry) => entry.provider === 'deepinfra')
}

function unknownEstimate(input: UsageCostInput): UsageCostEstimate {
  return {
    estimatedCostUsd: null,
    inputCostUsd: null,
    outputCostUsd: null,
    precision: 'unknown',
    pricingSourceUrl: null,
    pricingVerifiedAt: null,
    inputCostPer1M: null,
    outputCostPer1M: null,
    inputCacheHitCostPer1M: null,
    inputCacheMissCostPer1M: null,
    warning: input.modelId
      ? `No pinned pricing is registered for ${input.provider ?? 'unknown'}:${input.modelId}.`
      : 'No model id was provided for pricing.',
  }
}

/**
 * Estimate a provider charge with the legacy public shape.
 *
 * Facts come from the canonical price quotes; unknown components stay null and
 * are never coerced to zero. Arithmetic is shared with the quote module so the
 * per-million conversion happens exactly once per component.
 */
export function estimateProviderUsageCost(input: UsageCostInput): UsageCostEstimate {
  const quote = resolvePriceQuote({ provider: input.provider, modelId: input.modelId }).quote
  const pricing = quote ? getModelPricing(input.provider, input.modelId) : null
  if (!quote || !pricing) {
    return unknownEstimate(input)
  }

  const promptTokens = normalizeTokenCount(input.promptTokens)
  const completionTokens = normalizeTokenCount(input.completionTokens)
  const cacheHitTokens = normalizeTokenCount(input.promptCacheHitTokens)
  const cacheMissTokens = normalizeTokenCount(input.promptCacheMissTokens)
  const breakdown = computeQuoteCostUsd(quote, {
    promptTokens,
    completionTokens,
    cacheHitTokens,
    cacheMissTokens,
  })

  let precision: CostPrecision = 'exact'
  let warning: string | null = null
  if (
    breakdown.inputCostUsd !== null &&
    cacheHitTokens === null &&
    cacheMissTokens === null &&
    promptTokens !== null &&
    pricing.cacheInputDiscountAvailable
  ) {
    precision = 'conservative'
    warning =
      'Input cache discounts may apply, but cache-hit/cache-miss token counts were not available.'
  }

  return {
    estimatedCostUsd: breakdown.estimatedCostUsd,
    inputCostUsd: breakdown.inputCostUsd,
    outputCostUsd: breakdown.outputCostUsd,
    precision: breakdown.estimatedCostUsd === null ? 'unknown' : precision,
    pricingSourceUrl: pricing.sourceUrl,
    pricingVerifiedAt: pricing.verifiedAt,
    inputCostPer1M: pricing.inputCostPer1M,
    outputCostPer1M: pricing.outputCostPer1M,
    inputCacheHitCostPer1M: pricing.inputCacheHitCostPer1M ?? null,
    inputCacheMissCostPer1M: pricing.inputCacheMissCostPer1M ?? null,
    warning,
  }
}
