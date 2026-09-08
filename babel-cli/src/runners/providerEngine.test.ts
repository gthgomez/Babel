import assert from 'node:assert/strict'
import test from 'node:test'
import { z } from 'zod'

import { createProviderRunner } from './providerEngine.js'
import { OpenCodeGoError } from '../claude-babel-astra-lab/openCodeGoApi.js'

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

test('ProviderEngine registers benchmark-only OpenCode Go with exact model selection', async (t) => {
  const priorFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = priorFetch })
  let url = ''
  let headers: Record<string, string> = {}
  let body: Record<string, unknown> = {}
  globalThis.fetch = (async (input, init) => {
    url = String(input)
    headers = init?.headers as Record<string, string>
    body = JSON.parse(String(init?.body)) as Record<string, unknown>
    return new Response(JSON.stringify({
      model: 'mimo-v2.5',
      choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch

  const runner = createProviderRunner({
    provider: 'opencode-go',
    modelId: 'mimo-v2.5',
    credentialSource: 'explicit-test',
    explicitCredential: 'synthetic-go-key',
    sampling: { maxTokens: 32, temperature: 0 },
  })
  assert.deepEqual(await runner.execute('probe', schema), { ok: true })
  assert.equal(url, 'https://opencode.ai/zen/go/v1/chat/completions')
  assert.equal(body.model, 'mimo-v2.5')
  assert.match(headers['x-opencode-session'] ?? '', /^run-[0-9a-f-]{36}-[0-9a-f-]{36}$/)
  assert.equal(runner.provider, 'opencode-go')
  assert.equal(runner.modelId, 'mimo-v2.5')
  assert.equal(runner.getLastInvocationMetadata()?.provider, 'opencode-go')
})

test('ProviderEngine fails closed for unknown and substituted benchmark models', async (t) => {
  assert.throws(
    () => createProviderRunner({ provider: 'opencode-go', modelId: 'glm-5.3-flash', credentialSource: 'explicit-test', explicitCredential: 'synthetic-go-key' }),
    (error: unknown) => error instanceof OpenCodeGoError && error.code === 'MODEL_UNAVAILABLE',
  )
  const priorFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = priorFetch })
  globalThis.fetch = (async () => new Response(JSON.stringify({ model: 'longcat-2.0', choices: [{ message: { content: '{"ok":true}' } }] }), { status: 200 })) as typeof fetch
  const runner = createProviderRunner({ provider: 'opencode-go', modelId: 'mimo-v2.5', credentialSource: 'explicit-test', explicitCredential: 'synthetic-go-key' })
  await assert.rejects(runner.execute('probe', schema), (error: unknown) => error instanceof OpenCodeGoError && error.code === 'MODEL_ATTRIBUTION_FAILURE')
})

test('ProviderEngine keeps benchmark providers distinct and exposes no Zen fallback', () => {
  const runner = createProviderRunner({ provider: 'opencode-go', modelId: 'longcat-2.0', credentialSource: 'explicit-test', explicitCredential: 'synthetic-go-key' })
  assert.equal(runner.provider, 'opencode-go')
  assert.equal(runner.supports('native_tool_stream'), true)
  assert.throws(
    () => createProviderRunner({ provider: 'opencode-zen', modelId: 'x-preview-f-free', credentialSource: 'explicit-test', explicitCredential: 'synthetic-zen-key' }),
    /MODEL_UNAVAILABLE/,
  )
})
