export type PricingProvider = 'deepinfra' | 'deepseek';
export type CostPrecision = 'exact' | 'conservative' | 'unknown';

export interface ModelPricingEntry {
  provider: PricingProvider;
  modelId: string;
  inputCostPer1M: number;
  outputCostPer1M: number;
  sourceUrl: string;
  verifiedAt: string;
  inputCacheHitCostPer1M?: number;
  inputCacheMissCostPer1M?: number;
  cacheInputDiscountAvailable?: boolean;
}

export interface UsageCostInput {
  provider: string | null | undefined;
  modelId: string | null | undefined;
  promptTokens?: number | null | undefined;
  completionTokens?: number | null | undefined;
  promptCacheHitTokens?: number | null | undefined;
  promptCacheMissTokens?: number | null | undefined;
}

export interface UsageCostEstimate {
  estimatedCostUsd: number | null;
  inputCostUsd: number | null;
  outputCostUsd: number | null;
  precision: CostPrecision;
  pricingSourceUrl: string | null;
  pricingVerifiedAt: string | null;
  inputCostPer1M: number | null;
  outputCostPer1M: number | null;
  inputCacheHitCostPer1M: number | null;
  inputCacheMissCostPer1M: number | null;
  warning: string | null;
}

export const DEEPSEEK_PRICING_SOURCE_URL = 'https://api-docs.deepseek.com/quick_start/pricing/';
export const DEEPINFRA_PRICING_SOURCE_URL =
  'https://docs.deepinfra.com/api-reference/models/models-list';
export const MODEL_PRICING_VERIFIED_AT = '2026-06-04';

export const DEEPSEEK_SUPPORTED_MODELS = ['deepseek-v4-flash', 'deepseek-v4-pro'] as const;
export type DeepSeekModelId = (typeof DEEPSEEK_SUPPORTED_MODELS)[number];

export const MODEL_PRICING_REGISTRY: Record<string, ModelPricingEntry> = {
  'deepinfra:meta-llama/Llama-4-Scout-17B-16E-Instruct': {
    provider: 'deepinfra',
    modelId: 'meta-llama/Llama-4-Scout-17B-16E-Instruct',
    inputCostPer1M: 0.08,
    outputCostPer1M: 0.3,
    sourceUrl: DEEPINFRA_PRICING_SOURCE_URL,
    verifiedAt: MODEL_PRICING_VERIFIED_AT,
  },
  'deepinfra:Qwen/Qwen3-235B-A22B-Instruct-2507': {
    provider: 'deepinfra',
    modelId: 'Qwen/Qwen3-235B-A22B-Instruct-2507',
    inputCostPer1M: 0.071,
    outputCostPer1M: 0.1,
    sourceUrl: DEEPINFRA_PRICING_SOURCE_URL,
    verifiedAt: MODEL_PRICING_VERIFIED_AT,
  },
  'deepinfra:stepfun-ai/Step-3.5-Flash': {
    provider: 'deepinfra',
    modelId: 'stepfun-ai/Step-3.5-Flash',
    inputCostPer1M: 0.09,
    outputCostPer1M: 0.3,
    sourceUrl: DEEPINFRA_PRICING_SOURCE_URL,
    verifiedAt: MODEL_PRICING_VERIFIED_AT,
    cacheInputDiscountAvailable: true,
  },
  'deepinfra:nvidia/NVIDIA-Nemotron-3-Super-120B-A12B': {
    provider: 'deepinfra',
    modelId: 'nvidia/NVIDIA-Nemotron-3-Super-120B-A12B',
    inputCostPer1M: 0.1,
    outputCostPer1M: 0.5,
    sourceUrl: DEEPINFRA_PRICING_SOURCE_URL,
    verifiedAt: MODEL_PRICING_VERIFIED_AT,
  },
  'deepinfra:deepseek-ai/DeepSeek-V3-0324': {
    provider: 'deepinfra',
    modelId: 'deepseek-ai/DeepSeek-V3-0324',
    inputCostPer1M: 0.2,
    outputCostPer1M: 0.77,
    sourceUrl: DEEPINFRA_PRICING_SOURCE_URL,
    verifiedAt: MODEL_PRICING_VERIFIED_AT,
    cacheInputDiscountAvailable: true,
  },
  'deepinfra:Qwen/Qwen3-32B': {
    provider: 'deepinfra',
    modelId: 'Qwen/Qwen3-32B',
    inputCostPer1M: 0.08,
    outputCostPer1M: 0.28,
    sourceUrl: DEEPINFRA_PRICING_SOURCE_URL,
    verifiedAt: MODEL_PRICING_VERIFIED_AT,
  },
  'deepseek:deepseek-v4-flash': {
    provider: 'deepseek',
    modelId: 'deepseek-v4-flash',
    inputCostPer1M: 0.14,
    outputCostPer1M: 0.28,
    inputCacheHitCostPer1M: 0.0028,
    inputCacheMissCostPer1M: 0.14,
    sourceUrl: DEEPSEEK_PRICING_SOURCE_URL,
    verifiedAt: MODEL_PRICING_VERIFIED_AT,
    cacheInputDiscountAvailable: true,
  },
  'deepseek:deepseek-v4-pro': {
    provider: 'deepseek',
    modelId: 'deepseek-v4-pro',
    inputCostPer1M: 0.435,
    outputCostPer1M: 0.87,
    inputCacheHitCostPer1M: 0.003625,
    inputCacheMissCostPer1M: 0.435,
    sourceUrl: DEEPSEEK_PRICING_SOURCE_URL,
    verifiedAt: MODEL_PRICING_VERIFIED_AT,
    cacheInputDiscountAvailable: true,
  },
};

function registryKey(
  provider: string | null | undefined,
  modelId: string | null | undefined,
): string | null {
  if (!provider || !modelId) {
    return null;
  }
  return `${provider}:${modelId}`;
}

function normalizeTokenCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

export function getModelPricing(
  provider: string | null | undefined,
  modelId: string | null | undefined,
): ModelPricingEntry | null {
  const key = registryKey(provider, modelId);
  return key ? (MODEL_PRICING_REGISTRY[key] ?? null) : null;
}

export function getModelPricingByModelId(modelId: string): ModelPricingEntry | null {
  return Object.values(MODEL_PRICING_REGISTRY).find((entry) => entry.modelId === modelId) ?? null;
}

export function getDeepInfraPricingEntries(): ModelPricingEntry[] {
  return Object.values(MODEL_PRICING_REGISTRY).filter((entry) => entry.provider === 'deepinfra');
}

export function isSupportedDeepSeekModel(model: string): model is DeepSeekModelId {
  return (DEEPSEEK_SUPPORTED_MODELS as readonly string[]).includes(model);
}

export function supportedDeepSeekModelsText(): string {
  return DEEPSEEK_SUPPORTED_MODELS.join(', ');
}

export function assertSupportedDeepSeekModel(model: string): DeepSeekModelId {
  if (isSupportedDeepSeekModel(model)) {
    return model;
  }
  throw new Error(
    `Unsupported DeepSeek model "${model}". Supported direct DeepSeek models: ${supportedDeepSeekModelsText()}.`,
  );
}

export function estimateProviderUsageCost(input: UsageCostInput): UsageCostEstimate {
  const pricing = getModelPricing(input.provider, input.modelId);
  if (!pricing) {
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
    };
  }

  const promptTokens = normalizeTokenCount(input.promptTokens);
  const completionTokens = normalizeTokenCount(input.completionTokens);
  const cacheHitTokens = normalizeTokenCount(input.promptCacheHitTokens);
  const cacheMissTokens = normalizeTokenCount(input.promptCacheMissTokens);
  let inputCostUsd: number | null = null;
  let outputCostUsd: number | null = null;
  let precision: CostPrecision = 'exact';
  let warning: string | null = null;

  if (cacheHitTokens !== null || cacheMissTokens !== null) {
    const hitTokens = cacheHitTokens ?? 0;
    const missTokens =
      cacheMissTokens ?? (promptTokens !== null ? Math.max(promptTokens - hitTokens, 0) : 0);
    const hitRate = pricing.inputCacheHitCostPer1M ?? pricing.inputCostPer1M;
    const missRate = pricing.inputCacheMissCostPer1M ?? pricing.inputCostPer1M;
    inputCostUsd = (hitTokens / 1_000_000) * hitRate + (missTokens / 1_000_000) * missRate;
  } else if (promptTokens !== null) {
    inputCostUsd = (promptTokens / 1_000_000) * pricing.inputCostPer1M;
    if (pricing.cacheInputDiscountAvailable) {
      precision = 'conservative';
      warning =
        'Input cache discounts may apply, but cache-hit/cache-miss token counts were not available.';
    }
  }

  if (completionTokens !== null) {
    outputCostUsd = (completionTokens / 1_000_000) * pricing.outputCostPer1M;
  }

  const estimatedCostUsd =
    inputCostUsd !== null || outputCostUsd !== null
      ? (inputCostUsd ?? 0) + (outputCostUsd ?? 0)
      : null;

  return {
    estimatedCostUsd,
    inputCostUsd,
    outputCostUsd,
    precision: estimatedCostUsd === null ? 'unknown' : precision,
    pricingSourceUrl: pricing.sourceUrl,
    pricingVerifiedAt: pricing.verifiedAt,
    inputCostPer1M: pricing.inputCostPer1M,
    outputCostPer1M: pricing.outputCostPer1M,
    inputCacheHitCostPer1M: pricing.inputCacheHitCostPer1M ?? null,
    inputCacheMissCostPer1M: pricing.inputCacheMissCostPer1M ?? null,
    warning,
  };
}
