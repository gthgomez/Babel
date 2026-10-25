import type { PreparedProviderRequest } from '../runners/preparedProviderRequest.js'
import {
  estimateProviderUsageCost,
  getModelPricing,
  type CostPrecision,
} from '../services/modelPricingRegistry.js'
import type { ModelRouteStage } from '../agent/modelRouteReceipt.js'
import type { ProviderId } from '../runners/providerRegistry.js'
import {
  assertCampaignQualifiedPreparedRequest,
  isCampaignNativeProvider,
  isCampaignQualifiedModelRoute,
} from './campaign-qualified-routes.js'

export const CAMPAIGN_METERED_PROVIDER_IDS: readonly ProviderId[] = [
  'openrouter',
  'command-code',
]

export function isCampaignMeteredProvider(provider: string | null | undefined): boolean {
  return isCampaignNativeProvider(provider)
}

export function isCampaignQualifiedProviderRoute(
  provider: string | null | undefined,
  sentModelId: string | null | undefined,
): boolean {
  if (!provider || !sentModelId) return false
  return isCampaignQualifiedModelRoute(provider, sentModelId)
}

export function buildCampaignOperationId(input: {
  campaignId: string
  taskOwnerId: string
  executionStage: ModelRouteStage
  requestId: string
  attemptId: string
}): string {
  return `${input.campaignId}:${input.taskOwnerId}:${input.executionStage}:${input.requestId}:${input.attemptId}`
}

function verifiedMaxInputContextTokens(prepared: PreparedProviderRequest): number {
  if (
    prepared.context_limit_tokens === null ||
    prepared.context_limit_source === 'unknown'
  ) {
    throw new Error('campaign route missing verified input context bound')
  }
  return prepared.context_limit_tokens
}

/** Reservation ceiling from verified max input context and enforced max output (separate bounds). */
export function reservationUpperBoundMicroUsd(prepared: PreparedProviderRequest): number {
  assertCampaignQualifiedPreparedRequest(prepared)
  const reservedCompletion = prepared.accounting.reserved_completion_tokens
  if (reservedCompletion === null || reservedCompletion <= 0) {
    throw new Error('campaign route missing reserved completion bound')
  }
  if (!getModelPricing(prepared.provider, prepared.sent_model_id)) {
    throw new Error('campaign route pricing unknown')
  }
  const promptTokens = verifiedMaxInputContextTokens(prepared)
  const estimate = estimateProviderUsageCost({
    provider: prepared.provider,
    modelId: prepared.sent_model_id,
    promptTokens,
    completionTokens: reservedCompletion,
    promptCacheHitTokens: 0,
    promptCacheMissTokens: promptTokens,
  })
  if (estimate.estimatedCostUsd === null) {
    throw new Error('campaign route pricing unknown')
  }
  return Math.max(1, Math.ceil(estimate.estimatedCostUsd * 1_000_000))
}

export function actualMicroUsdFromUsage(input: {
  provider: string | null | undefined
  modelId: string | null | undefined
  promptTokens: number | null | undefined
  completionTokens: number | null | undefined
  reportedCostUsd?: number | null | undefined
  providerReportedTotalChargeUsd?: number | null | undefined
  costPrecision?: CostPrecision | null
}): number | 'unknown' {
  const providerTotal = input.providerReportedTotalChargeUsd
  if (
    input.costPrecision === 'exact' &&
    providerTotal !== null &&
    providerTotal !== undefined
  ) {
    if (!Number.isFinite(providerTotal) || providerTotal < 0) return 'unknown'
    return Math.ceil(providerTotal * 1_000_000)
  }
  if (
    input.costPrecision === 'exact' &&
    input.promptTokens !== null &&
    input.promptTokens !== undefined &&
    input.completionTokens !== null &&
    input.completionTokens !== undefined &&
    input.provider &&
    input.modelId
  ) {
    const estimate = estimateProviderUsageCost({
      provider: input.provider,
      modelId: input.modelId,
      promptTokens: input.promptTokens,
      completionTokens: input.completionTokens,
    })
    if (estimate.estimatedCostUsd === null || estimate.precision !== 'exact') {
      return 'unknown'
    }
    return Math.max(0, Math.ceil(estimate.estimatedCostUsd * 1_000_000))
  }
  return 'unknown'
}
