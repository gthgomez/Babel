import assert from 'node:assert/strict'
import test from 'node:test'
import { isSyntheticProviderFixtureReady, runSyntheticProviderTestFile } from '../testinfra/synthetic-provider-fixture.mjs'

if (!isSyntheticProviderFixtureReady()) {
  test('offline provider boundaries use an isolated synthetic profile', {timeout:60000}, async t => {
    const result = await runSyntheticProviderTestFile(import.meta.url); t.diagnostic(JSON.stringify(result))
    assert.equal(result.exitCode, 0); assert.ok(result.passed > 0)
  })
} else {
const { DeepSeekApiRunner } = await import('./deepSeekApi.js')
const { AnthropicApiRunner } = await import('./anthropicApi.js')
const { OllamaApiRunner } = await import('./ollamaApi.js')
const { ProviderEngine } = await import('./providerEngine.js')

test('offline mode prevents direct cloud adapters and remote local-model endpoints from dispatching', async () => {
  const oldOffline = process.env['BABEL_OFFLINE']
  const oldBase = process.env['BABEL_OLLAMA_BASE_URL']
  const oldFetch = globalThis.fetch
  let calls = 0
  try {
    process.env['BABEL_OFFLINE'] = '1'
    process.env['BABEL_OLLAMA_BASE_URL'] = 'https://remote.example.test/v1'
    globalThis.fetch = async () => { calls++; return new Response('{}', { status: 401 }) }
    const runners = [
      new DeepSeekApiRunner('deepseek-v4-flash', { explicitCredential: 'sk-synthetic' }),
      new AnthropicApiRunner({ modelId: 'fixture', explicitCredential: 'synthetic' }),
      new OllamaApiRunner('fixture'),
    ]
    for (const runner of runners) await assert.rejects(runner.executeRaw('fixture'), /offline/i)
    assert.equal(calls, 0)
  } finally {
    globalThis.fetch = oldFetch
    if (oldOffline === undefined) delete process.env['BABEL_OFFLINE']; else process.env['BABEL_OFFLINE'] = oldOffline
    if (oldBase === undefined) delete process.env['BABEL_OLLAMA_BASE_URL']; else process.env['BABEL_OLLAMA_BASE_URL'] = oldBase
  }
})

test('an explicitly offline runner environment cannot be bypassed by the process environment', async () => {
  const oldOffline = process.env['BABEL_OFFLINE']; const oldFetch = globalThis.fetch
  let calls = 0
  try {
    delete process.env['BABEL_OFFLINE']
    globalThis.fetch = async () => { calls++; return new Response('{}', { status: 401 }) }
    const runner = new ProviderEngine({ provider: 'openrouter', modelId: 'fixture',
      env: { BABEL_OFFLINE: '1', OPENROUTER_API_KEY: 'synthetic' } })
    await assert.rejects(async () => runner.executeRaw('fixture'), /offline/i)
    assert.equal(calls, 0)
  } finally {
    globalThis.fetch = oldFetch
    if (oldOffline === undefined) delete process.env['BABEL_OFFLINE']; else process.env['BABEL_OFFLINE'] = oldOffline
  }
})

test('offline loopback requests reject redirects that could escape to a remote endpoint', async () => {
  const oldOffline = process.env['BABEL_OFFLINE']; const oldBase = process.env['BABEL_OLLAMA_BASE_URL']; const oldFetch = globalThis.fetch
  try {
    process.env['BABEL_OFFLINE'] = '1'; process.env['BABEL_OLLAMA_BASE_URL'] = 'http://127.0.0.1:11434/v1'
    let redirect: string | undefined
    globalThis.fetch = async (_url, init) => {
      redirect = init?.redirect
      return new Response(JSON.stringify({ model: 'fixture', choices: [{ message: { content: 'local' }, finish_reason: 'stop' }] }))
    }
    assert.equal(await new OllamaApiRunner('fixture').executeRaw('fixture'), 'local')
    assert.equal(redirect, 'error')
  } finally {
    globalThis.fetch = oldFetch
    if (oldOffline === undefined) delete process.env['BABEL_OFFLINE']; else process.env['BABEL_OFFLINE'] = oldOffline
    if (oldBase === undefined) delete process.env['BABEL_OLLAMA_BASE_URL']; else process.env['BABEL_OLLAMA_BASE_URL'] = oldBase
  }
})
}
