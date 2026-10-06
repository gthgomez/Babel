import {
  DEEPSEEK_PRICING_SOURCE_URL,
  MODEL_PRICING_VERIFIED_AT,
  computeQuoteCostUsd,
  resolvePriceQuote,
} from '../intelligence/price-quote.js'

export { DEEPSEEK_PRICING_SOURCE_URL }

export const DEEPSEEK_PRICING_VERIFIED_AT = MODEL_PRICING_VERIFIED_AT

/**
 * Direct DeepSeek models Babel can address without an aggregator.
 *
 * This allowlisting is provider capability, not pricing, so it lives with the
 * DeepSeek module. `modelPricingRegistry` keeps a deprecated re-export until
 * C06 migrates the remaining callers.
 */
export const DEEPSEEK_SUPPORTED_MODELS = ['deepseek-v4-flash', 'deepseek-v4-pro'] as const

export type DeepSeekModelId = (typeof DEEPSEEK_SUPPORTED_MODELS)[number]

/** True when `model` is an allowlisted direct DeepSeek model id. */
export function isSupportedDeepSeekModel(model: string): model is DeepSeekModelId {
  return (DEEPSEEK_SUPPORTED_MODELS as readonly string[]).includes(model)
}

/** Human-readable allowlist for error messages and diagnostics. */
export function supportedDeepSeekModelsText(): string {
  return DEEPSEEK_SUPPORTED_MODELS.join(', ')
}

/** Narrow `model` to an allowlisted DeepSeek id or throw. */
export function assertSupportedDeepSeekModel(model: string): DeepSeekModelId {
  if (isSupportedDeepSeekModel(model)) {
    return model
  }
  throw new Error(
    `Unsupported DeepSeek model "${model}". Supported direct DeepSeek models: ${supportedDeepSeekModelsText()}.`,
  )
}

export interface DeepSeekTokenPricing {
  inputCacheHitCostPer1M: number
  inputCacheMissCostPer1M: number
  outputCostPer1M: number
}

export interface DeepSeekUsageForPricing {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
  prompt_cache_hit_tokens?: number
  prompt_cache_miss_tokens?: number
}

/** Direct DeepSeek cache-aware pricing, or null when the model is unregistered. */
export function getDeepSeekPricing(model: string): DeepSeekTokenPricing | null {
  const quote = resolvePriceQuote({ provider: 'deepseek', modelId: model }).quote
  if (
    !quote ||
    quote.cacheReadCost === null ||
    quote.cacheWriteCost === null ||
    quote.outputCost === null
  ) {
    return null
  }
  return {
    inputCacheHitCostPer1M: quote.cacheReadCost,
    inputCacheMissCostPer1M: quote.cacheWriteCost,
    outputCostPer1M: quote.outputCost,
  }
}

/** Conservative DeepSeek rates that assume every prompt token is a cache miss. */
export function getConservativeDeepSeekTokenPricing(
  model: string,
): { input: number; output: number } | null {
  const pricing = getDeepSeekPricing(model)
  if (!pricing) {
    return null
  }
  return {
    input: pricing.inputCacheMissCostPer1M,
    output: pricing.outputCostPer1M,
  }
}

/** Price one DeepSeek usage observation, or null when it cannot be priced. */
export function estimateDeepSeekCostUsd(
  model: string,
  usage?: DeepSeekUsageForPricing,
): number | null {
  if (!usage) {
    return null
  }
  const quote = resolvePriceQuote({ provider: 'deepseek', modelId: model }).quote
  if (!quote) {
    return null
  }
  return computeQuoteCostUsd(quote, {
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
    cacheHitTokens: usage.prompt_cache_hit_tokens,
    cacheMissTokens: usage.prompt_cache_miss_tokens,
  }).estimatedCostUsd
}
