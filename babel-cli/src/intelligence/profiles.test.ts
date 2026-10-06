import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createLabModelSpec,
  createProviderModelProfile,
  qualificationCompatibility,
} from './profiles.js'
import type { ProviderModelProfile } from './types.js'

type ProviderInput = Omit<ProviderModelProfile, 'profileHash'>

function providerInput(): ProviderInput {
  return {
    schemaVersion: 1,
    provider: 'openrouter',
    canonicalModelId: 'z-ai/glm-5.3-flash',
    providerModelId: 'z-ai/glm-5.3-flash',
    endpointId: 'endpoint-1',
    protocolProfiles: [],
    providerLimits: { contextTokens: 1000, maxOutputTokens: 100 },
    pricing: { inputPerToken: 0.000001, outputPerToken: 0.000002 },
    lifecycle: { status: 'active' },
    sourceEvidence: [],
    observedEvidence: [],
  }
}

const LAB_HASH = createLabModelSpec({
  schemaVersion: 1,
  canonicalModelId: 'z-ai/glm-5.3-flash',
  family: 'z-ai',
  modalities: { input: ['text'], output: ['text'] },
  declaredLimits: {},
  nativeCapabilities: {},
  sourceEvidence: [],
}).profileHash

test('price_only_change_does_not_fake_semantic_failure', () => {
  const base = createProviderModelProfile(providerInput())
  const repriced = createProviderModelProfile({
    ...base,
    pricing: { inputPerToken: 0.000003, outputPerToken: 0.000004 },
  })

  // The semantic fingerprint excludes pricing; the pricing revision tracks it.
  assert.equal(repriced.compatibilityFingerprint, base.compatibilityFingerprint)
  assert.notEqual(repriced.pricingRevision, base.pricingRevision)
  // The legacy full hash still includes pricing, hence conservative legacy.
  assert.notEqual(repriced.profileHash, base.profileHash)

  const versioned = qualificationCompatibility(
    {
      modelProfileHash: LAB_HASH,
      providerProfileHash: base.profileHash,
      compatibilityFingerprint: base.compatibilityFingerprint,
      pricingRevision: base.pricingRevision,
    },
    {
      modelProfileHash: LAB_HASH,
      profileHash: repriced.profileHash,
      compatibilityFingerprint: repriced.compatibilityFingerprint,
      pricingRevision: repriced.pricingRevision,
    },
  )
  assert.equal(versioned.semanticStale, false)
  assert.equal(versioned.legacyFullHash, false)
  assert.equal(versioned.pricingChanged, true)

  // A legacy record has no versioned fields, so it stays conservative: any
  // full-hash change (including a price change) invalidates it until requalified.
  const legacy = qualificationCompatibility(
    { modelProfileHash: LAB_HASH, providerProfileHash: base.profileHash },
    {
      modelProfileHash: LAB_HASH,
      profileHash: repriced.profileHash,
      compatibilityFingerprint: repriced.compatibilityFingerprint,
      pricingRevision: repriced.pricingRevision,
    },
  )
  assert.equal(legacy.legacyFullHash, true)
  assert.equal(legacy.semanticStale, true)
})

test('semantic_change_invalidates_qualification', () => {
  const base = createProviderModelProfile(providerInput())
  const record = {
    modelProfileHash: LAB_HASH,
    providerProfileHash: base.profileHash,
    compatibilityFingerprint: base.compatibilityFingerprint,
    pricingRevision: base.pricingRevision,
  }

  const endpointChanged = createProviderModelProfile({ ...base, endpointId: 'endpoint-2' })
  const modelChanged = createProviderModelProfile({
    ...base,
    providerModelId: 'z-ai/glm-5.3-flash-preview',
  })
  const limitsChanged = createProviderModelProfile({
    ...base,
    providerLimits: { ...base.providerLimits, maxOutputTokens: 50 },
  })

  for (const changed of [endpointChanged, modelChanged, limitsChanged]) {
    assert.notEqual(changed.compatibilityFingerprint, base.compatibilityFingerprint)
    // Semantic drift does not depend on a price change.
    assert.equal(changed.pricingRevision, base.pricingRevision)
    const compatibility = qualificationCompatibility(record, {
      modelProfileHash: LAB_HASH,
      profileHash: changed.profileHash,
      compatibilityFingerprint: changed.compatibilityFingerprint,
      pricingRevision: changed.pricingRevision,
    })
    assert.equal(compatibility.semanticStale, true)
    assert.equal(compatibility.stale, true)
  }

  // A model revision change invalidates the lab-side identity too.
  const modelRecord = qualificationCompatibility(
    record,
    {
      modelProfileHash: 'different-lab-hash',
      profileHash: base.profileHash,
      compatibilityFingerprint: base.compatibilityFingerprint,
      pricingRevision: base.pricingRevision,
    },
  )
  assert.equal(modelRecord.semanticStale, true)
})

test('provenance timestamps do not change the semantic fingerprint', () => {
  const base = createProviderModelProfile({
    ...providerInput(),
    sourceEvidence: [{ source: 'provider_api', retrievedAt: '2026-01-01T00:00:00.000Z' }],
  })
  const refreshed = createProviderModelProfile({
    ...base,
    sourceEvidence: [{ source: 'provider_api', retrievedAt: '2026-02-01T00:00:00.000Z' }],
  })
  assert.equal(refreshed.compatibilityFingerprint, base.compatibilityFingerprint)
  assert.equal(refreshed.pricingRevision, base.pricingRevision)
  assert.equal(refreshed.profileHash, base.profileHash)
})
