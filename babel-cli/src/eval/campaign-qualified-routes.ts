import type { PreparedProviderRequest } from '../runners/preparedProviderRequest.js'
import { LIVE_OPENROUTER_DEEPSEEK_MODEL_IDS } from '../modelPolicy.js'
import type { ProviderId } from '../runners/providerRegistry.js'

/** Exact Command Code native route qualified for campaign metering. */
export const CAMPAIGN_QUALIFIED_COMMAND_CODE_MODEL_ID = 'deepseek/deepseek-v4.1-flash' as const

/** OpenRouter campaign lane: exact DeepSeek v4 flash control model only. */
export const CAMPAIGN_QUALIFIED_OPENROUTER_MODEL_ID = LIVE_OPENROUTER_DEEPSEEK_MODEL_IDS[0]

const CAMPAIGN_QUALIFIED_OPENROUTER_MODEL_IDS: ReadonlySet<string> = new Set([
  CAMPAIGN_QUALIFIED_OPENROUTER_MODEL_ID,
])

const CAMPAIGN_NATIVE_PROVIDER_IDS: ReadonlySet<ProviderId> = new Set([
  'openrouter',
  'command-code',
])

export function isCampaignNativeProvider(provider: string | null | undefined): boolean {
  if (!provider) return false
  return CAMPAIGN_NATIVE_PROVIDER_IDS.has(provider as ProviderId)
}

export function isCampaignQualifiedModelRoute(provider: string, sentModelId: string): boolean {
  if (provider === 'command-code') {
    return sentModelId === CAMPAIGN_QUALIFIED_COMMAND_CODE_MODEL_ID
  }
  if (provider === 'openrouter') {
    return CAMPAIGN_QUALIFIED_OPENROUTER_MODEL_IDS.has(sentModelId)
  }
  return false
}

export function assertCampaignQualifiedPreparedRequest(prepared: PreparedProviderRequest): void {
  if (!isCampaignNativeProvider(prepared.provider)) {
    throw new Error('campaign route provider unsupported')
  }
  if (!isCampaignQualifiedModelRoute(prepared.provider, prepared.sent_model_id)) {
    throw new Error('campaign route model unsupported')
  }
}
