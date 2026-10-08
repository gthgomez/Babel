import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import {
  prepareSyntheticProviderFixture, removeSyntheticProviderFixture,
  summarizeSyntheticProviderOutput,
} from './synthetic-provider-fixture.mjs'

async function captureSyntheticChild(script: string, extraEnv: Record<string, string> = {}) {
  const fixture = prepareSyntheticProviderFixture()
  const child = spawn(process.execPath, [
    '--import', new URL('./synthetic-provider-fixture.mjs', import.meta.url).href,
    '--import', import.meta.resolve('tsx'),
    '--input-type=module', '--eval', script,
  ], { cwd: fixture.cwd, env: { ...fixture.env, ...extraEnv }, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', chunk => { output += String(chunk) })
  child.stderr.on('data', chunk => { output += String(chunk) })
  const code = await new Promise<number>(resolve => {
    child.once('error', () => resolve(1))
    child.once('close', value => resolve(value ?? 1))
  })
  removeSyntheticProviderFixture(fixture.root)
  return { code, output, diagnostic: summarizeSyntheticProviderOutput(output, code) }
}

test('fixture environment drops arbitrary inherited credentials and loader/helper overrides', async () => {
  const prior = process.env['BABEL_FIXTURE_INHERITANCE_CANARY']
  process.env['BABEL_FIXTURE_INHERITANCE_CANARY'] = 'synthetic-inheritance-canary'
  try {
    const result = await captureSyntheticChild(`
      import { homedir } from 'node:os'
      import { resolve } from 'node:path'
      const absent = ['BABEL_FIXTURE_INHERITANCE_CANARY', 'LITELLM_PROXY_API_KEY',
        'NODE_OPTIONS', 'BABEL_MODEL_POLICY_PATH', 'BABEL_ALLOW_HOST_FALLBACK',
        'BABEL_AUTONOMY_LEASE', 'HTTP_PROXY', 'HTTPS_PROXY', 'HOMEDRIVE',
        'HOMEPATH', 'LOGONSERVER', 'SYSTEMDRIVE', 'USERDOMAIN', 'USERNAME']
      if (absent.some(key => process.env[key] !== undefined)) throw new Error('UNSAFE_INHERITANCE')
      if (resolve(homedir()) !== resolve(process.env.HOME)) throw new Error('UNSAFE_HOME')
      console.log('fixture roots and inheritance valid')
    `)
    assert.equal(result.code, 0, 'child inheritance/home check must pass')
    assert.ok(result.output.includes('fixture roots and inheritance valid'))
    assert.ok(!result.diagnostic.includes('synthetic-inheritance-canary'))
  } finally {
    if (prior === undefined) delete process.env['BABEL_FIXTURE_INHERITANCE_CANARY']
    else process.env['BABEL_FIXTURE_INHERITANCE_CANARY'] = prior
  }
})

test('fixture rejects injected credential environment before script execution', async () => {
  const result = await captureSyntheticChild("console.log('SCRIPT_EXECUTED')", {
    LITELLM_PROXY_API_KEY: 'synthetic-unapproved-canary',
  })
  assert.ok(result.code !== 0)
  assert.ok(result.output.includes('SYNTHETIC_PROVIDER_FIXTURE_ISOLATION_INVALID'))
  assert.ok(!result.output.includes('SCRIPT_EXECUTED'))
  assert.ok(!result.diagnostic.includes('synthetic-unapproved-canary'))
})

test('fixture permits numeric test worker identity but rejects arbitrary worker payloads', async () => {
  const zero = await captureSyntheticChild("console.log('WORKER_ZERO_READY')", { NODE_TEST_WORKER_ID: '0' })
  assert.equal(zero.code, 0)
  assert.ok(zero.output.includes('WORKER_ZERO_READY'))
  const valid = await captureSyntheticChild("console.log('WORKER_READY')", { NODE_TEST_WORKER_ID: '3' })
  assert.equal(valid.code, 0)
  assert.ok(valid.output.includes('WORKER_READY'))
  const invalid = await captureSyntheticChild("console.log('SCRIPT_EXECUTED')", { NODE_TEST_WORKER_ID: 'not-a-worker-number' })
  assert.notEqual(invalid.code, 0)
  assert.ok(invalid.output.includes('SYNTHETIC_PROVIDER_FIXTURE_ISOLATION_INVALID'))
  assert.ok(!invalid.output.includes('SCRIPT_EXECUTED'))
})

test('credential resolvers see only the synthetic helper and fresh home', async () => {
  const goModule = new URL('../runners/openCodeGoCredential.ts', import.meta.url).href
  const hubModule = new URL('../runners/credentialHub.ts', import.meta.url).href
  const result = await captureSyntheticChild(`
    import { join, resolve } from 'node:path'
    const go = await import(${JSON.stringify(goModule)})
    const hub = await import(${JSON.stringify(hubModule)})
    if (resolve(go.BABEL_OPENCODE_GO_HELPER_PATH) !==
      resolve(join(process.env.HOME, '.config', 'babel', 'get-auth-token.js'))) throw new Error('UNSAFE_HELPER_HOME')
    if (resolve(go.DEPRECATED_CLAUDE_HELPER_PATH) !==
      resolve(join(process.env.HOME, '.claude', 'get-auth-token.js'))) throw new Error('UNSAFE_LEGACY_HOME')
    const goCredential = go.resolveOpenCodeGoCredential({ source: 'opencode-auth-helper' })
    if (goCredential.credential !== 'synthetic-go-credential') throw new Error('UNSAFE_GO_CREDENTIAL')
    if (hub.resolveProviderCredential('openrouter') !== 'synthetic-router-credential') throw new Error('UNSAFE_ROUTER_CREDENTIAL')
    console.log('credential lookup boundary valid')
  `)
  assert.equal(result.code, 0, 'credential lookup isolation must pass')
  assert.ok(result.output.includes('credential lookup boundary valid'))
  assert.ok(!result.diagnostic.includes('synthetic-go-credential'))
  assert.ok(!result.diagnostic.includes('synthetic-router-credential'))
})

test('fixture blocks fetch and alternate HTTP/socket dispatch before provider imports', async () => {
  const result = await captureSyntheticChild(`
    import assert from 'node:assert/strict'
    import { request } from 'node:https'
    import { connect } from 'node:net'
    await assert.rejects(() => fetch('https://opencode.ai/zen/go/v1/chat/completions'),
      /SYNTHETIC_PROVIDER_NETWORK_DISPATCH_BLOCKED/)
    assert.throws(() => request('https://openrouter.ai/api/v1/chat/completions'),
      /SYNTHETIC_PROVIDER_NETWORK_DISPATCH_BLOCKED/)
    assert.throws(() => connect({ host: '127.0.0.1', port: 443 }),
      /SYNTHETIC_PROVIDER_NETWORK_DISPATCH_BLOCKED/)
    console.log('network boundary valid')
  `)
  assert.equal(result.code, 0, 'synthetic network guard checks must pass')
  assert.ok(result.output.includes('network boundary valid'))
})

test('failing object assertion cannot publish its synthetic secret canary', async () => {
  // Deliberate failure control only: it runs after the synthetic bootstrap, never on a real runner.
  const canary = 'synthetic-assertion-secret-canary'
  const result = await captureSyntheticChild(`
    import assert from 'node:assert/strict'
    assert.equal({ apiKey: '${canary}', environment: { TOKEN: '${canary}' } }, null)
  `)
  assert.ok(result.code !== 0, 'failure control must actually fail')
  assert.ok(result.output.includes(canary), 'synthetic control must exercise assertion serialization')
  assert.ok(!result.diagnostic.includes(canary), 'published scalar diagnostics must omit the canary')
  assert.ok(!result.diagnostic.includes('apiKey'))
  assert.ok(!result.diagnostic.includes('environment'))
})
