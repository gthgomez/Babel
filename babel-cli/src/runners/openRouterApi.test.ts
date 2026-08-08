import assert from 'node:assert/strict'
import test from 'node:test'
import { z } from 'zod'
import { OpenRouterApiRunner } from './openRouterApi.js'

const originalFetch = globalThis.fetch

test.afterEach(() => {
  globalThis.fetch = originalFetch
})

test('OpenRouter uses the declared credential variable and sampling body', async () => {
  let observedUrl = ''
  let observedAuthorization = ''
  let observedBody: Record<string, unknown> = {}
  globalThis.fetch = (async (input, init) => {
    observedUrl = String(input)
    observedAuthorization = String((init?.headers as Record<string, string>)?.Authorization ?? '')
    observedBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    return new Response(
      JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }),
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
  assert.equal(observedBody.model, 'example/fixed-model')
  assert.equal(observedBody.max_tokens, 321)
  assert.equal(observedBody.temperature, 0.25)
})
