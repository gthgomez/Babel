import assert from 'node:assert/strict'
import test from 'node:test'

import { composeCatalogSnapshot, normalizeCatalog, validateCatalogFreshness } from './catalog-normalize.js'
import { findModelProfile } from './catalog.js'
import type { OpenRouterModelEntry } from './openrouterMetadata.js'
import type { ModelRef } from './model-ref.js'

const FETCHED_AT = '2026-08-29T00:00:00.000Z'

function entry(id: string, overrides: Partial<OpenRouterModelEntry> = {}): OpenRouterModelEntry {
  return { id, ...overrides }
}

function completeBatch(models: readonly OpenRouterModelEntry[]) {
  return normalizeCatalog({
    sourceId: 'openrouter-catalog',
    status: 'ok',
    completeness: 'complete',
    fetchedAt: FETCHED_AT,
    models,
  })
}

function partialBatch(models: readonly OpenRouterModelEntry[]) {
  return normalizeCatalog({
    sourceId: 'openrouter-catalog',
    status: 'partial',
    completeness: 'partial',
    fetchedAt: '2026-10-06T00:00:00.000Z',
    models,
  })
}

test('partial_catalog_does_not_retire_model', () => {
  const modelA = entry('z-ai/glm-5.3-flash', {
    canonical_slug: 'z-ai/glm-5.3-flash',
    context_length: 1_310_720,
    top_provider: { context_length: 1_048_576, max_completion_tokens: 131_072 },
  })
  const modelB = entry('deepseek/deepseek-v4-pro', {
    canonical_slug: 'deepseek/deepseek-v4-pro',
    context_length: 1_000_000,
    top_provider: { context_length: 1_000_000, max_completion_tokens: 384_000 },
  })
  const previous = composeCatalogSnapshot(undefined, completeBatch([modelA, modelB]))

  const refA: ModelRef = { provider: 'openrouter', modelId: 'z-ai/glm-5.3-flash' }
  const refB: ModelRef = { provider: 'openrouter', modelId: 'deepseek/deepseek-v4-pro' }
  assert.ok(findModelProfile(previous, refA))
  assert.ok(findModelProfile(previous, refB))

  // A partial read that only saw model A must not retire model B.
  const partial = composeCatalogSnapshot(previous, partialBatch([modelA]))
  assert.ok(findModelProfile(partial, refA))
  const preserved = findModelProfile(partial, refB)
  assert.ok(preserved, 'partial catalog must not retire an unobserved model')
  assert.equal(preserved.lifecycle.status, 'active')
  assert.equal(
    partial.sourceResults[0]?.status,
    'partial',
    'partial completeness is recorded, not silently upgraded',
  )
})

test('complete_authoritative_catalog_can_remove_models', () => {
  // A successful complete read is authoritative: absence may mean removal.
  const previous = composeCatalogSnapshot(
    undefined,
    completeBatch([
      entry('z-ai/glm-5.3-flash', { canonical_slug: 'z-ai/glm-5.3-flash' }),
      entry('deepseek/deepseek-v4-pro', { canonical_slug: 'deepseek/deepseek-v4-pro' }),
    ]),
  )
  const next = composeCatalogSnapshot(
    previous,
    completeBatch([entry('z-ai/glm-5.3-flash', { canonical_slug: 'z-ai/glm-5.3-flash' })]),
  )
  assert.ok(findModelProfile(next, { provider: 'openrouter', modelId: 'z-ai/glm-5.3-flash' }))
  assert.equal(
    findModelProfile(next, { provider: 'openrouter', modelId: 'deepseek/deepseek-v4-pro' }),
    undefined,
  )
})

test('limits_only_metadata_gets_provenance_check', () => {
  // This entry advertises only limits: no pricing, no capabilities, no
  // supported_parameters. It must still be validated, not skipped because it
  // lacks an incidental price/capability array.
  const batch = normalizeCatalog({
    sourceId: 'openrouter-catalog',
    status: 'ok',
    completeness: 'complete',
    fetchedAt: FETCHED_AT,
    models: [
      entry('z-ai/glm-5.3-flash', {
        context_length: 1_310_720,
        top_provider: { context_length: 1_048_576, max_completion_tokens: 131_072 },
      }),
    ],
  })
  const lab = batch.labModels[0]
  const provider = batch.providerModels[0]
  assert.ok(lab)
  assert.ok(provider)
  assert.equal(Object.keys(lab.nativeCapabilities).length, 0, 'limits-only model has no capabilities')
  assert.deepEqual(provider.pricing, {}, 'limits-only model has no pricing')

  const fresh = validateCatalogFreshness({ batch, now: new Date(FETCHED_AT) })
  assert.equal(fresh.status, 'pass')

  const stale = validateCatalogFreshness({
    batch,
    now: new Date('2027-01-01T00:00:00.000Z'),
  })
  assert.equal(stale.status, 'fail', 'limits-only metadata must be freshness-checked')
  assert.ok(
    stale.issues.some(
      (issue) =>
        issue.includes('lab:z-ai/glm-5.3-flash.limits') &&
        issue.includes('older than the freshness window'),
    ),
    `expected a limits freshness issue, received: ${JSON.stringify(stale.issues)}`,
  )
})
