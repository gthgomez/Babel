import assert from 'node:assert/strict'
import test from 'node:test'

import { createCatalogSnapshot } from './catalog.js'
import { estimateProviderUsageCost } from '../services/modelPricingRegistry.js'
import {
  buildPriceQuote,
  computeQuoteCostUsd,
  resolvePriceQuote,
} from './price-quote.js'

function quote(overrides: {
  modelId: string
  inputCost: number | null
  outputCost: number | null
  upstream?: string
  provider?: string
  cacheReadCost?: number | null
  cacheWriteCost?: number | null
}) {
  return buildPriceQuote({
    provider: overrides.provider ?? 'openrouter',
    modelId: overrides.modelId,
    unit: 'usd_per_million_tokens',
    currency: 'USD',
    inputCost: overrides.inputCost,
    outputCost: overrides.outputCost,
    cacheReadCost: overrides.cacheReadCost ?? null,
    cacheWriteCost: overrides.cacheWriteCost ?? null,
    cacheDiscountAvailable: overrides.cacheReadCost !== undefined && overrides.cacheReadCost !== null,
    conditions: overrides.upstream === undefined ? {} : { upstream: overrides.upstream },
    sourceUrl: 'https://example.test/pricing',
    verifiedAt: '2026-01-01',
  })
}

test('per_token_conversion_is_exactly_once', () => {
  // Per-million facts normalize to per-token by one division, and one million
  // tokens costs exactly the stated per-million rate (no double conversion).
  const resolved = resolvePriceQuote({ provider: 'deepseek', modelId: 'deepseek-v4-flash' })
  assert.equal(resolved.status, 'exact')
  assert.ok(resolved.perToken)
  assert.equal(resolved.perToken.input, 0.14 / 1_000_000)
  assert.equal(resolved.perToken.cacheRead, 0.0028 / 1_000_000)

  const cost = computeQuoteCostUsd(resolved.quote!, {
    promptTokens: 1_000_000,
    completionTokens: 1_000_000,
  })
  assert.ok(Math.abs((cost.inputCostUsd ?? 0) - 0.14) < 1e-12)
  assert.ok(Math.abs((cost.outputCostUsd ?? 0) - 0.28) < 1e-12)
  assert.ok(Math.abs((cost.estimatedCostUsd ?? 0) - 0.42) < 1e-12)

  // A catalog per-token quote passes through unchanged rather than being
  // multiplied up to per-million and back down.
  const catalog = createCatalogSnapshot({
    observedAt: '2026-01-02T00:00:00.000Z',
    sourceResults: [],
    labModels: [],
    providerModels: [
      {
        schemaVersion: 1,
        provider: 'openrouter',
        canonicalModelId: 'example/model',
        providerModelId: 'example/model',
        protocolProfiles: [],
        providerLimits: {},
        pricing: { inputPerToken: 0.000001, outputPerToken: 0.000002 },
        lifecycle: { status: 'active' },
        sourceEvidence: [],
        observedEvidence: [],
      },
    ],
  })
  const catalogResolved = resolvePriceQuote({
    provider: 'openrouter',
    modelId: 'example/model',
    catalog,
  })
  assert.equal(catalogResolved.status, 'exact')
  assert.equal(catalogResolved.perToken?.input, 0.000001)
  assert.equal(catalogResolved.perToken?.output, 0.000002)
})

test('unknown_upstream_has_no_exact_price', () => {
  const routed = quote({ modelId: 'routed/model', inputCost: 1, outputCost: 2, upstream: 'ProviderA' })

  const noRoute = resolvePriceQuote({
    provider: 'openrouter',
    modelId: 'routed/model',
    quotes: [routed],
  })
  assert.equal(noRoute.status, 'unknown')
  assert.equal(noRoute.quote, null)
  assert.equal(noRoute.perToken, null)
  assert.match(noRoute.reason ?? '', /served route/)

  const wrongRoute = resolvePriceQuote({
    provider: 'openrouter',
    modelId: 'routed/model',
    upstream: 'ProviderB',
    quotes: [routed],
  })
  assert.equal(wrongRoute.status, 'unknown')

  const exactRoute = resolvePriceQuote({
    provider: 'openrouter',
    modelId: 'routed/model',
    upstream: 'ProviderA',
    quotes: [routed],
  })
  assert.equal(exactRoute.status, 'exact')
  assert.equal(exactRoute.quote?.inputCost, 1)
})

test('price_refresh_preserves_historical_charge', () => {
  const oldQuote = quote({ modelId: 'refresh/model', inputCost: 1, outputCost: 2 })
  const newQuote = quote({ modelId: 'refresh/model', inputCost: 5, outputCost: 6 })
  assert.notEqual(oldQuote.quoteRevision, newQuote.quoteRevision)

  // A charge recorded before the refresh pins the old revision and must not be
  // retroactively repriced by the new table.
  const historical = resolvePriceQuote({
    provider: 'openrouter',
    modelId: 'refresh/model',
    quoteRevision: oldQuote.quoteRevision,
    quotes: [oldQuote, newQuote],
  })
  assert.equal(historical.status, 'exact')
  assert.equal(historical.quote?.inputCost, 1)
  assert.equal(historical.quoteRevision, oldQuote.quoteRevision)

  // Future estimates use the refreshed quote.
  const future = resolvePriceQuote({
    provider: 'openrouter',
    modelId: 'refresh/model',
    quotes: [newQuote],
  })
  assert.equal(future.status, 'exact')
  assert.equal(future.quote?.inputCost, 5)
  assert.equal(future.quoteRevision, newQuote.quoteRevision)
})

test('unknown_components_are_not_coerced_to_zero', () => {
  const partial = quote({ modelId: 'partial/model', inputCost: null, outputCost: 4 })
  const resolved = resolvePriceQuote({
    provider: 'openrouter',
    modelId: 'partial/model',
    quotes: [partial],
  })
  assert.equal(resolved.status, 'exact')
  assert.equal(resolved.perToken?.input, null)
  const cost = computeQuoteCostUsd(partial, { promptTokens: 10, completionTokens: 10 })
  assert.equal(cost.inputCostUsd, null)
  assert.ok(Math.abs((cost.outputCostUsd ?? 0) - 0.00004) < 1e-15)

  const missing = resolvePriceQuote({ provider: 'openrouter', modelId: 'not/registered' })
  assert.equal(missing.status, 'unknown')
  assert.equal(missing.perToken, null)
})

test('partial_cache_split_is_not_exact', () => {
  const resolved = resolvePriceQuote({ provider: 'deepseek', modelId: 'deepseek-v4-flash' })
  assert.equal(resolved.status, 'exact')
  const flash = resolved.quote!

  // Only the cache-hit side of the split was observed. The miss side is
  // unknown, so the input cost is unknown: pricing the hit side alone would
  // silently understate the call and look exact.
  const hitOnly = computeQuoteCostUsd(flash, { cacheHitTokens: 1000 })
  assert.equal(hitOnly.inputCostUsd, null)
  assert.equal(hitOnly.estimatedCostUsd, null)

  // Same when only the miss side is observed; the hit side is unknown, not 0.
  const missOnly = computeQuoteCostUsd(flash, { cacheMissTokens: 1000 })
  assert.equal(missOnly.inputCostUsd, null)

  // When the prompt total is also known the missing side is derivable and the
  // full split prices exactly.
  const derivable = computeQuoteCostUsd(flash, { promptTokens: 1000, cacheHitTokens: 400 })
  const expectedInput = (400 * 0.0028) / 1_000_000 + (600 * 0.14) / 1_000_000
  assert.ok(derivable.inputCostUsd !== null)
  assert.ok(Math.abs(derivable.inputCostUsd - expectedInput) < 1e-15)

  // The legacy estimate surface must never report `exact` while an observed
  // input component could not be priced; the total is unknown, not a lower
  // bound that could be mistaken for the whole charge.
  const unknownTotal = estimateProviderUsageCost({
    provider: 'deepseek',
    modelId: 'deepseek-v4-flash',
    promptCacheHitTokens: 1000,
  })
  assert.equal(unknownTotal.estimatedCostUsd, null)
  assert.equal(unknownTotal.inputCostUsd, null)
  assert.notEqual(unknownTotal.precision, 'exact')

  const outputKnown = estimateProviderUsageCost({
    provider: 'deepseek',
    modelId: 'deepseek-v4-flash',
    promptCacheHitTokens: 1000,
    completionTokens: 2000,
  })
  assert.equal(outputKnown.inputCostUsd, null)
  assert.equal(outputKnown.estimatedCostUsd, null)
  assert.notEqual(outputKnown.precision, 'exact')
})
