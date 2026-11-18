import assert from 'node:assert/strict'
import test from 'node:test'

import type { RunnerCallbacks } from './base.js'

const originalFetch = globalThis.fetch
const managed = ['BABEL_DEEPSEEK_REQUEST_TIMEOUT_MS', 'BABEL_DEEPSEEK_REQUEST_MAX_RETRIES',
  'BABEL_PROVIDER_REQUEST_TIMEOUT_MS', 'BABEL_PROVIDER_REQUEST_MAX_RETRIES', 'BABEL_OFFLINE'] as const
const saved = Object.fromEntries(managed.map(name => [name, process.env[name]]))

function restoreEnv(): void {
  globalThis.fetch = originalFetch
  for (const name of managed) {
    const value = saved[name]
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
}

test.afterEach(restoreEnv)

test('DeepSeek honors the shared invocation timeout and retry policy', async () => {
  const { resolveDeepSeekRequestPolicy } = await import('./deepSeekApi.js')
  for (const name of managed) delete process.env[name]

  const defaults = resolveDeepSeekRequestPolicy({})
  assert.equal(defaults.timeoutSource, 'built-in')
  assert.equal(defaults.retrySource, 'built-in')
  assert.equal(defaults.timeoutMs, 120_000)
  assert.equal(defaults.maxRetries, 3)

  const shared = resolveDeepSeekRequestPolicy({ BABEL_PROVIDER_REQUEST_TIMEOUT_MS: '4321', BABEL_PROVIDER_REQUEST_MAX_RETRIES: '2' })
  assert.equal(shared.timeoutMs, 4321)
  assert.equal(shared.maxRetries, 2)
  assert.equal(shared.timeoutSource, 'BABEL_PROVIDER_REQUEST_TIMEOUT_MS')
  assert.equal(shared.retrySource, 'BABEL_PROVIDER_REQUEST_MAX_RETRIES')

  const vendor = resolveDeepSeekRequestPolicy({
    BABEL_PROVIDER_REQUEST_TIMEOUT_MS: '4321',
    BABEL_PROVIDER_REQUEST_MAX_RETRIES: '2',
    BABEL_DEEPSEEK_REQUEST_TIMEOUT_MS: '900',
    BABEL_DEEPSEEK_REQUEST_MAX_RETRIES: '0',
  })
  assert.equal(vendor.timeoutMs, 900)
  assert.equal(vendor.maxRetries, 0, 'explicit zero means the initial attempt only')
  assert.equal(vendor.timeoutSource, 'BABEL_DEEPSEEK_REQUEST_TIMEOUT_MS')
})

test('the shared timeout aborts a direct DeepSeek request', async () => {
  const { DeepSeekApiRunner } = await import('./deepSeekApi.js')
  process.env['BABEL_PROVIDER_REQUEST_TIMEOUT_MS'] = '40'
  process.env['BABEL_PROVIDER_REQUEST_MAX_RETRIES'] = '1'
  delete process.env['BABEL_DEEPSEEK_REQUEST_TIMEOUT_MS']
  delete process.env['BABEL_DEEPSEEK_REQUEST_MAX_RETRIES']
  delete process.env['BABEL_OFFLINE']
  let aborted = 0
  globalThis.fetch = (async (_input, init) => new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal
    if (!signal) return
    if (signal.aborted) { aborted += 1; reject(new DOMException('Request cancelled', 'AbortError')); return }
    signal.addEventListener('abort', () => { aborted += 1; reject(new DOMException('Request cancelled', 'AbortError')) }, { once: true })
  })) as typeof fetch
  const startedAt = Date.now()
  await assert.rejects(
    new DeepSeekApiRunner('deepseek-v4-flash', { explicitCredential: 'sk-inert-fixture' }).executeRaw('fixture'),
    /timeout after 40ms/,
  )
  assert.ok(Date.now() - startedAt < 2_000)
  assert.equal(aborted, 1)
})

test('the direct DeepSeek route records observed model identity and invocation boundaries', async () => {
  const { DeepSeekApiRunner } = await import('./deepSeekApi.js')
  delete process.env['BABEL_OFFLINE']
  const completed: Array<{ observed_model_id?: string | null }> = []
  globalThis.fetch = (async () => new Response(JSON.stringify({
    model: 'deepseek-v4-pro',
    choices: [{ message: { content: 'fixture answer' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
  }), { status: 200 })) as typeof fetch
  const callbacks: RunnerCallbacks = {
    onInvocationCompleted: event => { completed.push({ observed_model_id: event.observed_model_id ?? null }) },
  }
  const runner = new DeepSeekApiRunner('deepseek-v4-flash', { explicitCredential: 'sk-inert-fixture' })
  assert.equal(await runner.executeRaw('fixture', callbacks), 'fixture answer')
  const metadata = runner.getLastInvocationMetadata()
  assert.equal(metadata?.provider_model_id, 'deepseek-v4-flash')
  assert.equal(metadata?.requested_model_id, 'deepseek-v4-flash')
  assert.equal(metadata?.sent_model_id, 'deepseek-v4-flash')
  assert.equal(metadata?.observed_model_id, 'deepseek-v4-pro')
  assert.equal(completed.at(-1)?.observed_model_id, 'deepseek-v4-pro')
})

test('a response without a model field reports an absent observation, never the request', async () => {
  const { DeepSeekApiRunner } = await import('./deepSeekApi.js')
  delete process.env['BABEL_OFFLINE']
  globalThis.fetch = (async () => new Response(JSON.stringify({
    choices: [{ message: { content: 'fixture answer' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
  }), { status: 200 })) as typeof fetch
  const runner = new DeepSeekApiRunner('deepseek-v4-flash', { explicitCredential: 'sk-inert-fixture' })
  assert.equal(await runner.executeRaw('fixture'), 'fixture answer')
  assert.equal(runner.getLastInvocationMetadata()?.observed_model_id, null)
})
