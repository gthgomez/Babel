import assert from 'node:assert/strict'
import test from 'node:test'
import { estimateProviderUsageCost } from '../services/modelPricingRegistry.js'
import { prepareProviderRequest } from '../runners/preparedProviderRequest.js'
import {
  CAMPAIGN_QUALIFIED_COMMAND_CODE_MODEL_ID,
  CAMPAIGN_QUALIFIED_OPENROUTER_MODEL_ID,
} from './campaign-qualified-routes.js'
import { CAMPAIGN_QUALIFIED_OPENROUTER_MAX_INPUT_CONTEXT_TOKENS } from './campaign-qualified-context.js'
import { reservationUpperBoundMicroUsd } from './campaign-metering.js'
import { campaignOpenRouterRegistryMaxPriceUsdPerMillion } from './campaign-openrouter-wire.js'
import {
  campaignLegacyReservationRateContentHash,
  legacyReservationUpperBoundMicroUsd,
  resolveCampaignLegacyReservationRates,
} from './campaign-legacy-reservation-rates.js'

test('legacy reservation table decouples caps from divergent usage-estimate inputs', () => {
  const legacy = resolveCampaignLegacyReservationRates(
    'openrouter',
    CAMPAIGN_QUALIFIED_OPENROUTER_MODEL_ID,
  )
  assert.ok(legacy)
  const promptTokens = 10_000
  const completionTokens = 500
  const holdFromTable = legacyReservationUpperBoundMicroUsd(
    legacy,
    promptTokens,
    completionTokens,
  )
  const estimate = estimateProviderUsageCost({
    provider: 'openrouter',
    modelId: CAMPAIGN_QUALIFIED_OPENROUTER_MODEL_ID,
    promptTokens,
    completionTokens,
  })
  assert.equal(holdFromTable, legacyReservationUpperBoundMicroUsd(legacy, promptTokens, completionTokens))
  const divergentEstimateMicro = Math.ceil(
    ((promptTokens / 1_000_000) * 0.01 + (completionTokens / 1_000_000) * 0.01) * 1_000_000,
  )
  assert.notEqual(divergentEstimateMicro, holdFromTable)
  assert.notEqual(
    Math.ceil((estimate.estimatedCostUsd ?? 0) * 1_000_000),
    divergentEstimateMicro,
  )
  const wire = campaignOpenRouterRegistryMaxPriceUsdPerMillion(CAMPAIGN_QUALIFIED_OPENROUTER_MODEL_ID)
  assert.equal(wire.prompt, legacy.inputUsdPerMillion)
  assert.equal(wire.completion, legacy.outputUsdPerMillion)
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
})

test('missing legacy reservation policy rejects unknown qualified route key', () => {
  assert.equal(resolveCampaignLegacyReservationRates('openrouter', 'not-a-campaign-model'), null)
  assert.throws(
    () => campaignOpenRouterRegistryMaxPriceUsdPerMillion('not-a-campaign-model'),
    /campaign legacy reservation rates unknown/,
  )
})

test('legacy rate identity hash includes substantive configured provenance', () => {
  const legacy = resolveCampaignLegacyReservationRates(
    'openrouter',
    CAMPAIGN_QUALIFIED_OPENROUTER_MODEL_ID,
  )
  assert.ok(legacy)
  const baseHash = campaignLegacyReservationRateContentHash(legacy)
  const changedHash = campaignLegacyReservationRateContentHash({
    ...legacy,
    configurationSource: `${legacy.configurationSource}#drift`,
  })
  assert.notEqual(baseHash, changedHash)
})
