import { type RunnerInvocationMetadata } from './base.js';
import { estimateProviderUsageCost } from '../services/modelPricingRegistry.js';
import type { ProviderId } from './providerRegistry.js';
import { hashCanonical } from '../intelligence/hash.js';
import { normalizeBabelFinishReason } from '../intelligence/attribution.js';


// ─── Response shape (OpenAI-compatible subset) ────────────────────────────────

interface ChatChoice {
  message?: { content?: string | null };
  finish_reason?: string | null;
}


export interface ChatResponse {
  model?: string;
  /** OpenRouter may expose the concrete upstream provider in this field. */
  provider?: string;
  openrouter_metadata?: OpenRouterResponseMetadata;
  choices?: ChatChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    reasoning_tokens?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
  };
}

export interface OpenRouterResponseMetadata {
  endpoints?: {
    available?: Array<{
      provider?: string;
      model?: string;
      selected?: boolean;
      endpoint?: string;
    }>;
  };
  attempts?: Array<{ provider?: string; model?: string; status?: number; endpoint?: string }>;
  context_transformation?: boolean;
  route?: unknown;
  pipeline?: unknown;
}

interface RouterMetadataProvenance {
  hash: string;
  attemptCount: number;
  fallbackOccurred: boolean;
  selectedEndpoint: string | null;
  contextTransformationOccurred: boolean;
}


export function routerMetadataProvenance(metadata: OpenRouterResponseMetadata | null | undefined): RouterMetadataProvenance | null {
  if (!metadata) return null;
  const attempts = metadata.attempts ?? [];
  const selected = metadata.endpoints?.available?.find((endpoint) => endpoint.selected === true);
  return {
    hash: hashCanonical({
      endpoints: metadata.endpoints?.available ?? [],
      attempts,
      context_transformation: metadata.context_transformation ?? false,
      route: metadata.route,
      pipeline: metadata.pipeline,
    }),
    attemptCount: attempts.length,
    fallbackOccurred: attempts.length > 1 || attempts.some((attempt) => attempt.status !== undefined && attempt.status !== 200),
    selectedEndpoint: selected?.endpoint ?? null,
    contextTransformationOccurred: metadata.context_transformation === true,
  };
}


export function upstreamProviderFromResponse(value: {
  provider?: string;
  openrouter_metadata?: OpenRouterResponseMetadata;
}): string | null {
  if (typeof value.provider === 'string' && value.provider.length > 0) return value.provider;
  const selected = value.openrouter_metadata?.endpoints?.available?.find(
    (endpoint) => endpoint.selected === true && typeof endpoint.provider === 'string',
  );
  if (selected?.provider) return selected.provider;
  const successful = value.openrouter_metadata?.attempts?.find(
    (attempt) => attempt.status === 200 && typeof attempt.provider === 'string',
  );
  return successful?.provider ?? null;
}

function normalizeTokenCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}


export function buildInvocationMetadata(
  provider: ProviderId,
  model: string,
  latencyMs: number,
  usage?: ChatResponse['usage'],
  ttftMs?: number | null,
  generationMs?: number | null,
  validationMs?: number | null,
  observedModelId?: string | null,
  upstreamProvider?: string | null,
  routerMetadata?: OpenRouterResponseMetadata | null,
  finishReason?: string | null,
  configuredOutputBudget?: number | null,
): RunnerInvocationMetadata {
  const promptTokens = normalizeTokenCount(usage?.prompt_tokens);
  const completionTokens = normalizeTokenCount(usage?.completion_tokens);
  const totalTokens =
    normalizeTokenCount(usage?.total_tokens) ??
    (promptTokens !== null && completionTokens !== null ? promptTokens + completionTokens : null);
  const estimate = estimateProviderUsageCost({
    provider,
    modelId: model,
    promptTokens,
    completionTokens,
  });
  const router = routerMetadataProvenance(routerMetadata);
  const reasoningTokens =
    normalizeTokenCount(usage?.reasoning_tokens) ??
    normalizeTokenCount(usage?.completion_tokens_details?.reasoning_tokens);
  const finish =
    finishReason === undefined
      ? null
      : normalizeBabelFinishReason({
          raw: finishReason,
          ...(configuredOutputBudget === undefined ? {} : { configuredOutputBudget }),
          actualCompletionTokens: completionTokens,
        });

  return {
    provider,
    provider_model_id: model,
    requested_model_id: model,
    normalized_model_id: model,
    sent_model_id: model,
    observed_model_id: observedModelId ?? null,
    upstream_provider: upstreamProvider ?? null,
    ...(finish === null
      ? {}
      : {
          normalized_finish_reason: finish.normalized,
          failure_attribution: finish.attribution.kind,
        }),
    ...(router === null ? {} : {
      router_metadata_hash: router.hash,
      openrouter_router_attempt: router.attemptCount,
      actual_endpoint_id: router.selectedEndpoint,
      fallback_status: router.fallbackOccurred ? 'occurred' as const : 'none' as const,
      context_transformation_occurred: router.contextTransformationOccurred,
    }),
    latency_ms: latencyMs,
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
    actual_reasoning_tokens: reasoningTokens,
    estimated_cost_usd: estimate.estimatedCostUsd,
    cost_precision: estimate.precision,
    pricing_source_url: estimate.pricingSourceUrl,
    pricing_verified_at: estimate.pricingVerifiedAt,
    input_cost_per_1m: estimate.inputCostPer1M,
    output_cost_per_1m: estimate.outputCostPer1M,
    input_cache_hit_cost_per_1m: estimate.inputCacheHitCostPer1M,
    input_cache_miss_cost_per_1m: estimate.inputCacheMissCostPer1M,
    ttft_ms: ttftMs ?? null,
    generation_ms: generationMs ?? null,
    validation_ms: validationMs ?? null,
  };
}
