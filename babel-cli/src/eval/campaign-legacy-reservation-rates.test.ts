import assert from 'node:assert/strict'
import test from 'node:test'
import {
  estimateProviderUsageCost,
  MODEL_PRICING_REGISTRY,
} from '../services/modelPricingRegistry.js'
import { prepareProviderRequest } from '../runners/preparedProviderRequest.js'
import {
  CAMPAIGN_QUALIFIED_COMMAND_CODE_MODEL_ID,
  CAMPAIGN_QUALIFIED_OPENROUTER_MODEL_ID,
} from './campaign-qualified-routes.js'
import { CAMPAIGN_QUALIFIED_OPENROUTER_MAX_INPUT_CONTEXT_TOKENS } from './campaign-qualified-context.js'
import { reservationUpperBoundMicroUsd } from './campaign-metering.js'
import { campaignOpenRouterRegistryMaxPriceUsdPerMillion } from './campaign-openrouter-wire.js'
import {
  CAMPAIGN_LEGACY_RESERVATION_BASELINE_ADOPTION_SOURCE,
  CAMPAIGN_LEGACY_RESERVATION_RATES_OWNER,
  campaignLegacyReservationRateContentHash,
  legacyReservationUpperBoundMicroUsd,
  resolveCampaignLegacyReservationRates,
} from './campaign-legacy-reservation-rates.js'

test('usage estimate registry drift does not move legacy wire or campaign hold', () => {
  const registryKey = `openrouter:${CAMPAIGN_QUALIFIED_OPENROUTER_MODEL_ID}`
  const registryEntry = MODEL_PRICING_REGISTRY[registryKey]
  assert.ok(registryEntry)
  const priorInput = registryEntry.inputCostPer1M
  const priorOutput = registryEntry.outputCostPer1M

  const promptTokens = 10_000
  const completionTokens = 500
  const prepared = prepareProviderRequest({
    body: JSON.stringify({
      model: CAMPAIGN_QUALIFIED_OPENROUTER_MODEL_ID,
      max_tokens: completionTokens,
      messages: [{ role: 'user', content: 'hold' }],
    }),
    mode: 'text',
    provider: 'openrouter',
    requestedModelId: CAMPAIGN_QUALIFIED_OPENROUTER_MODEL_ID,
    reservedCompletionTokens: completionTokens,
  })

  const wireBefore = campaignOpenRouterRegistryMaxPriceUsdPerMillion(
    CAMPAIGN_QUALIFIED_OPENROUTER_MODEL_ID,
  )
  const holdBefore = reservationUpperBoundMicroUsd(prepared)
  const estimateBefore = estimateProviderUsageCost({
    provider: 'openrouter',
    modelId: CAMPAIGN_QUALIFIED_OPENROUTER_MODEL_ID,
    promptTokens,
    completionTokens,
  })

  try {
    registryEntry.inputCostPer1M = 0.01
    registryEntry.outputCostPer1M = 0.01
    const estimateAfter = estimateProviderUsageCost({
      provider: 'openrouter',
      modelId: CAMPAIGN_QUALIFIED_OPENROUTER_MODEL_ID,
      promptTokens,
      completionTokens,
    })
    assert.notEqual(estimateBefore.estimatedCostUsd, estimateAfter.estimatedCostUsd)

    const wireAfter = campaignOpenRouterRegistryMaxPriceUsdPerMillion(
      CAMPAIGN_QUALIFIED_OPENROUTER_MODEL_ID,
    )
    const holdAfter = reservationUpperBoundMicroUsd(prepared)
    assert.equal(wireAfter.prompt, wireBefore.prompt)
    assert.equal(wireAfter.completion, wireBefore.completion)
    assert.equal(holdAfter, holdBefore)
    assert.equal(wireAfter.prompt, 0.14)
    assert.equal(wireAfter.completion, 0.28)
  } finally {
    registryEntry.inputCostPer1M = priorInput
    registryEntry.outputCostPer1M = priorOutput
  }
})

test('reservation upper bound uses legacy ceiling table not estimate registry path', () => {
  const legacy = resolveCampaignLegacyReservationRates(
    'openrouter',
    CAMPAIGN_QUALIFIED_OPENROUTER_MODEL_ID,
  )
  assert.ok(legacy)
  const prepared = prepareProviderRequest({
    body: JSON.stringify({
      model: CAMPAIGN_QUALIFIED_OPENROUTER_MODEL_ID,
      max_tokens: 32,
      messages: [{ role: 'user', content: 'hold' }],
    }),
    mode: 'text',
    provider: 'openrouter',
    requestedModelId: CAMPAIGN_QUALIFIED_OPENROUTER_MODEL_ID,
    reservedCompletionTokens: 32,
  })
  const expected = legacyReservationUpperBoundMicroUsd(
    legacy,
    CAMPAIGN_QUALIFIED_OPENROUTER_MAX_INPUT_CONTEXT_TOKENS,
    32,
  )
  assert.equal(reservationUpperBoundMicroUsd(prepared), expected)
})

test('command code legacy rates stay non-certifying conservative reservation', () => {
  const legacy = resolveCampaignLegacyReservationRates(
    'command-code',
    CAMPAIGN_QUALIFIED_COMMAND_CODE_MODEL_ID,
  )
  assert.ok(legacy)
  assert.equal(legacy.role, 'legacy_non_certifying_reservation')
  assert.equal(legacy.inputUsdPerMillion, 0.3)
  assert.equal(legacy.outputUsdPerMillion, 1.2)
  assert.equal(legacy.baselineAdoptionSource, CAMPAIGN_LEGACY_RESERVATION_BASELINE_ADOPTION_SOURCE)
})

test('missing legacy reservation policy rejects unknown qualified route key', () => {
  assert.equal(resolveCampaignLegacyReservationRates('openrouter', 'not-a-campaign-model'), null)
  assert.throws(
    () => campaignOpenRouterRegistryMaxPriceUsdPerMillion('not-a-campaign-model'),
    /campaign legacy reservation rates unknown/,
  )
})

test('legacy rate identity hash includes owner, role, and adoption provenance', () => {
  const legacy = resolveCampaignLegacyReservationRates(
    'openrouter',
    CAMPAIGN_QUALIFIED_OPENROUTER_MODEL_ID,
  )
  assert.ok(legacy)
  const baseHash = campaignLegacyReservationRateContentHash(legacy)
  assert.notEqual(
    baseHash,
    campaignLegacyReservationRateContentHash({
      ...legacy,
      baselineAdoptionSource: `${legacy.baselineAdoptionSource}#drift`,
    }),
  )
  assert.notEqual(
    baseHash,
    campaignLegacyReservationRateContentHash({
      ...legacy,
      owner: 'campaign_legacy_reservation_ceiling_table_v0' as typeof CAMPAIGN_LEGACY_RESERVATION_RATES_OWNER,
    }),
  )
  assert.notEqual(
    baseHash,
    campaignLegacyReservationRateContentHash({
      ...legacy,
      role: 'legacy_non_certifying_reservation_drift' as typeof legacy.role,
    }),
  )
})
