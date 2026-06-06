import {
  DEEPSEEK_PRICING_SOURCE_URL,
  DEEPSEEK_SUPPORTED_MODELS,
  MODEL_PRICING_VERIFIED_AT,
  assertSupportedDeepSeekModel,
  estimateProviderUsageCost,
  getModelPricing,
  isSupportedDeepSeekModel,
  supportedDeepSeekModelsText,
  type DeepSeekModelId,
} from './modelPricingRegistry.js';

export {
  DEEPSEEK_PRICING_SOURCE_URL,
  DEEPSEEK_SUPPORTED_MODELS,
  assertSupportedDeepSeekModel,
  isSupportedDeepSeekModel,
  supportedDeepSeekModelsText,
  type DeepSeekModelId,
};

export const DEEPSEEK_PRICING_VERIFIED_AT = MODEL_PRICING_VERIFIED_AT;

export interface DeepSeekTokenPricing {
  inputCacheHitCostPer1M: number;
  inputCacheMissCostPer1M: number;
  outputCostPer1M: number;
}

export interface DeepSeekUsageForPricing {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
}

export function getDeepSeekPricing(model: string): DeepSeekTokenPricing | null {
  const pricing = getModelPricing('deepseek', model);
  if (!pricing?.inputCacheHitCostPer1M || !pricing.inputCacheMissCostPer1M) {
    return null;
  }
  return {
    inputCacheHitCostPer1M: pricing.inputCacheHitCostPer1M,
    inputCacheMissCostPer1M: pricing.inputCacheMissCostPer1M,
    outputCostPer1M: pricing.outputCostPer1M,
  };
}

export function getConservativeDeepSeekTokenPricing(model: string): { input: number; output: number } | null {
  const pricing = getDeepSeekPricing(model);
  if (!pricing) {
    return null;
  }
  return {
    input: pricing.inputCacheMissCostPer1M,
    output: pricing.outputCostPer1M,
  };
}

export function estimateDeepSeekCostUsd(model: string, usage?: DeepSeekUsageForPricing): number | null {
  if (!usage) {
    return null;
  }
  return estimateProviderUsageCost({
    provider: 'deepseek',
    modelId: model,
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
    promptCacheHitTokens: usage.prompt_cache_hit_tokens,
    promptCacheMissTokens: usage.prompt_cache_miss_tokens,
  }).estimatedCostUsd;
}
