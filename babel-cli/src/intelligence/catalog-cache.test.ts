import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import {
  catalogCacheKey,
  catalogCachePath,
  readCatalogCache,
  writeCatalogCache,
  type CatalogCacheIdentity,
} from './catalog-cache.js'
import { createCatalogSnapshot } from './catalog.js'
import { OPENROUTER_MODELS_URL } from './openrouterMetadata.js'
import type { CatalogSnapshot } from './types.js'

const OBSERVED_AT = '2026-10-06T00:00:00.000Z'

function identity(overrides: Partial<CatalogCacheIdentity> = {}): CatalogCacheIdentity {
  return {
    sourceId: 'openrouter-catalog',
    endpoint: OPENROUTER_MODELS_URL,
    credentialScope: 'account-revision-1',
    ...overrides,
  }
}

function snapshot(providerModelId: string, contextTokens: number): CatalogSnapshot {
  return createCatalogSnapshot({
    observedAt: OBSERVED_AT,
    sourceResults: [
      {
        sourceId: 'openrouter-catalog',
        status: 'ok',
        completeness: 'complete',
        fetchedAt: OBSERVED_AT,
      },
    ],
    labModels: [],
    providerModels: [
      {
        schemaVersion: 1,
        provider: 'openrouter',
        canonicalModelId: providerModelId,
        providerModelId,
        protocolProfiles: [],
        providerLimits: { contextTokens },
        lifecycle: { status: 'active' },
        sourceEvidence: [{ source: 'provider_api', retrievedAt: OBSERVED_AT }],
        observedEvidence: [],
      },
    ],
  })
}

test('atomic_cache_replacement', async () => {
  const root = await mkdtemp(join(process.cwd(), '.catalog-cache-test-'))
  try {
    const id = identity()
    const first = snapshot('z-ai/glm-5.3-flash', 1_310_720)
    const second = snapshot('z-ai/glm-5.3-flash', 1_000_000)
    assert.notEqual(first.revision, second.revision)

    const writtenFirst = await writeCatalogCache({
      directory: root,
      identity: id,
      snapshot: first,
      writtenAt: OBSERVED_AT,
      status: 'ok',
      completeness: 'complete',
    })
    assert.equal(writtenFirst.replaced, false)
    assert.equal((await readCatalogCache({ directory: root, identity: id }))?.snapshot.revision, first.revision)

    const writtenSecond = await writeCatalogCache({
      directory: root,
      identity: id,
      snapshot: second,
      writtenAt: '2026-10-07T00:00:00.000Z',
      status: 'ok',
      completeness: 'complete',
    })
    assert.equal(writtenSecond.replaced, true)
    assert.equal(
      (await readCatalogCache({ directory: root, identity: id }))?.snapshot.revision,
      second.revision,
    )

    // Atomic replace leaves one complete file and no temporary artifacts.
    const files = await readdir(root)
    assert.deepEqual(files.sort(), [catalogCachePath(root, id).split('/').at(-1)])

    // A non-authoritative observation must not replace last-known-good.
    const retained = await writeCatalogCache({
      directory: root,
      identity: id,
      snapshot: first,
      writtenAt: '2026-10-08T00:00:00.000Z',
      status: 'partial',
      completeness: 'partial',
    })
    assert.equal(retained.retainedPrevious, true)
    assert.equal(retained.replaced, false)
    assert.equal(
      (await readCatalogCache({ directory: root, identity: id }))?.snapshot.revision,
      second.revision,
    )

    // Identity includes the non-secret credential scope: distinct scopes do not
    // share a cache entry or eligibility.
    const otherScope = identity({ credentialScope: 'account-revision-2' })
    assert.notEqual(catalogCacheKey(id), catalogCacheKey(otherScope))
    assert.equal(await readCatalogCache({ directory: root, identity: otherScope }), undefined)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('cache_identity_requires_source_and_endpoint', () => {
  assert.throws(() => catalogCacheKey({ sourceId: '', endpoint: OPENROUTER_MODELS_URL }))
  assert.throws(() => catalogCacheKey({ sourceId: 'openrouter-catalog', endpoint: '' }))
})
