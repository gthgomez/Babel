import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { isSyntheticProviderFixtureReady, prepareSyntheticProviderFixture, removeSyntheticProviderFixture, summarizeSyntheticProviderOutput } from '../testinfra/synthetic-provider-fixture.mjs'

if (!isSyntheticProviderFixtureReady()) {
  test('offline routing boundaries use an isolated synthetic profile', async t => {
    const fixture = prepareSyntheticProviderFixture()
    t.after(() => removeSyntheticProviderFixture(fixture.root))
    const child = spawn(process.execPath, [
      '--experimental-wasm-modules', '--import', new URL('../testinfra/synthetic-provider-fixture.mjs', import.meta.url).href,
      '--import', import.meta.resolve('tsx'), '--import', new URL('../testinfra/register-no-ambient-inference.mjs', import.meta.url).href,
      '--test', '--test-reporter=tap', fileURLToPath(import.meta.url),
    ], { cwd: fixture.cwd, env: fixture.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', chunk => { output += String(chunk) })
    child.stderr.on('data', chunk => { output += String(chunk) })
    const code = await new Promise<number>(resolve => { child.once('error', () => resolve(1)); child.once('close', value => resolve(value ?? 1)) })
    const diagnostic = summarizeSyntheticProviderOutput(output, code)
    t.diagnostic(diagnostic)
    assert.equal(code, 0, diagnostic)
    const summary = JSON.parse(diagnostic) as { tests: number; passed: number; failed: number; networkDispatchBlocked: boolean }
    assert.equal(summary.failed, 0)
    assert.ok(summary.passed >= 7)
    assert.equal(summary.networkDispatchBlocked, false)
  })
} else {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { updateUserSettings } = await import('../config/userSettings.js')
  const { resolveChatModelPolicy } = await import('../agent/chatModelPolicy.js')
  const { createProviderRunner } = await import('../runners/providerEngine.js')
  const { DeepSeekApiRunner } = await import('../runners/deepSeekApi.js')
  const { OllamaApiRunner } = await import('../runners/ollamaApi.js')

  const stateRoot = mkdtempSync(join(tmpdir(), 'w07-offline-state-'))
  const savedEnv = {
    offline: process.env['BABEL_OFFLINE'],
    state: process.env['BABEL_STATE_DIR'],
    ollamaBase: process.env['BABEL_OLLAMA_BASE_URL'],
  }
  process.env['BABEL_STATE_DIR'] = stateRoot

  function restoreEnv(): void {
    for (const [key, value] of [['BABEL_OFFLINE', savedEnv.offline], ['BABEL_STATE_DIR', savedEnv.state], ['BABEL_OLLAMA_BASE_URL', savedEnv.ollamaBase]] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }

  test('offline rejects a saved HTTPS connection before any runner exists', async t => {
    const originalFetch = globalThis.fetch
    let calls = 0
    t.after(() => { globalThis.fetch = originalFetch; restoreEnv() })
    updateUserSettings({ connections: { saved: { id: 'saved', provider: 'deepseek' as const, model: 'deepseek-v4-flash' } }, defaults: { connection: 'saved', model: 'deepseek-v4-flash' } })
    process.env['BABEL_OFFLINE'] = '1'
    globalThis.fetch = (async () => { calls += 1; return new Response('{}', { status: 401 }) }) as typeof fetch
    assert.throws(() => resolveChatModelPolicy({}), /OFFLINE_MODE_UNAVAILABLE.*deepseek/i)
    assert.equal(calls, 0)
  })

  test('offline blocks remote transport construction and direct dispatch', async t => {
    const originalFetch = globalThis.fetch
    let calls = 0
    t.after(() => { globalThis.fetch = originalFetch; restoreEnv() })
    process.env['BABEL_OFFLINE'] = '1'
    globalThis.fetch = (async () => { calls += 1; return new Response('{}', { status: 401 }) }) as typeof fetch
    assert.throws(() => createProviderRunner({ provider: 'deepseek', modelId: 'deepseek-v4-flash', explicitCredential: 'sk-inert-fixture' }), /OFFLINE_MODE_UNAVAILABLE/)
    const direct = new DeepSeekApiRunner('deepseek-v4-flash', { explicitCredential: 'sk-inert-fixture' })
    await assert.rejects(direct.executeRaw('fixture'), /OFFLINE_MODE_UNAVAILABLE/)
    assert.equal(calls, 0)
  })

  test('offline request is a hard boundary for an already constructed runner', async t => {
    const originalFetch = globalThis.fetch
    let calls = 0
    t.after(() => { globalThis.fetch = originalFetch; restoreEnv() })
    delete process.env['BABEL_OFFLINE']
    const runner = createProviderRunner({ provider: 'deepseek', modelId: 'deepseek-v4-flash', explicitCredential: 'sk-inert-fixture' })
    process.env['BABEL_OFFLINE'] = '1'
    globalThis.fetch = (async () => { calls += 1; return new Response('{}', { status: 401 }) }) as typeof fetch
    await assert.rejects(async () => runner.executeRaw('fixture'), /OFFLINE_MODE_UNAVAILABLE/)
    assert.equal(calls, 0)
  })

  test('offline permits an explicitly loopback Ollama endpoint', async t => {
    const originalFetch = globalThis.fetch
    let calls = 0
    t.after(() => { globalThis.fetch = originalFetch; restoreEnv() })
    process.env['BABEL_OFFLINE'] = '1'
    delete process.env['BABEL_OLLAMA_BASE_URL']
    globalThis.fetch = (async () => {
      calls += 1
      return new Response(JSON.stringify({ model: 'llama3:8b', choices: [{ message: { content: 'local answer' }, finish_reason: 'stop' }] }), { status: 200 })
    }) as typeof fetch
    const runner = new OllamaApiRunner('llama3:8b', { baseUrl: 'http://127.0.0.1:11434/v1' })
    assert.equal(await runner.executeRaw('fixture'), 'local answer')
    assert.equal(calls, 1)
  })

  test('offline refuses a remote Ollama base URL at the dispatch boundary', async t => {
    const originalFetch = globalThis.fetch
    let calls = 0
    t.after(() => { globalThis.fetch = originalFetch; restoreEnv() })
    process.env['BABEL_OFFLINE'] = '1'
    globalThis.fetch = (async () => { calls += 1; return new Response('{}', { status: 200 }) }) as typeof fetch
    await assert.rejects(
      new OllamaApiRunner('llama3:8b', { baseUrl: 'https://remote.example.test/v1' }).executeRaw('fixture'),
      /OFFLINE_MODE_UNAVAILABLE/,
    )
    assert.equal(calls, 0)
  })

  test('BABEL_OFFLINE without a local model never invents a family or provider', t => {
    t.after(restoreEnv)
    process.env['BABEL_OFFLINE'] = '1'
    assert.throws(() => resolveChatModelPolicy({}), /OFFLINE_MODEL_REQUIRED/)
  })

  test('a saved loopback Ollama connection resolves offline without setup errors', t => {
    t.after(restoreEnv)
    updateUserSettings({ connections: { local: { id: 'local', provider: 'ollama' as const, model: 'llama3:8b', baseUrl: 'http://127.0.0.1:11434/v1' } }, defaults: { connection: 'local', model: 'llama3:8b' } })
    process.env['BABEL_OFFLINE'] = '1'
    const { policy, offline } = resolveChatModelPolicy({})
    assert.equal(offline, true)
    assert.equal(policy.provider, 'ollama')
    assert.equal(policy.providerModelId, 'llama3:8b')
    assert.equal(policy.baseUrl, 'http://127.0.0.1:11434/v1')
  })
}
