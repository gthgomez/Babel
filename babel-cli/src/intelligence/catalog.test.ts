import assert from 'node:assert/strict'
import test from 'node:test'

import { createCatalogSnapshot, findModelProfile } from './catalog.js'
import type {
  CapabilitySourceRef,
  CatalogSnapshotInput,
  LabModelSpecInput,
  ProviderModelProfileInput,
} from './types.js'

const RETRIEVED_AT = '2026-09-01T00:00:00.000Z'
const REF = { provider: 'openrouter', modelId: 'z-ai/glm-5.3-flash' } as const

function sourceRef(
  source: CapabilitySourceRef['source'] = 'provider_api',
): CapabilitySourceRef {
  return { source, retrievedAt: RETRIEVED_AT }
}

function providerInput(
  providerModelId: string,
  overrides: Partial<ProviderModelProfileInput> = {},
): ProviderModelProfileInput {
  return {
    schemaVersion: 1,
    provider: 'openrouter',
    canonicalModelId: 'z-ai/glm-5.3-flash',
    providerModelId,
    protocolProfiles: [],
    providerLimits: { contextTokens: 200_000, maxOutputTokens: 16_384 },
    lifecycle: { status: 'active' },
    sourceEvidence: [sourceRef()],
    observedEvidence: [],
    ...overrides,
  }
}

function labInput(overrides: Partial<LabModelSpecInput> = {}): LabModelSpecInput {
  return {
    schemaVersion: 1,
    canonicalModelId: 'z-ai/glm-5.3-flash',
    family: 'glm',
    modalities: { input: ['text'], output: ['text'] },
    declaredLimits: { contextTokens: 1_310_720, maxOutputTokens: 131_072 },
    limitEvidence: [
      {
        scope: 'lab_model',
        claim: 'MODEL_AUTHOR_DECLARED_LIMIT',
        value: 1_310_720,
        field: 'contextTokens',
        source: sourceRef('official_docs'),
        observedAt: RETRIEVED_AT,
        confidence: 'high',
        status: 'supported',
      },
    ],
    nativeCapabilities: {},
    sourceEvidence: [sourceRef('official_docs')],
    ...overrides,
  }
}

function snapshotInput(overrides: Partial<CatalogSnapshotInput> = {}): CatalogSnapshotInput {
  return {
    observedAt: '2026-10-06T00:00:00.000Z',
    sourceResults: [
      {
        sourceId: 'openrouter-catalog',
        status: 'ok',
        completeness: 'complete',
        fetchedAt: '2026-10-06T00:00:00.000Z',
        contentDigest: 'fixture-digest',
      },
    ],
    labModels: [labInput()],
    providerModels: [providerInput('z-ai/glm-5.3-flash')],
    ...overrides,
  }
}

test('catalog_has_one_fact_owner', () => {
  const snapshot = createCatalogSnapshot(snapshotInput())

  // The snapshot is the immutable owner of facts; nothing is copied into a second record.
  assert.ok(Object.isFrozen(snapshot))
  assert.ok(Object.isFrozen(snapshot.providerModels))
  assert.ok(Object.isFrozen(snapshot.providerModels[0]))
  assert.equal(findModelProfile(snapshot, REF), snapshot.providerModels[0])

  // Revision is a content identity, distinct from the snapshot observation timestamp.
  const later = createCatalogSnapshot({
    ...snapshotInput(),
    observedAt: '2026-11-01T00:00:00.000Z',
  })
  assert.equal(later.revision, snapshot.revision)
  assert.notEqual(later.observedAt, snapshot.observedAt)

  const changedFact = createCatalogSnapshot(
    snapshotInput({
      providerModels: [
        providerInput('z-ai/glm-5.3-flash', {
          providerLimits: { contextTokens: 100_000, maxOutputTokens: 4_096 },
        }),
      ],
    }),
  )
  assert.notEqual(changedFact.revision, snapshot.revision)
})

test('projection_preserves_scoped_evidence', () => {
  const snapshot = createCatalogSnapshot(
    snapshotInput({
      providerModels: [
        providerInput('z-ai/glm-5.3-flash', {
          endpointProfiles: [
            {
              endpointId: 'openrouter:z-ai',
              upstreamProvider: 'z-ai',
              limits: { contextTokens: 131_072, maxOutputTokens: 8_192 },
              limitEvidence: [
                {
                  scope: 'endpoint',
                  claim: 'EXACT_UPSTREAM_ENDPOINT_LIMIT',
                  value: 131_072,
                  field: 'contextTokens',
                  source: sourceRef(),
                  observedAt: RETRIEVED_AT,
                  confidence: 'high',
                  status: 'supported',
                },
              ],
              sourceEvidence: [sourceRef()],
            },
          ],
          limitEvidence: [
            {
              scope: 'gateway',
              claim: 'OPENROUTER_GATEWAY_CATALOG_LIMIT',
              value: 200_000,
              field: 'contextTokens',
              source: sourceRef(),
              observedAt: RETRIEVED_AT,
              confidence: 'high',
              status: 'supported',
            },
            {
              scope: 'top_provider',
              claim: 'OPENROUTER_TOP_PROVIDER_LIMIT',
              value: 131_072,
              field: 'contextTokens',
              source: sourceRef(),
              observedAt: RETRIEVED_AT,
              confidence: 'medium',
              status: 'conflicting',
            },
          ],
        }),
      ],
    }),
  )

  const profile = findModelProfile(snapshot, REF)
  assert.ok(profile)

  // Lab, gateway and endpoint limits stay separate rather than being blended into one number.
  assert.deepEqual(profile.providerLimits, { contextTokens: 200_000, maxOutputTokens: 16_384 })
  assert.deepEqual(profile.endpointProfiles?.[0]?.limits, {
    contextTokens: 131_072,
    maxOutputTokens: 8_192,
  })
  assert.deepEqual(
    profile.limitEvidence?.map((entry) => [entry.scope, entry.claim, entry.value, entry.status]),
    [
      ['gateway', 'OPENROUTER_GATEWAY_CATALOG_LIMIT', 200_000, 'supported'],
      ['top_provider', 'OPENROUTER_TOP_PROVIDER_LIMIT', 131_072, 'conflicting'],
    ],
  )

  const lab = snapshot.labModels[0]
  assert.ok(lab)
  assert.deepEqual(lab.declaredLimits, { contextTokens: 1_310_720, maxOutputTokens: 131_072 })
  assert.deepEqual(
    lab.limitEvidence?.map((entry) => [entry.scope, entry.claim, entry.value]),
    [['lab_model', 'MODEL_AUTHOR_DECLARED_LIMIT', 1_310_720]],
  )
})

test('duplicate_tuple_is_rejected', () => {
  assert.throws(
    () =>
      createCatalogSnapshot(
        snapshotInput({
          providerModels: [
            providerInput('z-ai/glm-5.3-flash'),
            providerInput('z-ai/glm-5.3-flash'),
          ],
        }),
      ),
    /duplicate provider\+model identity/,
  )

  // The same served model on a different provider is a distinct ref and remains allowed.
  const twoProviders = createCatalogSnapshot(
    snapshotInput({
      providerModels: [
        providerInput('z-ai/glm-5.3-flash'),
        providerInput('z-ai/glm-5.3-flash', { provider: 'deepinfra' }),
      ],
    }),
  )
  assert.equal(twoProviders.providerModels.length, 2)
})
