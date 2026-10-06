import assert from 'node:assert/strict'
import test from 'node:test'

import { createLabModelSpec, createProviderModelProfile, qualificationStaleness } from './profiles.js'
import {
  beginRouteAttempt,
  evaluateRouteAdmission,
  recordRouteAttemptUsage,
  resolveModelSelection,
  type ConfiguredRoute,
  type ModelSelectionSuccess,
} from './route-selection.js'
import type { ProviderModelProfile } from './types.js'

type ProviderInput = Omit<ProviderModelProfile, 'profileHash'>

function labModelHash(): string {
  return createLabModelSpec({
    schemaVersion: 1,
    canonicalModelId: 'z-ai/glm-5.3-flash',
    family: 'z-ai',
    modalities: { input: ['text'], output: ['text'] },
    declaredLimits: {},
    nativeCapabilities: {},
    sourceEvidence: [],
  }).profileHash
}

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

test('no_duplicate_authority_owner', () => {
  const labHash = labModelHash()
  const base = createProviderModelProfile(providerInput())
  const record = {
    modelProfileHash: labHash,
    providerProfileHash: base.profileHash,
    compatibilityFingerprint: base.compatibilityFingerprint,
    pricingRevision: base.pricingRevision,
  }

  // A price-only refresh changes the legacy full hash but not the semantic
  // fingerprint, so qualificationStaleness must not invalidate the record.
  const repriced = createProviderModelProfile({
    ...base,
    pricing: { inputPerToken: 0.000003, outputPerToken: 0.000004 },
  })
  assert.notEqual(repriced.profileHash, base.profileHash)
  assert.equal(repriced.compatibilityFingerprint, base.compatibilityFingerprint)
  assert.notEqual(repriced.pricingRevision, base.pricingRevision)
  const priceOnly = qualificationStaleness(record, {
    modelProfileHash: labHash,
    profileHash: repriced.profileHash,
    compatibilityFingerprint: repriced.compatibilityFingerprint,
    pricingRevision: repriced.pricingRevision,
  })
  assert.equal(priceOnly.stale, false)

  // A semantic change (limit drift here) invalidates the qualification.
  const semantic = createProviderModelProfile({
    ...base,
    providerLimits: { ...base.providerLimits, maxOutputTokens: 50 },
  })
  assert.notEqual(semantic.compatibilityFingerprint, base.compatibilityFingerprint)
  const semanticChange = qualificationStaleness(record, {
    modelProfileHash: labHash,
    profileHash: semantic.profileHash,
    compatibilityFingerprint: semantic.compatibilityFingerprint,
    pricingRevision: semantic.pricingRevision,
  })
  assert.equal(semanticChange.stale, true)

  // A legacy record without the versioned fields stays conservative: a
  // price-only full-hash change still invalidates it until requalified.
  const legacy = qualificationStaleness(
    { modelProfileHash: labHash, providerProfileHash: base.profileHash },
    { modelProfileHash: labHash, profileHash: repriced.profileHash },
  )
  assert.equal(legacy.stale, true)
})

test('captured_route_not_mutated_mid_turn', () => {
  const capturedRoute: ConfiguredRoute = {
    routeId: 'deepseek-v4-flash',
    ref: { provider: 'deepseek', modelId: 'deepseek-v4-flash' },
    enabled: true,
  }
  const routes: ConfiguredRoute[] = [capturedRoute]
  const selection = resolveModelSelection({
    mode: 'production_resilient',
    requested: 'deepseek-v4-flash',
    routes,
  })
  if (selection.status === 'blocked' || selection.status === 'unknown') {
    throw new Error(`expected a captured route, got ${selection.code}`)
  }
  const captured = selection as ModelSelectionSuccess

  // The per-run selection is frozen at preparation time.
  const attempt = beginRouteAttempt('conn-captured', captured.ref.modelId, 'owner-1')

  // Mid-turn the operator swaps the route table to a different model.
  routes[0] = {
    routeId: 'glm-5.3-flash',
    ref: { provider: 'openrouter', modelId: 'z-ai/glm-5.3-flash' },
    enabled: true,
  }

  // The captured selection and attempt identity are unchanged.
  assert.equal(captured.ref.provider, 'deepseek')
  assert.equal(captured.ref.modelId, 'deepseek-v4-flash')
  assert.equal(attempt.modelId, 'deepseek-v4-flash')

  // Re-resolving the same selector after the swap does not resurrect the route.
  const reResolved = resolveModelSelection({
    mode: 'production_resilient',
    requested: 'deepseek-v4-flash',
    routes,
  })
  assert.notEqual(reResolved.status, 'resolved')

  // Usage settles request-locally against the captured attempt only.
  assert.equal(
    recordRouteAttemptUsage(attempt, {
      model: 'deepseek-v4-flash',
      inputTokens: 3,
      outputTokens: 4,
    }),
    true,
  )
  assert.deepEqual(attempt.usage, {
    model: 'deepseek-v4-flash',
    inputTokens: 3,
    outputTokens: 4,
  })
  // A second settlement is fenced and cannot mutate the captured usage.
  assert.equal(
    recordRouteAttemptUsage(attempt, {
      model: 'z-ai/glm-5.3-flash',
      inputTokens: 99,
      outputTokens: 99,
    }),
    false,
  )
  assert.equal(attempt.usage?.model, 'deepseek-v4-flash')
})

test('revoked_policy_checked_before_dispatch', () => {
  const route: ConfiguredRoute = {
    routeId: 'deepseek-v4-flash',
    ref: { provider: 'deepseek', modelId: 'deepseek-v4-flash' },
    enabled: true,
  }
  const before = evaluateRouteAdmission(
    { mode: 'production_resilient', requested: 'deepseek-v4-flash', routes: [route] },
    route,
  )
  assert.equal(before.admitted, true)

  // The route is revoked after preparation; dispatch rechecks current policy.
  const revoked: ConfiguredRoute = { ...route, enabled: false }
  const atDispatch = evaluateRouteAdmission(
    { mode: 'production_resilient', requested: 'deepseek-v4-flash', routes: [revoked] },
    revoked,
  )
  assert.equal(atDispatch.admitted, false)
  assert.equal(atDispatch.code, 'route_disabled')

  // An explicit authorization revoked after preparation is also rechecked.
  const uncertified: ConfiguredRoute = {
    routeId: 'opencode',
    ref: { provider: 'opencode', modelId: 'x-preview-f-free' },
    enabled: true,
    requiredOperation: 'structured',
  }
  const denied = evaluateRouteAdmission(
    {
      mode: 'qualification',
      requested: 'opencode',
      routes: [uncertified],
      authorizations: [
        { ref: uncertified.ref, decision: { allowed: false, reason: 'revoked by policy' } },
      ],
    },
    uncertified,
  )
  assert.equal(denied.admitted, false)
  assert.equal(denied.code, 'authorization_denied')
})
