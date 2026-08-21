import assert from 'node:assert/strict'
import test from 'node:test'
import { z } from 'zod'
import {
  OPENCODE_DEFAULT_BASE_URL,
  OpenCodeApiRunner,
} from './openCodeApi.js'

const originalFetch = globalThis.fetch

test.afterEach(() => {
  globalThis.fetch = originalFetch
  delete process.env['BABEL_OPENCODE_BASE_URL']
})

test('OpenCode Zen uses the declared credential variable and sampling body', async () => {
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

  const runner = new OpenCodeApiRunner(
    'x-preview-f-free',
    { maxTokens: 321, temperature: 0.25 },
    { apiKeyEnvVar: 'CUSTOM_OPENCODE_KEY', env: { CUSTOM_OPENCODE_KEY: 'synthetic-zen-key' } },
  )
  const result = await runner.execute('respond', z.object({ ok: z.literal(true) }))

  assert.deepEqual(result, { ok: true })
  assert.equal(observedUrl, `${OPENCODE_DEFAULT_BASE_URL}/chat/completions`)
  assert.equal(observedAuthorization, 'Bearer synthetic-zen-key')
  assert.equal(observedBody.model, 'x-preview-f-free')
  assert.equal(observedBody.max_tokens, 321)
  assert.equal(observedBody.temperature, 0.25)
})

test('OpenCodeApiRunner respects BABEL_OPENCODE_BASE_URL', async () => {
  let observedUrl = ''
  globalThis.fetch = (async (input) => {
    observedUrl = String(input)
    return new Response(
      JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }),
      { status: 200 },
    )
  }) as typeof fetch

  process.env['BABEL_OPENCODE_BASE_URL'] = 'https://zen-proxy.example.internal/v1/'
  const runner = new OpenCodeApiRunner(
    'x-preview-f-free',
    {},
    { explicitCredential: 'synthetic-zen-key' },
  )
  await runner.execute('respond', z.object({ ok: z.literal(true) }))

  assert.equal(observedUrl, 'https://zen-proxy.example.internal/v1/chat/completions')
})
