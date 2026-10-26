import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyCampaignOpenRouterWireBody,
  assertCampaignOpenRouterWireFrozen,
  buildCampaignOpenRouterProviderWire,
  CAMPAIGN_OPENROUTER_MAX_PRICE_REQUEST_USD,
  prepareCampaignOpenRouterProviderRequest,
} from './campaign-openrouter-wire.js'
import { CAMPAIGN_QUALIFIED_OPENROUTER_MODEL_ID } from './campaign-qualified-routes.js'

test('campaign openrouter wire uses nested max_price USD per million tokens', () => {
  const wire = buildCampaignOpenRouterProviderWire(CAMPAIGN_QUALIFIED_OPENROUTER_MODEL_ID)
  assert.equal(wire.allow_fallbacks, false)
  assert.equal(wire.require_parameters, true)
  assert.equal(wire.max_price.prompt, 0.14)
  assert.equal(wire.max_price.completion, 0.28)
  assert.equal(wire.max_price.request, CAMPAIGN_OPENROUTER_MAX_PRICE_REQUEST_USD)
  const body = applyCampaignOpenRouterWireBody({
    model: CAMPAIGN_QUALIFIED_OPENROUTER_MODEL_ID,
    max_tokens: 16,
    messages: [{ role: 'user', content: 'hi' }],
  }, CAMPAIGN_QUALIFIED_OPENROUTER_MODEL_ID)
  const serialized = JSON.stringify(body)
  assert.equal(
    serialized,
    `{"model":"${CAMPAIGN_QUALIFIED_OPENROUTER_MODEL_ID}","max_tokens":16,"messages":[{"role":"user","content":"hi"}],"provider":{"allow_fallbacks":false,"require_parameters":true,"max_price":{"prompt":0.14,"completion":0.28,"request":0}}}`,
  )
  const prepared = prepareCampaignOpenRouterProviderRequest({
    bodyObject: JSON.parse(serialized) as Record<string, unknown>,
    mode: 'text',
    provider: 'openrouter',
    requestedModelId: CAMPAIGN_QUALIFIED_OPENROUTER_MODEL_ID,
    reservedCompletionTokens: 16,
  })
  assert.equal(prepared.body, serialized)
  assertCampaignOpenRouterWireFrozen(prepared)
})

test('gate rejects openrouter campaign body missing frozen provider caps', () => {
  const prepared = prepareCampaignOpenRouterProviderRequest({
    bodyObject: {
      model: CAMPAIGN_QUALIFIED_OPENROUTER_MODEL_ID,
      max_tokens: 8,
      messages: [{ role: 'user', content: 'x' }],
    },
    mode: 'text',
    provider: 'openrouter',
    requestedModelId: CAMPAIGN_QUALIFIED_OPENROUTER_MODEL_ID,
    reservedCompletionTokens: 8,
  })
  const tampered = {
    ...prepared,
    body: JSON.stringify({
      model: CAMPAIGN_QUALIFIED_OPENROUTER_MODEL_ID,
      max_tokens: 8,
      messages: [{ role: 'user', content: 'x' }],
    }),
  }
  assert.throws(() => assertCampaignOpenRouterWireFrozen(tampered))
})

test('serialized campaign wire rejects max_price missing request zero cap', () => {
  const prepared = prepareCampaignOpenRouterProviderRequest({
    bodyObject: {
      model: CAMPAIGN_QUALIFIED_OPENROUTER_MODEL_ID,
      max_tokens: 8,
      messages: [{ role: 'user', content: 'x' }],
    },
    mode: 'text',
    provider: 'openrouter',
    requestedModelId: CAMPAIGN_QUALIFIED_OPENROUTER_MODEL_ID,
    reservedCompletionTokens: 8,
  })
  const parsed = JSON.parse(prepared.body) as {
    provider?: { max_price?: { prompt?: number; completion?: number; request?: number } }
  }
  delete parsed.provider?.max_price?.request
  const tampered = { ...prepared, body: JSON.stringify(parsed) }
  assert.throws(() => assertCampaignOpenRouterWireFrozen(tampered))
})
