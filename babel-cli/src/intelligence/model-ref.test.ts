import assert from 'node:assert/strict'
import test from 'node:test'

import { findModelProfile, createCatalogSnapshot } from './catalog.js'
import { modelRefKey, type ModelRef } from './model-ref.js'
import type { CatalogSnapshotInput } from './types.js'

function snapshotInput(providerModelIds: readonly string[]): CatalogSnapshotInput {
  return {
    observedAt: '2026-10-06T00:00:00.000Z',
    sourceResults: [
      {
        sourceId: 'identity-test',
        status: 'ok',
        completeness: 'complete',
        fetchedAt: '2026-10-06T00:00:00.000Z',
      },
    ],
    labModels: [],
    providerModels: providerModelIds.map((providerModelId) => ({
      schemaVersion: 1,
      provider: 'openrouter',
      canonicalModelId: 'z-ai/glm-5.3-flash',
      providerModelId,
      protocolProfiles: [],
      providerLimits: {},
      lifecycle: { status: 'active' },
      sourceEvidence: [{ source: 'provider_api', retrievedAt: '2026-10-06T00:00:00.000Z' }],
      observedEvidence: [],
    })),
  }
}

test('model_id_case_is_preserved', () => {
  const canonical: ModelRef = { provider: 'openrouter', modelId: 'z-ai/glm-5.3-flash' }
  const upper: ModelRef = { provider: 'openrouter', modelId: 'Z-AI/GLM-5.3-Flash' }

  // The tuple key must distinguish case variants instead of case-folding the model ID.
  assert.notEqual(modelRefKey(canonical), modelRefKey(upper))
  assert.equal(modelRefKey(canonical), modelRefKey({ ...canonical }))

  // Embedded separators must not create an ambiguous concatenated key.
  assert.notEqual(
    modelRefKey({ provider: 'openrouter', modelId: 'a/b' }),
    modelRefKey({ provider: 'openrouter', modelId: 'a:b' }),
  )
  assert.notEqual(
    modelRefKey({ provider: 'deepseek', modelId: 'x:y' }),
    modelRefKey({ provider: 'openrouter', modelId: 'x:y' }),
  )

  // Provider-defined case is significant at lookup time.
  const snapshot = createCatalogSnapshot(snapshotInput(['Z-AI/GLM-5.3-Flash']))
  assert.ok(findModelProfile(snapshot, upper))
  assert.equal(findModelProfile(snapshot, canonical), undefined)
})
