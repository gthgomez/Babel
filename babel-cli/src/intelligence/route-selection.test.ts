import assert from 'node:assert/strict'
import test from 'node:test'

import { createCatalogSnapshot } from './catalog.js'
import type { CatalogSnapshotInput } from './types.js'
import {
  beginRouteAttempt,
  connectionIdentityForRoute,
  connectionKey,
  evaluateRouteAdmission,
  recordRouteAttemptUsage,
  resolveModelSelection,
  type ConfiguredRoute,
  type ModelAliasDeclaration,
  type ModelSelectionFailure,
  type ModelSelectionResult,
} from './route-selection.js'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function route(overrides: Partial<ConfiguredRoute> & { routeId: string }): ConfiguredRoute {
  return {
    ref: { provider: 'deepinfra', modelId: 'Qwen/Qwen3-235B-A22B-Instruct-2507' },
    enabled: true,
    requiredOperation: 'structured',
    ...overrides,
  }
}

function failure(result: ReturnType<typeof resolveModelSelection>): ModelSelectionFailure {
  assert.notEqual(result.status, 'resolved', `expected typed failure, received ${result.status}`)
  assert.notEqual(result.status, 'fallback', `expected typed failure, received ${result.status}`)
  return result as ModelSelectionFailure
}

// ─── Acceptance cases ─────────────────────────────────────────────────────────

test('ambiguous_unqualified_id_is_rejected', () => {
  const routes: ConfiguredRoute[] = [
    route({ routeId: 'deepinfra-shared', ref: { provider: 'deepinfra', modelId: 'shared-model' } }),
    route({ routeId: 'openrouter-shared', ref: { provider: 'openrouter', modelId: 'shared-model' } }),
  ]

  const ambiguous = failure(
    resolveModelSelection({ mode: 'production_resilient', requested: 'shared-model', routes }),
  )
  assert.equal(ambiguous.code, 'ambiguous_id')
  assert.equal(ambiguous.status, 'blocked')

  const exact = resolveModelSelection({
    mode: 'production_resilient',
    requested: 'openrouter:shared-model',
    routes,
  })
  assert.equal(exact.status, 'resolved')
  assert.equal(exact.status === 'resolved' ? exact.ref.provider : null, 'openrouter')
  assert.equal(exact.status === 'resolved' ? exact.ref.modelId : null, 'shared-model')

  // Exact-case provider-qualified lookup never case-folds the provider model ID.
  const caseMismatch = failure(
    resolveModelSelection({
      mode: 'benchmark_strict',
      requested: 'deepinfra:SHARED-MODEL',
      routes,
    }),
  )
  assert.equal(caseMismatch.code, 'no_eligible_route')
  assert.equal(caseMismatch.ref?.modelId, 'SHARED-MODEL')
})

test('alias_cycle_has_typed_error', () => {
  const routes: ConfiguredRoute[] = [route({ routeId: 'qwen3' })]
  const cyclic = failure(
    resolveModelSelection({
      mode: 'production_resilient',
      requested: 'alias-a',
      routes,
      aliases: [
        { alias: 'alias-a', target: 'alias-b' },
        { alias: 'alias-b', target: 'alias-a' },
      ],
    }),
  )
  assert.equal(cyclic.code, 'alias_cycle')
  assert.equal(cyclic.status, 'blocked')
  assert.match(cyclic.reason, /cycle/i)
})

test('alias resolution rejects depth overflow, duplicates and missing targets', () => {
  const routes: ConfiguredRoute[] = [route({ routeId: 'qwen3' })]
  const deep = failure(
    resolveModelSelection({
      mode: 'production_resilient',
      requested: 'a',
      routes,
      maxAliasDepth: 2,
      aliases: [
        { alias: 'a', target: 'b' },
        { alias: 'b', target: 'c' },
        { alias: 'c', target: 'qwen3' },
      ],
    }),
  )
  assert.equal(deep.code, 'alias_depth_exceeded')

  const duplicate = failure(
    resolveModelSelection({
      mode: 'production_resilient',
      requested: 'x',
      routes,
      aliases: [
        { alias: 'x', target: 'qwen3' },
        { alias: 'X', target: 'qwen3' },
      ],
    }),
  )
  assert.equal(duplicate.code, 'duplicate_alias')

  const missing = failure(
    resolveModelSelection({
      mode: 'production_resilient',
      requested: 'ghost',
      routes,
      aliases: [{ alias: 'ghost', target: 'not-a-route' }],
    }),
  )
  assert.equal(missing.code, 'unknown_alias_target')
})

test('alias declared without a maps_to target is a typed unknown_alias_target, never a TypeError', () => {
  const routes: ConfiguredRoute[] = [route({ routeId: 'qwen3' })]
  // A partial/legacy policy can omit `maps_to`; the declared type is narrower
  // than runtime, so this is exactly the defensive path under test.
  const untargeted = { alias: 'ghost', target: undefined } as unknown as ModelAliasDeclaration

  let result: ModelSelectionResult | null = null
  assert.doesNotThrow(() => {
    result = resolveModelSelection({
      mode: 'production_resilient',
      requested: 'ghost',
      routes,
      aliases: [untargeted],
    })
  })

  const typed = failure(result!)
  assert.equal(typed.code, 'unknown_alias_target')
  assert.equal(typed.status, 'blocked')
})

test('alias with a malformed model-reference target is a typed unknown_alias_target', () => {
  const routes: ConfiguredRoute[] = [route({ routeId: 'qwen3' })]
  const malformed = { alias: 'ghost', target: { provider: 'deepinfra' } } as unknown as ModelAliasDeclaration
  const result = failure(
    resolveModelSelection({
      mode: 'production_resilient',
      requested: 'ghost',
      routes,
      aliases: [malformed],
    }),
  )
  assert.equal(result.code, 'unknown_alias_target')
  assert.equal(result.status, 'blocked')
})

test('human aliases resolve case-insensitively to a concrete route', () => {
  const routes: ConfiguredRoute[] = [route({ routeId: 'qwen3' })]
  const result = resolveModelSelection({
    mode: 'production_resilient',
    requested: 'QwEn-AlIaS',
    routes,
    aliases: [{ alias: 'qwen-alias', target: 'qwen3' }],
  })
  assert.equal(result.status, 'resolved')
  assert.equal(result.status === 'resolved' ? result.routeId : null, 'qwen3')
  assert.equal(result.status === 'resolved' ? result.aliasUsed : null, true)
  assert.equal(result.status === 'resolved' ? result.aliasId : null, 'qwen-alias')
})

test('no_eligible_route_returns_typed_unavailable', () => {
  const routes: ConfiguredRoute[] = [route({ routeId: 'qwen3', enabled: false })]
  const result = failure(
    resolveModelSelection({ mode: 'production_resilient', requested: 'qwen3', routes }),
  )
  assert.equal(result.code, 'no_eligible_route')
  assert.equal(result.status, 'blocked')
  assert.equal(result.routeId, 'qwen3')
})

test('strict_route_never_falls_back', () => {
  const routes: ConfiguredRoute[] = [
    route({ routeId: 'refused', enabled: false }),
    route({
      routeId: 'available',
      ref: { provider: 'openrouter', modelId: 'deepseek/deepseek-v4-flash-0731' },
    }),
  ]
  const result = failure(
    resolveModelSelection({ mode: 'benchmark_strict', requested: 'refused', routes }),
  )
  assert.equal(result.code, 'route_not_admitted')
  assert.equal(result.routeId, 'refused')
  assert.notEqual(result.status, 'fallback')
})

test('production_resilient_uses_ordered_configured_eligible_routes', () => {
  const routes: ConfiguredRoute[] = [
    route({ routeId: 'refused', enabled: false }),
    route({
      routeId: 'available',
      ref: { provider: 'openrouter', modelId: 'deepseek/deepseek-v4-flash-0731' },
    }),
  ]
  const result = resolveModelSelection({
    mode: 'production_resilient',
    requested: 'refused',
    routes,
  })
  assert.equal(result.status, 'fallback')
  assert.equal(result.status === 'fallback' ? result.routeId : null, 'available')
  assert.equal(result.requested, 'refused')
  assert.match(result.fallbackReason ?? '', /refused/)
})

// ─── Admission gate ───────────────────────────────────────────────────────────

test('production admission refuses dormant and benchmark-only providers', () => {
  const dormant = evaluateRouteAdmission(
    { mode: 'production_resilient', requested: '', routes: [] },
    route({ routeId: 'ox', ref: { provider: 'opencode', modelId: 'x-preview-f-free' } }),
  )
  assert.equal(dormant.admitted, false)
  assert.equal(dormant.code, 'provider_uncertified')

  const benchmark = evaluateRouteAdmission(
    { mode: 'production_resilient', requested: '', routes: [] },
    route({ routeId: 'go', ref: { provider: 'opencode-go', modelId: 'mimo-v2.5' } }),
  )
  assert.equal(benchmark.admitted, false)
  assert.equal(benchmark.code, 'provider_not_production')

  const benchmarkStrict = evaluateRouteAdmission(
    {
      mode: 'benchmark_strict',
      requested: '',
      routes: [],
      authorizations: [{ ref: { provider: 'opencode-go', modelId: 'mimo-v2.5' }, decision: { allowed: true } }],
    },
    route({ routeId: 'go', ref: { provider: 'opencode-go', modelId: 'mimo-v2.5' } }),
  )
  assert.equal(benchmarkStrict.admitted, true)
})

test('registry status alone never enables a route without explicit admission', () => {
  const uncertified = evaluateRouteAdmission(
    { mode: 'qualification', requested: '', routes: [] },
    route({ routeId: 'go', ref: { provider: 'opencode-go', modelId: 'mimo-v2.5' } }),
  )
  assert.equal(uncertified.admitted, false)
  assert.equal(uncertified.code, 'qualification_missing')

  const denied = evaluateRouteAdmission(
    {
      mode: 'qualification',
      requested: '',
      routes: [],
      authorizations: [
        { ref: { provider: 'opencode-go', modelId: 'mimo-v2.5' }, decision: { allowed: false, reason: 'not run' } },
      ],
    },
    route({ routeId: 'go', ref: { provider: 'opencode-go', modelId: 'mimo-v2.5' } }),
  )
  assert.equal(denied.admitted, false)
  assert.equal(denied.code, 'authorization_denied')
})

// ─── Connection identity / cache rekeying ─────────────────────────────────────

test('cache_rekeys_on_connection_revision', () => {
  const base = route({ routeId: 'qwen3' })
  const endpointA = route({ routeId: 'qwen3', endpoint: 'https://a.example/v1' })
  const endpointB = route({ routeId: 'qwen3', endpoint: 'https://b.example/v1' })
  const credentialA = route({ routeId: 'qwen3', credentialProvenance: 'DEEPINFRA_API_KEY' })
  const credentialB = route({ routeId: 'qwen3', credentialProvenance: 'CUSTOM_DEEPINFRA_KEY' })

  assert.equal(connectionKey(connectionIdentityForRoute(base)), connectionKey(connectionIdentityForRoute(base)))
  assert.notEqual(
    connectionKey(connectionIdentityForRoute(endpointA)),
    connectionKey(connectionIdentityForRoute(endpointB)),
  )
  assert.notEqual(
    connectionKey(connectionIdentityForRoute(credentialA)),
    connectionKey(connectionIdentityForRoute(credentialB)),
  )
  // Same model ID, same provider: only the connection revision separates them.
  assert.notEqual(connectionKey(connectionIdentityForRoute(endpointA)), connectionKey(connectionIdentityForRoute(credentialA)))
})

// ─── Per-attempt state isolation ──────────────────────────────────────────────

test('no_cached_runner_usage_leak', () => {
  const key = 'connection-key'
  const attemptA = beginRouteAttempt(key, 'mimo-v2.5', 'owner-a')
  const attemptB = beginRouteAttempt(key, 'mimo-v2.5', 'owner-b')

  assert.notEqual(attemptA, attemptB)
  assert.notEqual(attemptA.signal, attemptB.signal)

  assert.equal(recordRouteAttemptUsage(attemptA, { model: 'mimo-v2.5', inputTokens: 1, outputTokens: 1 }), true)
  assert.equal(attemptA.usage?.outputTokens, 1)
  assert.equal(attemptB.usage ?? null, null)

  // Cancelling one attempt fences its late usage and never touches the other.
  attemptA.controller.abort()
  assert.equal(recordRouteAttemptUsage(attemptA, { model: 'mimo-v2.5', inputTokens: 9, outputTokens: 9 }), false)
  assert.equal(attemptA.usage?.outputTokens, 1)

  assert.equal(recordRouteAttemptUsage(attemptB, { model: 'mimo-v2.5', inputTokens: 2, outputTokens: 2 }), true)
  assert.equal(attemptB.usage?.outputTokens, 2)
})

// ─── Catalog identity ─────────────────────────────────────────────────────────

test('resolveModelSelection preserves profile identity from the catalog', () => {
  const input: CatalogSnapshotInput = {
    observedAt: '2026-10-06T00:00:00.000Z',
    sourceResults: [
      { sourceId: 'fixture', status: 'ok', completeness: 'complete', fetchedAt: '2026-10-06T00:00:00.000Z' },
    ],
    labModels: [],
    providerModels: [
      {
        schemaVersion: 1,
        provider: 'deepinfra',
        canonicalModelId: 'qwen3',
        providerModelId: 'Qwen/Qwen3-235B-A22B-Instruct-2507',
        protocolProfiles: [
          {
            protocol: 'chat_completions',
            streaming: { state: 'api_advertised', support: 'supported', evidenceLevel: 'api_advertised' },
            reasoning: {
              enabled: { state: 'unknown', support: 'unknown', evidenceLevel: 'declared' },
            },
            tools: {
              basicTools: { state: 'unknown', support: 'unknown', evidenceLevel: 'declared' },
              streamingTools: { state: 'unknown', support: 'unknown', evidenceLevel: 'declared' },
              sequentialTools: { state: 'unknown', support: 'unknown', evidenceLevel: 'declared' },
              parallelTools: { state: 'unknown', support: 'unknown', evidenceLevel: 'declared' },
              toolChoiceAuto: { state: 'unknown', support: 'unknown', evidenceLevel: 'declared' },
              toolChoiceRequired: { state: 'unknown', support: 'unknown', evidenceLevel: 'declared' },
              toolChoiceSpecific: { state: 'unknown', support: 'unknown', evidenceLevel: 'declared' },
              strictArgumentSchema: { state: 'unknown', support: 'unknown', evidenceLevel: 'declared' },
              reasoningToolInterleave: { state: 'unknown', support: 'unknown', evidenceLevel: 'declared' },
              reasoningReplayAcrossTurns: { state: 'unknown', support: 'unknown', evidenceLevel: 'declared' },
              multipleToolRounds: { state: 'unknown', support: 'unknown', evidenceLevel: 'declared' },
            },
            structuredOutput: {
              jsonObjectMode: { state: 'unknown', support: 'unknown', evidenceLevel: 'declared' },
              jsonSchemaMode: { state: 'unknown', support: 'unknown', evidenceLevel: 'declared' },
              strictSchemaEnforcement: { state: 'unknown', support: 'unknown', evidenceLevel: 'declared' },
              structuredOutputWithTools: { state: 'unknown', support: 'unknown', evidenceLevel: 'declared' },
              structuredOutputStreaming: { state: 'unknown', support: 'unknown', evidenceLevel: 'declared' },
            },
            supportedParameters: [],
            qualificationStatus: 'qualified',
          },
        ],
        providerLimits: { contextTokens: 200_000 },
        lifecycle: { status: 'active' },
        sourceEvidence: [{ source: 'provider_api', retrievedAt: '2026-10-06T00:00:00.000Z' }],
        observedEvidence: [],
      },
    ],
  }
  const catalog = createCatalogSnapshot(input)
  const result = resolveModelSelection({
    mode: 'production_resilient',
    requested: 'qwen3',
    routes: [route({ routeId: 'qwen3' })],
    catalog,
  })
  assert.equal(result.status, 'resolved')
  assert.ok(result.status === 'resolved' ? result.profile : null)
  assert.equal(result.status === 'resolved' ? result.profile?.providerModelId : null, 'Qwen/Qwen3-235B-A22B-Instruct-2507')
})
