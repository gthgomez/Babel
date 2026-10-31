import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { isSyntheticProviderFixtureReady, prepareSyntheticProviderFixture, removeSyntheticProviderFixture, summarizeSyntheticProviderOutput } from '../testinfra/synthetic-provider-fixture.mjs'

if (!isSyntheticProviderFixtureReady()) {
  test('provider selection uses an isolated synthetic profile', async t => {
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
    assert.deepEqual(JSON.parse(diagnostic), { exitCode: 0, tests: 5, passed: 5, failed: 0, skipped: 0, isolationRejected: false, networkDispatchBlocked: false })
  })
} else {
  const { resolveChatDeliberationRunner, resolveChatSynthesisRunner, resolveChatFallbackRunner } = await import('./chatEngineProviderRuntime.js')
  const { resolveModelByKey } = await import('../modelPolicy.js')
  const { ProviderEngine } = await import('../runners/providerEngine.js')
  const { resolveConnectionModelPolicy } = await import('../config/connectionModelPolicy.js')

  test('missing Chat selection does not invent a provider or model', () => {
    assert.throws(() => resolveChatDeliberationRunner(null, undefined), /setup|selection|select/i)
    assert.throws(() => resolveChatSynthesisRunner(null, undefined), /setup|selection|select/i)
  })

  test('Chat deliberation and synthesis use the canonical engine for the exact policy route', () => {
    const policy = resolveModelByKey({ key: 'deepseek-v4-flash-openrouter' })
    const deliberation = resolveChatDeliberationRunner(null, policy)
    const synthesis = resolveChatSynthesisRunner(null, policy)
    assert.equal(deliberation instanceof ProviderEngine, true)
    assert.equal(synthesis instanceof ProviderEngine, true)
    assert.equal((deliberation as InstanceType<typeof ProviderEngine>).provider, policy.provider)
    assert.equal((deliberation as InstanceType<typeof ProviderEngine>).modelId, policy.providerModelId)
  })

  test('an unconfigured fallback never guesses a credentialed provider', () => {
    assert.equal(resolveChatFallbackRunner(null, {}, undefined), null)
  })

  test('model output capacity does not inflate the transport default budget', () => {
    const policy = { ...resolveModelByKey({ key: 'deepseek-v4-flash-openrouter' }), maxOutputTokens: 128_000 }
    const runner = resolveChatDeliberationRunner(null, policy) as InstanceType<typeof ProviderEngine>
    const wire = JSON.parse(runner.buildNativeToolsWireBody([{ role: 'user', content: 'fixture' }], []))
    assert.equal(wire.max_tokens, 32_000)
    assert.equal(runner.getNativeRequestReservedCompletionTokens(), 32_000)
  })

  test('an explicitly saved connection output budget reaches the actual wire body', () => {
    const policy = resolveConnectionModelPolicy(undefined, { settings: {
      schemaVersion: 1, connections: { fixture: { id: 'fixture', provider: 'openrouter', model: 'Vendor/Exact-Case', maxOutputTokens: 64 } },
      defaults: { connection: 'fixture' },
    } })
    assert.ok(policy)
    assert.equal(policy.requestedOutputTokens, 64)
    const runner = resolveChatDeliberationRunner(null, policy) as InstanceType<typeof ProviderEngine>
    const wire = JSON.parse(runner.buildNativeToolsWireBody([{ role: 'user', content: 'fixture' }], []))
    assert.equal(wire.max_tokens, 64)
    assert.equal(runner.getNativeRequestReservedCompletionTokens(), 64)
  })
}
