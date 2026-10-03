import assert from 'node:assert/strict'
import test from 'node:test'
import { z } from 'zod'

import { createProviderRunner } from './providerEngine.js'
import { OpenCodeGoError } from './openCodeGoApi.js'

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
  assert.match(headers['x-opencode-session'] ?? '', /^opencode-go-[0-9a-f-]{36}$/)
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

test('ProviderEngine uses native standalone Go with shared budget and stable job session', { skip: process.platform === 'win32' ? 'POSIX directory fsync is required; durable Go reservations explicitly unsupported on Windows' : false }, async (t) => {
  const { mkdtemp, rm, readFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { OpenCodeGoBudget } = await import('./openCodeGoBudget.js')
  const dir = await mkdtemp(join(tmpdir(), 'synthetic-engine-go-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const priorFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = priorFetch })
  const path = join(dir, 'budget.json')
  const runner = createProviderRunner({ provider: 'opencode-go', modelId: 'deepseek-v4.1-flash', sampling: { maxTokens: 16 }, budget: new OpenCodeGoBudget({ statePath: path, jobId: 'job', limitUsd: 2 }), credentialSource: 'network-secret', env: { BABEL_OPENCODE_GO_API_KEY: 'synthetic-proxy-placeholder' }, benchmarkRunId: 'stable-job' })
  globalThis.fetch = (async (url, init) => {
    assert.equal(url, 'https://opencode.ai/zen/go/v1/chat/completions')
    assert.equal((init?.headers as Record<string, string>)['x-opencode-session'], 'stable-job')
    assert.equal(init?.redirect, 'error')
    assert.equal(JSON.parse(await readFile(path, 'utf8')).attempts, 1)
    return new Response(`data: ${JSON.stringify({ model: 'deepseek-v4.1-flash', choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
  }) as typeof fetch
  for await (const _event of runner.executeWithToolsStream([{ role: 'user', content: 'synthetic' }], [])) { /* consume */ }
  assert.equal(runner.getLastInvocationMetadata()?.observed_model_id, 'deepseek-v4.1-flash')
  const { getProviderSpec } = await import('./providerRegistry.js')
  assert.equal(getProviderSpec('opencode-go').authorityConformance, 'untested')
  assert.throws(() => createProviderRunner({ provider: 'opencode-go', modelId: 'deepseek-v4.1-flash', credentialSource: 'explicit-test', explicitCredential: 'synthetic' }), /budget/i)
})


test('Windows ProviderEngine Go refuses native network dispatch without claiming durability', { skip: process.platform !== 'win32' ? 'Actual Windows unsupported-durability contract' : false }, async (t) => {
  const { mkdtemp, readdir, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { OpenCodeGoBudget } = await import('./openCodeGoBudget.js')
  const dir = await mkdtemp(join(tmpdir(), 'synthetic-windows-engine-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const priorFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = priorFetch })
  let fetches = 0
  globalThis.fetch = (async () => { fetches++; throw Error('unsupported Windows dispatch reached network') }) as typeof fetch
  const runner = createProviderRunner({ provider: 'opencode-go', modelId: 'deepseek-v4.1-flash', sampling: { maxTokens: 16 }, budget: new OpenCodeGoBudget({ statePath: join(dir, 'budget.json'), jobId: 'windows-job', limitUsd: 2 }), credentialSource: 'explicit-test', explicitCredential: 'synthetic' })
  const errors: string[] = []
  for await (const event of runner.executeWithToolsStream([{ role: 'user', content: 'synthetic' }], [])) {
    if (event.type === 'error') errors.push(event.message)
  }
  assert.equal(errors.length, 1)
  assert.match(errors[0] ?? '', /budget denied.*unsupported on Windows/)
  assert.equal(fetches, 0)
  assert.deepEqual(await readdir(dir), [])
})
