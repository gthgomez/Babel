import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { isSyntheticProviderFixtureReady, prepareSyntheticProviderFixture, removeSyntheticProviderFixture, summarizeSyntheticProviderOutput } from '../testinfra/synthetic-provider-fixture.mjs'

if (!isSyntheticProviderFixtureReady()) {
  test('external inference ownership uses an isolated network-blocked profile', async t => {
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
    assert.deepEqual(JSON.parse(diagnostic), { exitCode: 0, tests: 4, passed: 4, failed: 0, skipped: 0, isolationRejected: false, networkDispatchBlocked: false })
  })
} else {
  const { ChatEngine } = await import('../agent/chatEngine.js')
  const options = { task: 'External session ownership', projectRoot: process.cwd(), executionProfile: 'chat' as const }

  test('native inference still requires an explicit provider selection', () => {
    assert.throws(() => new ChatEngine(options), /SETUP_REQUIRED/)
  })

  test('external session containers have no fabricated Babel provider identity', () => {
    const engine = new ChatEngine({ ...options, inferenceOwner: 'external-harness' })
    assert.deepEqual(engine.getProviderSelectionStatus(), {
      provider: null, connection: null, requestedModel: null, sentModel: null, observedModel: null,
    })
    assert.throws(() => engine.submitMessageStream('must not dispatch'), /EXTERNAL_HARNESS_INFERENCE_OWNED/)
  })

  test('external inference ownership ignores ambient Babel model selection', () => {
    process.env['BABEL_MODEL'] = 'unselected-ambient-route'
    try {
      const engine = new ChatEngine({ ...options, inferenceOwner: 'external-harness' })
      assert.equal(engine.getProviderSelectionStatus().provider, null)
      assert.throws(() => engine.submitMessageStream('must not dispatch'), /EXTERNAL_HARNESS_INFERENCE_OWNED/)
    } finally { delete process.env['BABEL_MODEL'] }
  })

  test('external inference ownership cannot recruit an injected Babel runner', () => {
    for (const conflict of [{ providerRunner: {} as never }, { providerPolicy: {} as never }, { model: 'fixture' }, { provider: 'openai' }, { modelTier: 'cheap' }]) {
      assert.throws(() => new ChatEngine({ ...options, inferenceOwner: 'external-harness', ...conflict }), /EXTERNAL_HARNESS_INFERENCE_CONFLICT/)
    }
  })
}
