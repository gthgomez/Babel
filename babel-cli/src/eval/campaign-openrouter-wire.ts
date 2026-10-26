import type { PreparedProviderRequest } from '../runners/preparedProviderRequest.js'
import {
  prepareProviderRequest,
  type PrepareProviderRequestInput,
} from '../runners/preparedProviderRequest.js'
import { getModelPricing } from '../services/modelPricingRegistry.js'
import {
  assertCampaignQualifiedPreparedRequest,
  CAMPAIGN_QUALIFIED_OPENROUTER_MODEL_ID,
  isCampaignQualifiedModelRoute,
} from './campaign-qualified-routes.js'

/** Registry-backed OpenRouter USD/M-token caps (refuses higher-priced upstreams). */
export interface CampaignOpenRouterMaxPriceUsdPerMillion {
  readonly prompt: number
  readonly completion: number
  /** Per-request surcharge cap (USD); zero refuses priced per-request upstreams. */
  readonly request: 0
}

export interface CampaignOpenRouterProviderWire {
  readonly allow_fallbacks: false
  readonly require_parameters: true
  readonly max_price: CampaignOpenRouterMaxPriceUsdPerMillion
}

export const CAMPAIGN_OPENROUTER_MAX_PRICE_REQUEST_USD = 0 as const

export function campaignOpenRouterRegistryMaxPriceUsdPerMillion(
  modelId: string = CAMPAIGN_QUALIFIED_OPENROUTER_MODEL_ID,
): CampaignOpenRouterMaxPriceUsdPerMillion {
  const pricing = getModelPricing('openrouter', modelId)
  if (!pricing) {
    throw new Error('campaign openrouter route pricing unknown')
  }
  return {
    prompt: pricing.inputCostPer1M,
    completion: pricing.outputCostPer1M,
    request: CAMPAIGN_OPENROUTER_MAX_PRICE_REQUEST_USD,
  }
}

export function buildCampaignOpenRouterProviderWire(
  sentModelId: string,
): CampaignOpenRouterProviderWire {
  if (!isCampaignQualifiedModelRoute('openrouter', sentModelId)) {
    throw new Error('campaign openrouter wire unsupported model')
  }
  return {
    allow_fallbacks: false,
    require_parameters: true,
    max_price: campaignOpenRouterRegistryMaxPriceUsdPerMillion(sentModelId),
  }
}

/** Apply campaign OpenRouter routing caps before serialize/prepare/hash. */
export function applyCampaignOpenRouterWireBody(
  body: Record<string, unknown>,
  sentModelId: string,
): Record<string, unknown> {
  const providerWire = buildCampaignOpenRouterProviderWire(sentModelId)
  const existing = body.provider
  const existingRecord =
    existing !== null && typeof existing === 'object' && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : {}
  return {
    ...body,
    provider: {
      ...existingRecord,
      allow_fallbacks: providerWire.allow_fallbacks,
      require_parameters: providerWire.require_parameters,
      max_price: {
        prompt: providerWire.max_price.prompt,
        completion: providerWire.max_price.completion,
        request: providerWire.max_price.request,
      },
    },
  }
}

function readProviderWire(body: Record<string, unknown>): Record<string, unknown> | null {
  const provider = body.provider
  if (provider === null || typeof provider !== 'object' || Array.isArray(provider)) {
    return null
  }
  return provider as Record<string, unknown>
}

function readMaxPrice(
  provider: Record<string, unknown>,
): CampaignOpenRouterMaxPriceUsdPerMillion | null {
  const maxPrice = provider.max_price
  if (maxPrice === null || typeof maxPrice !== 'object' || Array.isArray(maxPrice)) {
    return null
  }
  const record = maxPrice as Record<string, unknown>
  const prompt = record.prompt
  const completion = record.completion
  const request = record.request
  if (typeof prompt !== 'number' || typeof completion !== 'number') return null
  if (request !== CAMPAIGN_OPENROUTER_MAX_PRICE_REQUEST_USD) return null
  if (!Number.isFinite(prompt) || !Number.isFinite(completion)) return null
  return { prompt, completion, request: CAMPAIGN_OPENROUTER_MAX_PRICE_REQUEST_USD }
}

/** Gate verification on the exact serialized body bytes. */
export function prepareCampaignOpenRouterProviderRequest(
  input: Omit<PrepareProviderRequestInput, 'body'> & {
    bodyObject: Record<string, unknown>
  },
): PreparedProviderRequest {
  const wired = applyCampaignOpenRouterWireBody(input.bodyObject, input.sentModelId ?? input.requestedModelId)
  const { bodyObject: _bodyObject, ...rest } = input
  return prepareProviderRequest({
    ...rest,
    body: JSON.stringify(wired),
  })
}

export function assertCampaignOpenRouterWireFrozen(prepared: PreparedProviderRequest): void {
  if (prepared.provider !== 'openrouter') return
  assertCampaignQualifiedPreparedRequest(prepared)
  const expected = buildCampaignOpenRouterProviderWire(prepared.sent_model_id)
  const parsed = JSON.parse(prepared.body) as Record<string, unknown>
  const provider = readProviderWire(parsed)
  if (!provider) {
    throw new Error('campaign openrouter wire missing provider block')
  }
  if (provider.allow_fallbacks !== expected.allow_fallbacks) {
    throw new Error('campaign openrouter wire allow_fallbacks mismatch')
  }
  if (provider.require_parameters !== expected.require_parameters) {
    throw new Error('campaign openrouter wire require_parameters mismatch')
  }
  const maxPrice = readMaxPrice(provider)
  if (!maxPrice) {
    throw new Error('campaign openrouter wire missing nested max_price')
  }
  if (
    maxPrice.prompt !== expected.max_price.prompt ||
    maxPrice.completion !== expected.max_price.completion ||
    maxPrice.request !== expected.max_price.request
  ) {
    throw new Error('campaign openrouter wire max_price mismatch')
  }
}
