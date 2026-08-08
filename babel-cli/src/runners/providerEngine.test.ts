import assert from 'node:assert/strict'
import test from 'node:test'
import { z } from 'zod'

import { createProviderRunner } from './providerEngine.js'

const schema = z.object({ ok: z.boolean() })

test('ProviderEngine keeps OpenAI model and sampling controls in its protocol body', async (t) => {
  const priorFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = priorFetch })
  let body: Record<string, unknown> = {}
  globalThis.fetch = (async (_input, init) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch

  const runner = createProviderRunner({
    provider: 'openai',
    modelId: 'openai-test-model',
    sampling: { maxTokens: 321, temperature: 0.25 },
    explicitCredential: 'synthetic-openai-key',
  })
  assert.deepEqual(await runner.execute('probe', schema), { ok: true })
  assert.equal(body['model'], 'openai-test-model')
  assert.equal(body['max_completion_tokens'], 321)
  assert.equal(body['temperature'], 0.25)
})

test('ProviderEngine maps shared controls into Gemini-specific generationConfig', async (t) => {
  const priorFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = priorFetch })
  let url = ''
  let body: Record<string, unknown> = {}
  globalThis.fetch = (async (input, init) => {
    url = String(input)
    body = JSON.parse(String(init?.body)) as Record<string, unknown>
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch

  const runner = createProviderRunner({
    provider: 'gemini',
    modelId: 'gemini-test-model',
    sampling: { maxTokens: 654, temperature: 0.5 },
    explicitCredential: 'synthetic-gemini-key',
  })
  assert.deepEqual(await runner.execute('probe', schema), { ok: true })
  assert.match(url, /gemini-test-model:generateContent$/)
  assert.deepEqual(body['generationConfig'], { temperature: 0.5, maxOutputTokens: 654 })
})

test('ProviderEngine exposes operation capabilities before invocation', () => {
  const native = createProviderRunner({
    provider: 'deepseek',
    modelId: 'deepseek-v4-flash',
    explicitCredential: 'sk-synthetic-deepseek-key',
  })
  const structuredOnly = createProviderRunner({
    provider: 'openai',
    modelId: 'openai-test-model',
    explicitCredential: 'synthetic-openai-key',
  })
  assert.equal(native.supports('native_tool_stream'), true)
  assert.equal(structuredOnly.supports('native_tool_stream'), false)
})
