import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ModelRouter, RouteUnavailableError, beginRouteAttempt, recordRouteAttemptUsage } from './modelRouter.js'
import { resolveChatModelPolicy } from './chatModelPolicy.js'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function createPolicyRoot(models: Record<string, Record<string, unknown>>): string {
  const root = mkdtempSync(join(tmpdir(), 'babel-router-policy-'))
  mkdirSync(join(root, 'config'), { recursive: true })
  writeFileSync(
    join(root, 'config', 'model-policy.json'),
    JSON.stringify({
      version: 2,
      default_tier: 'cheap',
      hard_fail_on_unknown_model: true,
      require_explicit_opt_in_for_expensive: true,
      family_defaults: {},
      vendor_aliases: {},
      models,
      stages: {},
    }),
    'utf-8',
  )
  return root
}

function withDeepInfraKey<T>(fn: () => T): T {
  const previous = process.env['DEEPINFRA_API_KEY']
  process.env['DEEPINFRA_API_KEY'] = 'synthetic-deepinfra-key'
  try {
    return fn()
  } finally {
    if (previous === undefined) delete process.env['DEEPINFRA_API_KEY']
    else process.env['DEEPINFRA_API_KEY'] = previous
  }
}

// ─── Existing characterization ────────────────────────────────────────────────

test('ModelRouter constructs declared DeepInfra routes through ProviderEngine', () => {
  const previous = process.env['DEEPINFRA_API_KEY']
  process.env['DEEPINFRA_API_KEY'] = 'synthetic-deepinfra-key'
  try {
    // qwen3 is the canonical deepinfra backend in config/model-policy.json
    const route = new ModelRouter().resolve('qwen3')
    assert.equal(route.provider, 'deepinfra')
    assert.equal(route.runner.provider, 'deepinfra')
    assert.equal(route.runner.modelId, route.modelId)
  } finally {
    if (previous === undefined) delete process.env['DEEPINFRA_API_KEY']
    else process.env['DEEPINFRA_API_KEY'] = previous
  }
})

test('ModelRouter maps legacy DeepSeek selectors to OpenRouter in live mode', () => {
  const previousRouter = process.env['OPENROUTER_API_KEY']
  const previousDeepSeek = process.env['DEEPSEEK_API_KEY']
  process.env['OPENROUTER_API_KEY'] = 'fixture-router-key'
  process.env['DEEPSEEK_API_KEY'] = 'synthetic-direct-key'
  try {
    const route = new ModelRouter({ liveOnly: true }).resolve('deepseek-v4-flash')
    assert.equal(route.provider, 'openrouter')
    assert.equal(route.modelId, 'deepseek/deepseek-v4-flash-0731')
    assert.equal(route.runner.provider, 'openrouter')
    assert.equal(route.runner.modelId, 'deepseek/deepseek-v4-flash-0731')
  } finally {
    if (previousRouter === undefined) delete process.env['OPENROUTER_API_KEY']
    else process.env['OPENROUTER_API_KEY'] = previousRouter
    if (previousDeepSeek === undefined) delete process.env['DEEPSEEK_API_KEY']
    else process.env['DEEPSEEK_API_KEY'] = previousDeepSeek
  }
})

// ─── Acceptance cases ─────────────────────────────────────────────────────────

test('all_entrypoints_apply_effective_route_admission', () => {
  const root = createPolicyRoot({
    primary: { provider: 'deepinfra', model_id: 'Qwen/Qwen3-235B-A22B-Instruct-2507', tier: 'cheap' },
    'primary-disabled': { provider: 'deepinfra', model_id: 'Qwen/Qwen3-235B-A22B-Instruct-2507', tier: 'cheap', enabled: false },
    // Dormant (uncertified) production-purpose provider: registry membership
    // must not activate the lane.
    'dormant-openai': { provider: 'openai', model_id: 'gpt-fixture', tier: 'cheap' },
  })

  withDeepInfraKey(() => {
    // Router entrypoint (benchmark_strict never substitutes a disabled route).
    assert.throws(
      () => new ModelRouter({ babelRoot: root, mode: 'benchmark_strict' }).resolve('primary-disabled'),
      (error: unknown) =>
        error instanceof RouteUnavailableError && error.code === 'route_not_admitted',
    )
    // Router refuses the dormant provider with the shared typed denial.
    assert.throws(
      () =>
        new ModelRouter({ babelRoot: root, mode: 'benchmark_strict' }).resolve(
          'dormant-openai',
        ),
      (error: unknown) =>
        error instanceof RouteUnavailableError && error.code === 'route_not_admitted',
    )
    // Chat entrypoint applies the same effective denial through policy.
    assert.throws(
      () => resolveChatModelPolicy({ model: 'primary-disabled', babelRoot: root }),
      /disabled/,
    )
    // Chat applies the *same shared typed denial* for a dormant/uncertified
    // provider, rather than an unchecked bypass.
    assert.throws(
      () => resolveChatModelPolicy({ model: 'dormant-openai', babelRoot: root }),
      (error: unknown) =>
        error instanceof Error && /provider_uncertified/.test(error.message),
    )
    // A default-lane request never selects the disabled route.
    const route = new ModelRouter({ babelRoot: root }).resolve()
    assert.equal(route.routeId, 'primary')
  })
})

test('cache_rekeys_on_connection_revision', () => {
  const root = createPolicyRoot({
    qwen3: { provider: 'deepinfra', model_id: 'Qwen/Qwen3-235B-A22B-Instruct-2507', tier: 'cheap', estimated_cost_per_1m_output: 1 },
  })

  withDeepInfraKey(() => {
    const endpointA = new ModelRouter({ babelRoot: root, endpoint: 'https://a.example/v1' })
    const endpointB = new ModelRouter({ babelRoot: root, endpoint: 'https://b.example/v1' })
    const routeA = endpointA.resolve('qwen3')
    const routeB = endpointB.resolve('qwen3')

    // Same provider and model ID on two endpoints must not share a cached runner.
    assert.notEqual(routeA.connectionKey, routeB.connectionKey)
    assert.notEqual(routeA.runner, routeB.runner)

    // The same connection reuses its immutable runner.
    assert.equal(endpointA.resolve('qwen3'), routeA)
    assert.equal(routeA.runner, endpointA.resolve('qwen3').runner)

    // Credential provenance is part of the cache identity too.
    const credentialVariant = new ModelRouter({
      babelRoot: root,
      endpoint: 'https://a.example/v1',
      credentialProvenance: 'CUSTOM_DEEPINFRA_KEY',
    })
    assert.notEqual(credentialVariant.resolve('qwen3').connectionKey, routeA.connectionKey)
  })
})

test('default lane never auto-selects an expensive cheapest route', () => {
  const root = createPolicyRoot({
    'expensive-cheap': {
      provider: 'deepinfra',
      model_id: 'Qwen/Qwen3-235B-A22B-Instruct-2507',
      tier: 'cheap',
      estimated_cost_per_1m_output: 1,
      expensive: true,
    },
    'costlier-standard': {
      provider: 'deepinfra',
      model_id: 'Qwen/Qwen3-235B-A22B-Instruct-2507',
      tier: 'standard',
      estimated_cost_per_1m_output: 5,
    },
  })

  withDeepInfraKey(() => {
    const router = new ModelRouter({ babelRoot: root })
    // The lowest-cost entry is expensive, so it requires explicit opt-in.
    assert.equal(router.getDefaultBackendKey(), 'costlier-standard')
    assert.equal(router.resolve().routeId, 'costlier-standard')
    // Naming the expensive backend key explicitly is the opt-in.
    assert.equal(router.resolve('expensive-cheap').routeId, 'expensive-cheap')
  })
})

test('routeId reflects each requested backend key sharing one connection', () => {
  const root = createPolicyRoot({
    'ds-alias-a': { provider: 'deepinfra', model_id: 'Qwen/Qwen3-235B-A22B-Instruct-2507', tier: 'cheap', estimated_cost_per_1m_output: 1 },
    'ds-alias-b': { provider: 'deepinfra', model_id: 'Qwen/Qwen3-235B-A22B-Instruct-2507', tier: 'standard', estimated_cost_per_1m_output: 2 },
  })

  withDeepInfraKey(() => {
    const router = new ModelRouter({ babelRoot: root })
    const a = router.resolve('ds-alias-a')
    const b = router.resolve('ds-alias-b')

    // Distinct backend keys must not collapse to the first-cached object.
    assert.equal(a.routeId, 'ds-alias-a')
    assert.equal(b.routeId, 'ds-alias-b')
    assert.notEqual(a, b)
    assert.equal(a.connectionKey, b.connectionKey)
    // Same connection identity still shares the immutable transport runner.
    assert.equal(a.runner, b.runner)

    // Repeated resolution of the same key is stable.
    assert.equal(router.resolve('ds-alias-b'), b)
  })
})

test('defaultBackendKey option is honored by resolve and getDefaultBackendKey', () => {
  const root = createPolicyRoot({
    cheap: { provider: 'deepinfra', model_id: 'Qwen/Qwen3-235B-A22B-Instruct-2507', tier: 'cheap', estimated_cost_per_1m_output: 1 },
    preferred: { provider: 'deepinfra', model_id: 'Qwen/Qwen3-235B-A22B-Instruct-2507', tier: 'standard', estimated_cost_per_1m_output: 9 },
  })

  withDeepInfraKey(() => {
    const router = new ModelRouter({ babelRoot: root, defaultBackendKey: 'preferred' })
    assert.equal(router.getDefaultBackendKey(), 'preferred')
    assert.equal(router.resolve().routeId, 'preferred')
  })
})

test('no_eligible_route_returns_typed_unavailable', () => {
  const root = createPolicyRoot({
    off: { provider: 'deepinfra', model_id: 'Qwen/Qwen3-235B-A22B-Instruct-2507', tier: 'cheap', enabled: false },
  })

  withDeepInfraKey(() => {
    assert.throws(
      () => new ModelRouter({ babelRoot: root }).resolve(),
      (error: unknown) => error instanceof RouteUnavailableError && error.code === 'no_eligible_route',
    )
    // The historical hard-coded `scout` fallback is not a configured model.
    assert.throws(
      () => new ModelRouter({ babelRoot: root }).resolve('scout'),
      (error: unknown) => error instanceof RouteUnavailableError,
    )
  })
})

test('strict_route_never_falls_back', () => {
  const root = createPolicyRoot({
    primary: { provider: 'deepinfra', model_id: 'Qwen/Qwen3-235B-A22B-Instruct-2507', tier: 'cheap', enabled: false },
    backup: { provider: 'deepinfra', model_id: 'Qwen/Qwen3-235B-A22B-Instruct-2507', tier: 'cheap', estimated_cost_per_1m_output: 1 },
  })

  withDeepInfraKey(() => {
    assert.throws(
      () => new ModelRouter({ babelRoot: root, mode: 'benchmark_strict' }).resolve('primary'),
      (error: unknown) =>
        error instanceof RouteUnavailableError &&
        error.code === 'route_not_admitted' &&
        error.routeId === 'primary',
    )
  })
})

test('chat_entrypoint_resolves_provider_qualified_ids_exactly', () => {
  const root = createPolicyRoot({
    'deepseek-v4-flash-openrouter': { provider: 'openrouter', model_id: 'deepseek/deepseek-v4-flash-0731', tier: 'cheap' },
  })

  // Exact provider-qualified selector resolves the configured backend key.
  const { policy } = resolveChatModelPolicy({
    model: 'openrouter:deepseek/deepseek-v4-flash-0731',
    babelRoot: root,
  })
  assert.equal(policy.resolvedBackendKey, 'deepseek-v4-flash-openrouter')
  assert.equal(policy.provider, 'openrouter')
  assert.equal(policy.providerModelId, 'deepseek/deepseek-v4-flash-0731')

  // A case-mismatched API ID is never case-folded onto the configured model.
  assert.throws(
    () => resolveChatModelPolicy({ model: 'openrouter:DEEPSEEK/DEEPSEEK-V4-FLASH-0731', babelRoot: root }),
    /not configured|not defined/i,
  )
})

test('chat_entrypoint_rejects_ambiguous_provider_qualified_ids', () => {
  const root = createPolicyRoot({
    'ds-openrouter-a': { provider: 'openrouter', model_id: 'deepseek/deepseek-v4-flash-0731', tier: 'cheap' },
    'ds-openrouter-b': { provider: 'openrouter', model_id: 'deepseek/deepseek-v4-flash-0731', tier: 'cheap' },
  })

  assert.throws(
    () =>
      resolveChatModelPolicy({
        model: 'openrouter:deepseek/deepseek-v4-flash-0731',
        babelRoot: root,
      }),
    /matches 2 configured routes/,
  )
})

test('no_cached_runner_usage_leak', () => {
  const root = createPolicyRoot({
    qwen3: { provider: 'deepinfra', model_id: 'Qwen/Qwen3-235B-A22B-Instruct-2507', tier: 'cheap', estimated_cost_per_1m_output: 1 },
  })

  withDeepInfraKey(() => {
    const router = new ModelRouter({ babelRoot: root })
    const route = router.resolve('qwen3')
    assert.equal(router.resolve('qwen3'), route)

    // A cached route carries no per-attempt mutable state.
    assert.equal(Object.prototype.hasOwnProperty.call(route, 'usage'), false)
    assert.equal(Object.prototype.hasOwnProperty.call(route, 'signal'), false)

    const attemptA = beginRouteAttempt(route, 'owner-a')
    const attemptB = beginRouteAttempt(route, 'owner-b')
    assert.equal(recordRouteAttemptUsage(attemptA, { model: route.modelId, inputTokens: 1, outputTokens: 1 }), true)
    assert.equal(attemptB.usage, null)

    attemptA.controller.abort()
    assert.equal(recordRouteAttemptUsage(attemptA, { model: route.modelId, inputTokens: 5, outputTokens: 5 }), false)
    assert.equal(attemptA.usage?.outputTokens, 1)
    assert.equal(recordRouteAttemptUsage(attemptB, { model: route.modelId, inputTokens: 2, outputTokens: 2 }), true)
  })
})
