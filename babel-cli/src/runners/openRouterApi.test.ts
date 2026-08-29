import assert from 'node:assert/strict'
import test from 'node:test'
import { z } from 'zod'
import { OpenRouterApiRunner } from './openRouterApi.js'

const originalFetch = globalThis.fetch
const originalRoutingEnv = {
  allowFallbacks: process.env['BABEL_OPENROUTER_ALLOW_FALLBACKS'],
  requireParameters: process.env['BABEL_OPENROUTER_REQUIRE_PARAMETERS'],
  providerOrder: process.env['BABEL_OPENROUTER_PROVIDER_ORDER'],
}

test.afterEach(() => {
  globalThis.fetch = originalFetch
  for (const [key, value] of [
    ['BABEL_OPENROUTER_ALLOW_FALLBACKS', originalRoutingEnv.allowFallbacks],
    ['BABEL_OPENROUTER_REQUIRE_PARAMETERS', originalRoutingEnv.requireParameters],
    ['BABEL_OPENROUTER_PROVIDER_ORDER', originalRoutingEnv.providerOrder],
  ] as const) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

test('OpenRouter uses the declared credential variable and sampling body', async () => {
  let observedUrl = ''
  let observedAuthorization = ''
  let observedMetadataHeader = ''
  let observedBody: Record<string, unknown> = {}
  globalThis.fetch = (async (input, init) => {
    observedUrl = String(input)
    observedAuthorization = String((init?.headers as Record<string, string>)?.Authorization ?? '')
    observedMetadataHeader = String((init?.headers as Record<string, string>)?.['X-OpenRouter-Metadata'] ?? '')
    observedBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    return new Response(
      JSON.stringify({
        model: 'example/fixed-model',
        provider: 'ExampleProvider',
        choices: [{ message: { content: '{"ok":true}' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
      { status: 200 },
    )
  }) as typeof fetch

  const runner = new OpenRouterApiRunner(
    'example/fixed-model',
    { maxTokens: 321, temperature: 0.25 },
    { apiKeyEnvVar: 'CUSTOM_ROUTER_KEY', env: { CUSTOM_ROUTER_KEY: 'synthetic-router-key' } },
  )
  const result = await runner.execute('respond', z.object({ ok: z.literal(true) }))

  assert.deepEqual(result, { ok: true })
  assert.equal(observedUrl, 'https://openrouter.ai/api/v1/chat/completions')
  assert.equal(observedAuthorization, 'Bearer synthetic-router-key')
  assert.equal(observedMetadataHeader, 'enabled')
  assert.equal(observedBody.model, 'example/fixed-model')
  assert.equal(observedBody.max_tokens, 321)
  assert.equal(observedBody.temperature, 0.25)
  const metadata = runner.getLastInvocationMetadata()
  assert.equal(metadata?.provider, 'openrouter')
  assert.equal(metadata?.provider_model_id, 'example/fixed-model')
  assert.equal(metadata?.requested_model_id, 'example/fixed-model')
  assert.equal(metadata?.normalized_model_id, 'example/fixed-model')
  assert.equal(metadata?.sent_model_id, 'example/fixed-model')
  assert.equal(metadata?.observed_model_id, 'example/fixed-model')
  assert.equal(metadata?.upstream_provider, 'ExampleProvider')
  assert.equal(metadata?.prompt_tokens, 10)
  assert.equal(metadata?.completion_tokens, 5)
})

test('OpenRouter telemetry reports the OpenRouter retry provider and pinned cost', async () => {
  let attempts = 0
  const retryProviders: string[] = []
  globalThis.fetch = (async () => {
    attempts += 1
    if (attempts === 1) return new Response('busy', { status: 503 })
    return new Response(
      JSON.stringify({
        model: 'z-ai/glm-5.3-flash',
        provider: 'ExampleProvider',
        choices: [{ message: { content: '{"ok":true}' } }],
        usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000, total_tokens: 2_000_000 },
      }),
      { status: 200 },
    )
  }) as typeof fetch

  const runner = new OpenRouterApiRunner(
    'z-ai/glm-5.3-flash',
    { maxTokens: 321, temperature: 0.25 },
    { env: { OPENROUTER_API_KEY: 'synthetic-router-key' } },
  )
  await runner.execute(
    'respond',
    z.object({ ok: z.literal(true) }),
    {
      onRetry: (event) => retryProviders.push(event.provider),
    },
  )

  assert.deepEqual(retryProviders, ['openrouter'])
  assert.equal(runner.getLastInvocationMetadata()?.observed_model_id, 'z-ai/glm-5.3-flash')
  assert.equal(runner.getLastInvocationMetadata()?.upstream_provider, 'ExampleProvider')
  assert.equal(runner.getLastInvocationMetadata()?.estimated_cost_usd, 0.325)
})

test('scientific OpenRouter routing disables silent upstream fallback', async () => {
  let observedBody: Record<string, unknown> = {}
  globalThis.fetch = (async (_input, init) => {
    observedBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    return new Response(JSON.stringify({
      model: 'deepseek/deepseek-v4-flash-0731',
      openrouter_metadata: {
        endpoints: { available: [{ provider: 'ExampleProvider', selected: true }] },
      },
      choices: [{ message: { content: '{"ok":true}' } }],
    }), { status: 200 })
  }) as typeof fetch

  const runner = new OpenRouterApiRunner(
    'deepseek/deepseek-v4-flash-0731',
    {},
    {
      env: {
        OPENROUTER_API_KEY: 'synthetic-router-key',
        BABEL_OPENROUTER_ALLOW_FALLBACKS: '0',
        BABEL_OPENROUTER_REQUIRE_PARAMETERS: '1',
        BABEL_OPENROUTER_PROVIDER_ORDER: 'OpenInference,DeepInfra',
      },
    },
  )
  await runner.execute('respond', z.object({ ok: z.literal(true) }))

  assert.deepEqual(observedBody.provider, {
    allow_fallbacks: false,
    require_parameters: true,
    order: ['OpenInference', 'DeepInfra'],
  })
  assert.equal(runner.getLastInvocationMetadata()?.upstream_provider, 'ExampleProvider')
})

test('OpenRouter streaming telemetry preserves the observed model id', async () => {
  globalThis.fetch = (async () =>
    new Response(
      [
        'data: {"model":"z-ai/glm-5.3-flash","provider":"ExampleProvider","choices":[{"delta":{"content":"hello"}}]}',
        'data: {"model":"z-ai/glm-5.3-flash","provider":"ExampleProvider","choices":[],"usage":{"prompt_tokens":2,"completion_tokens":1,"total_tokens":3}}',
        'data: [DONE]',
        '',
      ].join('\n'),
      { status: 200 },
    )) as typeof fetch

  const runner = new OpenRouterApiRunner(
    'z-ai/glm-5.3-flash',
    {},
    { env: { OPENROUTER_API_KEY: 'synthetic-router-key' } },
  )
  let text = ''
  const phases: string[] = []
  for await (const chunk of runner.executeRawStream('respond', undefined, undefined, {
    onInvocationPhase: (event) => phases.push(event.phase),
  })) {
    text += chunk
  }

  assert.equal(text, 'hello')
  const metadata = runner.getLastInvocationMetadata()
  assert.equal(metadata?.provider, 'openrouter')
  assert.equal(metadata?.sent_model_id, 'z-ai/glm-5.3-flash')
  assert.equal(metadata?.observed_model_id, 'z-ai/glm-5.3-flash')
  assert.equal(metadata?.upstream_provider, 'ExampleProvider')
  for (const phase of ['request_created', 'request_dispatched', 'response_started', 'first_byte', 'stream_completed', 'response_normalized']) {
    assert.ok(phases.includes(phase), `missing provider phase ${phase}`)
  }
})

test('OpenRouter exact GLM route rejects a different observed model', async () => {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        model: 'z-ai/another-model',
        choices: [{ message: { content: '{"ok":true}' } }],
      }),
      { status: 200 },
    )) as typeof fetch

  const runner = new OpenRouterApiRunner(
    'z-ai/glm-5.3-flash',
    {},
    { env: { OPENROUTER_API_KEY: 'synthetic-router-key' } },
  )
  await assert.rejects(
    () => runner.execute('respond', z.object({ ok: z.literal(true) })),
    /refusing model substitution/,
  )
})

test('OpenRouter exact GLM route rejects a missing observed model identity', async () => {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content: '{"ok":true}' } }],
      }),
      { status: 200 },
    )) as typeof fetch

  const runner = new OpenRouterApiRunner(
    'z-ai/glm-5.3-flash',
    {},
    { env: { OPENROUTER_API_KEY: 'synthetic-router-key' } },
  )
  await assert.rejects(
    () => runner.execute('respond', z.object({ ok: z.literal(true) })),
    /omitted observed model identity/,
  )
})

test('OpenRouter exact DeepSeek route pins the full provider model id', async () => {
  let observedBody: Record<string, unknown> = {}
  globalThis.fetch = (async (input, init) => {
    observedBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    return new Response(
      JSON.stringify({
        model: 'deepseek/deepseek-v4-flash-0731',
        choices: [{ message: { content: '{"ok":true}' } }],
      }),
      { status: 200 },
    )
  }) as typeof fetch

  const runner = new OpenRouterApiRunner(
    'deepseek/deepseek-v4-flash-0731',
    {},
    { env: { OPENROUTER_API_KEY: 'synthetic-router-key' } },
  )
  await runner.execute('respond', z.object({ ok: z.literal(true) }))

  assert.equal(observedBody.model, 'deepseek/deepseek-v4-flash-0731')
  assert.equal(runner.getLastInvocationMetadata()?.observed_model_id, 'deepseek/deepseek-v4-flash-0731')
})

test('OpenRouter exact DeepSeek route rejects observed model substitution', async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify({
    model: 'deepseek/deepseek-v4-pro',
    choices: [{ message: { content: '{"ok":true}' } }],
  }), { status: 200 })) as typeof fetch

  const runner = new OpenRouterApiRunner(
    'deepseek/deepseek-v4-flash-0731',
    {},
    { env: { OPENROUTER_API_KEY: 'synthetic-router-key' } },
  )
  await assert.rejects(
    () => runner.execute('respond', z.object({ ok: z.literal(true) })),
    /refusing model substitution/,
  )
})
