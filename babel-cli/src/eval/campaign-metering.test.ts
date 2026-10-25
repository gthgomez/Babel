import assert from 'node:assert/strict'
import test from 'node:test'
import { prepareProviderRequest } from '../runners/preparedProviderRequest.js'
import { actualMicroUsdFromUsage, reservationUpperBoundMicroUsd } from './campaign-metering.js'
import { LIVE_OPENROUTER_MODEL_ID } from '../modelPolicy.js'

test('reservation upper bound uses frozen body without fudge multipliers', () => {
  const prepared = prepareProviderRequest({
    body: JSON.stringify({
      model: LIVE_OPENROUTER_MODEL_ID,
      max_tokens: 32,
      messages: [{ role: 'user', content: 'hello campaign bound' }],
    }),
    mode: 'text',
    provider: 'openrouter',
    requestedModelId: LIVE_OPENROUTER_MODEL_ID,
    reservedCompletionTokens: 32,
  })
  const micro = reservationUpperBoundMicroUsd(prepared)
  assert.ok(micro > 0)
  assert.equal(micro, reservationUpperBoundMicroUsd(prepared))
})

test('actualMicroUsdFromUsage ignores registry estimates masquerading as exact cost', () => {
  assert.equal(
    actualMicroUsdFromUsage({
      provider: 'openrouter',
      modelId: LIVE_OPENROUTER_MODEL_ID,
      promptTokens: 10,
      completionTokens: 5,
      costPrecision: 'conservative',
    }),
    'unknown',
  )
})

test('actualMicroUsdFromUsage accepts provider-reported total charges only', () => {
  assert.equal(
    actualMicroUsdFromUsage({
      provider: 'openrouter',
      modelId: LIVE_OPENROUTER_MODEL_ID,
      promptTokens: 10,
      completionTokens: 5,
      providerReportedTotalChargeUsd: 0.000012,
      costPrecision: 'exact',
    }),
    12,
  )
})

test('partial native usage without completion tokens stays unknown', () => {
  assert.equal(
    actualMicroUsdFromUsage({
      provider: 'openrouter',
      modelId: LIVE_OPENROUTER_MODEL_ID,
      promptTokens: 10,
      completionTokens: null,
      costPrecision: 'exact',
    }),
    'unknown',
  )
})
