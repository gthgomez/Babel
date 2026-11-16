import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isSyntheticProviderFixtureReady, runSyntheticProviderTestFile } from '../testinfra/synthetic-provider-fixture.mjs'

if (!isSyntheticProviderFixtureReady()) {
  test('provider setup uses an isolated synthetic profile', {timeout:60000}, async t => {
    const result=await runSyntheticProviderTestFile(import.meta.url);t.diagnostic(JSON.stringify(result))
    assert.equal(result.exitCode,0);assert.ok(result.passed>0)
  })
} else {
test('noninteractive setup prints the private file and a placeholder example', async () => {
  const { runProviderSetup } = await import('./providerSetup.js')
  const dir = mkdtempSync(join(tmpdir(), 'babel-setup-example-'))
  const env = { BABEL_CONFIG_DIR: dir, BABEL_STATE_DIR: join(dir, 'state'), OPENROUTER_API_KEY: 'sentinel-do-not-print' }
  let output = ''
  const result = await runProviderSetup({ env, interactive: false, write: text => { output += text } })
  assert.equal(result.state, 'setup_required')
  assert.match(output, /babel-harness setup/)
  assert.match(output, /your-key-here/)
  assert.match(output, /OPENROUTER_API_KEY=your-key-here/)
  assert.match(output, /COMMAND_CODE_API_KEY=your-key-here/)
  assert.doesNotMatch(output, /DEEPINFRA_API_KEY|Ollama/)
  assert.ok(output.includes(join(dir, '.env')))
  assert.equal(output.includes('sentinel-do-not-print'), false)
})

test('noninteractive fresh setup provides guidance without inference or selecting a provider', async () => {
  const { runProviderSetup } = await import('./providerSetup.js')
  const env = { BABEL_STATE_DIR: mkdtempSync(join(tmpdir(), 'babel-setup-')) }
  const result = await runProviderSetup({ env, interactive: false, write: () => {} })
  assert.equal(result.state, 'setup_required')
  assert.equal(result.connection, null)
})

test('guided coding setup rejects unsupported providers before saving a connection', async () => {
  const { runProviderSetup } = await import('./providerSetup.js')
  const { readUserSettings } = await import('../config/userSettings.js')
  for (const provider of ['groq', 'opencode']) {
    const env = { BABEL_STATE_DIR: mkdtempSync(join(tmpdir(), 'babel-setup-unqualified-')) }
    let questions = 0; let output = ''
    await assert.rejects(runProviderSetup({ env, interactive: true,
      question: async () => { questions++; return provider }, write: text => { output += text } }), /approved provider/i)
    assert.equal(questions, 1)
    assert.match(output, /openrouter.*command-code/)
    assert.deepEqual(readUserSettings({ env }).connections, {})
  }
})

test('setup preserves an existing budget while saving an explicit model without persisting a key', async () => {
  const { runProviderSetup } = await import('./providerSetup.js')
  const { readUserSettings, updateUserSettings } = await import('../config/userSettings.js')
  const env = { BABEL_STATE_DIR: mkdtempSync(join(tmpdir(), 'babel-setup-')), OPENROUTER_API_KEY: 'fixture-only' }
  updateUserSettings({ defaults: { budgetUsd: 5 } }, { env })
  const answers = ['openrouter', 'vendor/exact-model']
  const result = await runProviderSetup({ env, interactive: true, question: async () => answers.shift() ?? '', write: () => {} })
  assert.equal(result.state, 'configured_unverified')
  const settings = readUserSettings({ env })
  assert.equal(settings.defaults?.connection, 'openrouter')
  assert.equal(settings.connections['openrouter']?.model, 'vendor/exact-model')
  assert.equal(settings.defaults?.budgetUsd, 5)
  assert.equal(settings.setup?.completed, true)
  assert.equal(JSON.stringify(settings).includes(env.OPENROUTER_API_KEY), false)
})

test('guided setup selects a catalog model without requiring a budget or token settings', async () => {
  const { runProviderSetup } = await import('./providerSetup.js')
  const { readUserSettings } = await import('../config/userSettings.js')
  const env = { BABEL_STATE_DIR: mkdtempSync(join(tmpdir(), 'babel-setup-simple-')), OPENROUTER_API_KEY: 'fixture-only' }
  const answers = ['openrouter', '1']; const prompts: string[] = []; let output = ''
  const result = await runProviderSetup({ env, interactive: true, question: async prompt => { prompts.push(prompt); return answers.shift() ?? '' }, write: text => { output += text } })
  const settings = readUserSettings({ env })
  assert.equal(result.state, 'configured_unverified')
  assert.equal(result.provider, 'openrouter')
  assert.ok(result.model)
  assert.equal(prompts.length, 2)
  assert.equal(settings.defaults?.budgetUsd, undefined)
  assert.doesNotMatch(output, /fixture-only/)
  assert.match(output, /unverified/i)
})

test('a fresh user can accept a catalog suggestion for either approved provider without a network request', async () => {
  const { runProviderSetup } = await import('./providerSetup.js')
  for (const [provider, variable] of [['openrouter', 'OPENROUTER_API_KEY'], ['command-code', 'COMMAND_CODE_API_KEY']] as const) {
    const env = { BABEL_STATE_DIR: mkdtempSync(join(tmpdir(), 'babel-setup-default-')), [variable]: 'fixture-only' }
    const answers = [provider, '']; let output = ''
    const result = await runProviderSetup({ env, interactive: true, question: async () => answers.shift() ?? '', write: text => { output += text } })
    assert.equal(result.state, 'configured_unverified', provider)
    assert.ok(result.model, provider)
    assert.match(output, /suggested|default/i)
    assert.match(output, /unverified/i)
  }
})

test('standalone setup does not offer a process-only key that will disappear on exit', async () => {
  const { runProviderSetup } = await import('./providerSetup.js')
  const env = { BABEL_STATE_DIR: mkdtempSync(join(tmpdir(), 'babel-setup-standalone-')) }
  const answers = ['openrouter', 'k']; const prompts: string[] = []
  const result = await runProviderSetup({ env, interactive: true, question: async prompt => { prompts.push(prompt); return answers.shift() ?? '' }, write: () => {} })
  assert.equal(result.state, 'action_required')
  assert.doesNotMatch(prompts.join(' '), /session only/i)
  assert.match(prompts.join(' '), /plaintext|skip/i)
})

test('guided setup saves a protected account reference without exposing the key in settings or environment', async () => {
  const { runProviderSetup } = await import('./providerSetup.js')
  const { readUserSettings } = await import('../config/userSettings.js')
  const env = { BABEL_STATE_DIR: mkdtempSync(join(tmpdir(), 'babel-setup-protected-')) }
  const ref = 'babel-os-v1:11111111-1111-4111-8111-111111111111'
  const answers = ['openrouter', '', 'vendor/model']; let calls = 0
  const result = await runProviderSetup({ env, interactive: true, question: async () => answers.shift() ?? '', write: () => {},
    promptProtectedCredential: async () => { calls++; return ref } })
  assert.equal(result.state, 'configured_unverified')
  assert.equal(calls, 1)
  assert.equal(readUserSettings({ env }).connections.openrouter?.credentialRef, ref)
  assert.equal('OPENROUTER_API_KEY' in env, false)
})

test('explicit setup can repair a protected account without adopting an ambient key', async () => {
  const { runProviderSetup } = await import('./providerSetup.js')
  const { readUserSettings, updateUserSettings } = await import('../config/userSettings.js')
  const env = { BABEL_STATE_DIR: mkdtempSync(join(tmpdir(), 'babel-setup-repair-')), OPENROUTER_API_KEY: 'synthetic-other-account' }
  const oldRef = 'babel-os-v1:11111111-1111-4111-8111-111111111111'
  const newRef = 'babel-os-v1:22222222-2222-4222-8222-222222222222'
  updateUserSettings({ connections: { openrouter: { id: 'openrouter', provider: 'openrouter', model: 'vendor/model', credentialRef: oldRef } }, defaults: { connection: 'openrouter' } }, { env })
  const answers = ['', 'r', '']; let calls = 0
  const result = await runProviderSetup({ env, interactive: true, sessionCredentials: true, offerCredentialReplacement: true,
    question: async () => answers.shift() ?? '', write: () => {}, promptProtectedCredential: async () => { calls++; return newRef } })
  assert.equal(result.state, 'configured_unverified')
  assert.equal(calls, 1)
  assert.equal(readUserSettings({ env }).connections.openrouter?.credentialRef, newRef)
})

test('saving cloud choices while offline does not announce a usable connection', async () => {
  const { runProviderSetup } = await import('./providerSetup.js')
  const env={BABEL_STATE_DIR:mkdtempSync(join(tmpdir(),'babel-setup-offline-')),BABEL_OFFLINE:'1',OPENROUTER_API_KEY:'fixture-only'}
  const answers=['openrouter','vendor/model'];let output=''
  const result=await runProviderSetup({env,interactive:true,question:async()=>answers.shift()??'',write:text=>{output+=text}})
  assert.equal(result.state,'action_required')
  assert.match(output,/offline|action required/i)
  assert.doesNotMatch(output,/Configured, connectivity unverified/i)
})

test('setup reports the chosen connection even when a project has a different saved preference', async () => {
  const { runProviderSetup }=await import('./providerSetup.js')
  const { updateUserSettings,readUserSettings }=await import('../config/userSettings.js')
  const env={BABEL_STATE_DIR:mkdtempSync(join(tmpdir(),'babel-setup-project-')),OPENROUTER_API_KEY:'fixture-router',COMMAND_CODE_API_KEY:'fixture-command'}
  const root=process.cwd()
  updateUserSettings({connections:{old:{id:'old',provider:'openrouter',model:'vendor/old'}},projects:{[root]:{connection:'old',model:'vendor/old'}}},{env})
  const answers=['command-code','vendor/new'];let output=''
  const result=await runProviderSetup({env,projectRoot:root,interactive:true,question:async()=>answers.shift()??'',write:text=>{output+=text}})
  assert.equal(result.connection,'command-code');assert.equal(result.model,'vendor/new')
  assert.equal(readUserSettings({env}).projects?.[root]?.connection,'old')
  assert.match(output,/different route/i);assert.doesNotMatch(output,/Type a task/i)
})

test('guided setup refuses a registered provider outside the approved product policy', async () => {
  const { runProviderSetup } = await import('./providerSetup.js')
  const { readUserSettings } = await import('../config/userSettings.js')
  const env = { BABEL_STATE_DIR: mkdtempSync(join(tmpdir(), 'babel-setup-policy-')) }
  await assert.rejects(runProviderSetup({ env, interactive: true, question: async () => 'deepseek', write: () => {} }), /approved|supported/i)
  assert.deepEqual(readUserSettings({ env }).connections, {})
})
}
