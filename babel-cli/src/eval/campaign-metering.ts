import type { PreparedProviderRequest } from '../runners/preparedProviderRequest.js'
import { estimateProviderUsageCost, type CostPrecision } from '../services/modelPricingRegistry.js'
import type { ModelRouteStage } from '../agent/modelRouteReceipt.js'
import type { ProviderId } from '../runners/providerRegistry.js'
import {
  assertCampaignQualifiedPreparedRequest,
  isCampaignNativeProvider,
  isCampaignQualifiedModelRoute,
} from './campaign-qualified-routes.js'
import { campaignQualifiedMaxInputContextTokens } from './campaign-qualified-context.js'
import {
  legacyReservationUpperBoundMicroUsd,
  resolveCampaignLegacyReservationRates,
} from './campaign-legacy-reservation-rates.js'

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
  const pinned = campaignQualifiedMaxInputContextTokens(
    prepared.provider,
    prepared.sent_model_id,
  )
  if (pinned === null) {
    throw new Error('campaign route missing verified input context bound')
  }
  return pinned
}

/** Legacy non-certifying reservation ceiling (configured ceiling table, not usage estimates). */
export function reservationUpperBoundMicroUsd(prepared: PreparedProviderRequest): number {
  assertCampaignQualifiedPreparedRequest(prepared)
  const reservedCompletion = prepared.accounting.reserved_completion_tokens
  if (reservedCompletion === null || reservedCompletion <= 0) {
    throw new Error('campaign route missing reserved completion bound')
  }
  const legacyRates = resolveCampaignLegacyReservationRates(
    prepared.provider,
    prepared.sent_model_id,
  )
  if (!legacyRates) {
    throw new Error('campaign legacy reservation rates unknown')
  }
  const promptTokens = verifiedMaxInputContextTokens(prepared)
  return legacyReservationUpperBoundMicroUsd(
    legacyRates,
    promptTokens,
    reservedCompletion,
  )
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
