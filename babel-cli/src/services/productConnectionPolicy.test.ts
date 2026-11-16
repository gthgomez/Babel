import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { isSyntheticProviderFixtureReady, runSyntheticProviderTestFile } from '../testinfra/synthetic-provider-fixture.mjs'

if (!isSyntheticProviderFixtureReady()) {
  test('product connection policy uses an isolated synthetic profile', {timeout:60000}, async t => {
    const result=await runSyntheticProviderTestFile(import.meta.url);t.diagnostic(JSON.stringify(result))
    assert.equal(result.exitCode,0);assert.ok(result.passed>0)
  })
} else {
const { connectProvider, connectionStatus, listConnections } = await import('./connectionSettings.js')
const { readUserSettings, updateUserSettings } = await import('../config/userSettings.js')
const { resolveChatModelPolicy } = await import('../agent/chatModelPolicy.js')
const { handleConnectionCommand } = await import('../commands/connectionCommands.js')
const { resolveAskModelPolicyWithLiveGate } = await import('./askAnswer.js')
const { withPipelineModelRoute } = await import('../execute.js')
const { withProductProviderPolicy } = await import('../runners/providerRegistry.js')

test('product connections reject unapproved providers and unauthenticated gateway settings without mutation', () => {
  const old = process.env['BABEL_STATE_DIR']; const root = mkdtempSync(join(tmpdir(), 'babel-product-policy-'))
  process.env['BABEL_STATE_DIR'] = root
  try {
    assert.throws(() => connectProvider('deepseek', { model: 'deepseek-v4-flash' }), /approved|supported/i)
    assert.throws(() => connectProvider('openrouter', { model: 'vendor/model', authentication: 'none' }), /credential|authentication/i)
    assert.throws(() => connectProvider('openrouter', { model: 'vendor/model', baseUrl: 'https://other.example.test' }), /endpoint|base.url/i)
    assert.deepEqual(readUserSettings().connections, {})
    assert.deepEqual(listConnections().providers.map(provider => provider.id).sort(), ['command-code', 'openrouter'])
  } finally {
    if (old === undefined) delete process.env['BABEL_STATE_DIR']; else process.env['BABEL_STATE_DIR'] = old
    rmSync(root, { recursive: true, force: true })
  }
})

test('legacy unapproved connections remain readable but cannot report ready or run', async () => {
  const old = process.env['BABEL_STATE_DIR']; const root = mkdtempSync(join(tmpdir(), 'babel-legacy-policy-'))
  process.env['BABEL_STATE_DIR'] = root
  try {
    updateUserSettings({ connections: { old: { id: 'old', provider: 'deepseek', model: 'deepseek-v4-flash' } }, defaults: { connection: 'old' } })
    assert.equal(connectionStatus().state, 'action_required')
    assert.equal(connectionStatus().reason, 'unsupported_provider')
    await withProductProviderPolicy(async () => {
      assert.throws(() => resolveChatModelPolicy({ model: 'connection/old/deepseek-v4-flash' }), /approved|supported/i)
      assert.throws(() => resolveAskModelPolicyWithLiveGate({ model: 'connection/old/deepseek-v4-flash' }, true), /approved|supported/i)
      await assert.rejects(withPipelineModelRoute('connection/old/deepseek-v4-flash', async () => {}), /approved|supported/i)
    })
    assert.equal(readUserSettings().connections.old?.provider, 'deepseek')
  } finally {
    if (old === undefined) delete process.env['BABEL_STATE_DIR']; else process.env['BABEL_STATE_DIR'] = old
    rmSync(root, { recursive: true, force: true })
  }
})

test('a saved gateway never reports readiness without its credential', () => {
  const env = { BABEL_STATE_DIR: mkdtempSync(join(tmpdir(), 'babel-no-auth-')) }
  try {
    updateUserSettings({ connections: { router: { id: 'router', provider: 'openrouter', model: 'vendor/model' } }, defaults: { connection: 'router' } }, { env })
    assert.equal(connectionStatus({}, process.cwd(), env).state, 'action_required')
    assert.equal(connectionStatus({}, process.cwd(), env).credential.present, false)
  } finally { rmSync(env.BABEL_STATE_DIR, { recursive: true, force: true }) }
})

test('a saved loopback-only local connection remains usable in explicitly offline mode', () => {
  const env = { BABEL_STATE_DIR: mkdtempSync(join(tmpdir(), 'babel-local-offline-')), BABEL_OFFLINE: '1' }
  try {
    updateUserSettings({ connections: { local: { id: 'local', provider: 'ollama', model: 'local-model' } }, defaults: { connection: 'local' } }, { env })
    assert.equal(connectionStatus({}, process.cwd(), env).state, 'configured_unverified')
    const remote = { ...env, BABEL_OLLAMA_BASE_URL: 'https://remote.example.test/v1' }
    assert.equal(connectionStatus({}, process.cwd(), remote).state, 'action_required')
  } finally { rmSync(env.BABEL_STATE_DIR, { recursive: true, force: true }) }
})

test('offline readiness does not claim a cloud connection is usable', () => {
  const env = { BABEL_STATE_DIR: mkdtempSync(join(tmpdir(), 'babel-cloud-offline-')), BABEL_OFFLINE:'1', OPENROUTER_API_KEY:'synthetic-key' }
  try {
    updateUserSettings({connections:{router:{id:'router',provider:'openrouter',model:'vendor/model'}},defaults:{connection:'router'}},{env})
    assert.equal(connectionStatus({},process.cwd(),env).state,'action_required')
    assert.equal(connectionStatus({},process.cwd(),env).reason,'offline')
  } finally { rmSync(env.BABEL_STATE_DIR,{recursive:true,force:true}) }
})

test('interactive provider switching retains the active chat owner and selects its new route', async () => {
  const old = process.env['BABEL_STATE_DIR']; const root = mkdtempSync(join(tmpdir(), 'babel-switch-policy-'))
  process.env['BABEL_STATE_DIR'] = root
  try {
    updateUserSettings({ connections: { router: { id: 'router', provider: 'openrouter', model: 'vendor/a' }, command: { id: 'command', provider: 'command-code', model: 'vendor/b' } }, defaults: { connection: 'router' } })
    let selected = ''; let closed = false
    const engine = { selectProviderModel: (model:string) => { selected = model }, closeAdmissionStore: () => { closed = true }, getProviderSelectionStatus: () => null }
    const ctx = { isRunning:false, state:{model:'connection/router/vendor/a',connectionId:'router',modelSource:'session'},
      chatEngine:engine, resolveCurrentTarget:()=>({targetRoot:process.cwd()}), saveSessionState:()=>{} }
    await handleConnectionCommand(ctx as never, 'provider', ['use','command'])
    assert.equal(selected,'connection/command/vendor/b')
    assert.equal(ctx.chatEngine,engine); assert.equal(closed,false)
    assert.equal(ctx.state.model,'connection/command/vendor/b')
  } finally {
    if (old === undefined) delete process.env['BABEL_STATE_DIR']; else process.env['BABEL_STATE_DIR'] = old
    rmSync(root, { recursive: true, force: true })
  }
})
}
