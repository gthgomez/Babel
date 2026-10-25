import type { PreparedProviderRequest } from '../runners/preparedProviderRequest.js'
import { estimateProviderUsageCost } from '../services/modelPricingRegistry.js'
import type { ModelRouteStage } from '../agent/modelRouteReceipt.js'
import type { ProviderId } from '../runners/providerRegistry.js'

export const CAMPAIGN_METERED_PROVIDER_IDS: readonly ProviderId[] = [
  'openrouter',
  'deepinfra',
  'deepseek',
]

export function isCampaignMeteredProvider(provider: string | null | undefined): boolean {
  if (!provider) return false
  return (CAMPAIGN_METERED_PROVIDER_IDS as readonly string[]).includes(provider)
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

/** Conservative reservation ceiling from the frozen prepared body. */
export function reservationUpperBoundMicroUsd(prepared: PreparedProviderRequest): number {
  const estimate = estimateProviderUsageCost({
    provider: prepared.provider,
    modelId: prepared.sent_model_id,
    promptTokens: prepared.accounting.estimated_input_tokens,
    completionTokens: prepared.accounting.reserved_completion_tokens,
  })
  if (estimate.estimatedCostUsd === null) {
    throw new Error('campaign route pricing unknown')
  }
  let micro = Math.ceil(estimate.estimatedCostUsd * 1_000_000)
  if (estimate.precision !== 'exact') {
    micro = Math.ceil(micro * 1.25)
  }
  return Math.max(1, micro)
}

export function actualMicroUsdFromUsage(input: {
  provider: string | null | undefined
  modelId: string | null | undefined
  promptTokens: number | null | undefined
  completionTokens: number | null | undefined
  reportedCostUsd: number | null | undefined
}): number | 'unknown' {
  if (input.reportedCostUsd !== null && input.reportedCostUsd !== undefined) {
    if (!Number.isFinite(input.reportedCostUsd) || input.reportedCostUsd < 0) return 'unknown'
    return Math.ceil(input.reportedCostUsd * 1_000_000)
  }
  const estimate = estimateProviderUsageCost({
    provider: input.provider,
    modelId: input.modelId,
    promptTokens: input.promptTokens,
    completionTokens: input.completionTokens,
  })
  if (estimate.estimatedCostUsd === null || estimate.precision === 'unknown') {
    return 'unknown'
  }
  return Math.max(0, Math.ceil(estimate.estimatedCostUsd * 1_000_000))
}
