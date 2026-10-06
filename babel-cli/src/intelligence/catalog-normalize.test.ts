import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { composeCatalogSnapshot, normalizeCatalog, validateCatalogFreshness } from './catalog-normalize.js'
import { findModelProfile } from './catalog.js'
import { OPENROUTER_MODELS_URL, type OpenRouterModelEntry } from './openrouterMetadata.js'
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

test('complete_read_of_another_source_retains_foreign_models', () => {
  const modelA = entry('meta/llama-4-scout', { canonical_slug: 'meta/llama-4-scout' })
  const modelB = entry('z-ai/glm-5.3-flash', { canonical_slug: 'z-ai/glm-5.3-flash' })

  const sourceA = normalizeCatalog({
    sourceId: 'source-a',
    scopeId: 'scope-a',
    status: 'ok',
    completeness: 'complete',
    fetchedAt: FETCHED_AT,
    models: [modelA],
  })
  // A partial read of source B merges rather than retiring, so both sources
  // coexist in the previous snapshot.
  const sourceBPartial = normalizeCatalog({
    sourceId: 'source-b',
    scopeId: 'scope-b',
    status: 'partial',
    completeness: 'partial',
    fetchedAt: '2026-10-06T00:00:00.000Z',
    models: [modelB],
  })
  const previous = composeCatalogSnapshot(composeCatalogSnapshot(undefined, sourceA), sourceBPartial)
  assert.ok(findModelProfile(previous, { provider: 'openrouter', modelId: 'meta/llama-4-scout' }))
  assert.ok(findModelProfile(previous, { provider: 'openrouter', modelId: 'z-ai/glm-5.3-flash' }))

  // A complete read of source B must not retire a model owned only by source A.
  const sourceBComplete = normalizeCatalog({
    sourceId: 'source-b',
    scopeId: 'scope-b',
    status: 'ok',
    completeness: 'complete',
    fetchedAt: '2026-10-06T00:00:01.000Z',
    models: [modelB],
  })
  const next = composeCatalogSnapshot(previous, sourceBComplete)

  assert.ok(
    findModelProfile(next, { provider: 'openrouter', modelId: 'meta/llama-4-scout' }),
    'a complete read of source B must not retire a model observed only from source A',
  )
  assert.ok(findModelProfile(next, { provider: 'openrouter', modelId: 'z-ai/glm-5.3-flash' }))
  assert.equal(
    next.sourceResults.find((result) => result.sourceId === 'source-b')?.completeness,
    'complete',
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

test('generated_catalog_documents_generator_provenance', async () => {
  const raw = await readFile(
    new URL('../../../config/model-catalog.generated.json', import.meta.url),
    'utf8',
  )
  const parsed = JSON.parse(raw) as {
    _provenance?: {
      generatedBy?: string
      generatorVersion?: number
      source?: string
      network?: boolean
      command?: string
    }
    revision?: string
    providerModels?: unknown[]
  }
  assert.equal(
    parsed._provenance?.generatedBy,
    'babel-cli/scripts/generate_model_catalog.ts',
    'the committed catalog must name its in-tree generator',
  )
  assert.equal(parsed._provenance?.source, OPENROUTER_MODELS_URL)
  assert.equal(parsed._provenance?.network, false)
  assert.equal(parsed._provenance?.generatorVersion, 1)
  assert.equal(typeof parsed._provenance?.command, 'string')
  assert.equal(typeof parsed.revision, 'string')
  assert.equal(parsed.providerModels?.length, 3)
})
