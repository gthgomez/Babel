import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('noninteractive fresh setup provides guidance without inference or selecting a provider', async () => {
  const { runProviderSetup } = await import('./providerSetup.js')
  const env = { BABEL_STATE_DIR: mkdtempSync(join(tmpdir(), 'babel-setup-')) }
  const result = await runProviderSetup({ env, interactive: false, write: () => {} })
  assert.equal(result.state, 'setup_required')
  assert.equal(result.connection, null)
})

test('guided coding setup explains unqualified providers before saving a connection', async () => {
  const { runProviderSetup } = await import('./providerSetup.js')
  const { readUserSettings } = await import('../config/userSettings.js')
  for (const provider of ['groq', 'opencode']) {
    const env = { BABEL_STATE_DIR: mkdtempSync(join(tmpdir(), 'babel-setup-unqualified-')) }
    let questions = 0; let output = ''
    await assert.rejects(runProviderSetup({ env, interactive: true,
      question: async () => { questions++; return provider }, write: text => { output += text } }), /UNSUPPORTED_OPERATION/)
    assert.equal(questions, 1)
    assert.match(output, /not yet qualified for coding/)
    assert.deepEqual(readUserSettings({ env }).connections, {})
  }
})

test('setup saves explicit provider model and budget without persisting a key', async () => {
  const { runProviderSetup } = await import('./providerSetup.js')
  const { readUserSettings } = await import('../config/userSettings.js')
  const env = { BABEL_STATE_DIR: mkdtempSync(join(tmpdir(), 'babel-setup-')), OPENROUTER_API_KEY: 'fixture-only' }
  const answers = ['openrouter', 'personal', 'vendor/exact-model', '128000', '8192', '5', 'yes']
  const result = await runProviderSetup({ env, interactive: true, question: async () => answers.shift() ?? '', write: () => {} })
  assert.equal(result.state, 'configured_unverified')
  const settings = readUserSettings({ env })
  assert.equal(settings.defaults?.connection, 'personal')
  assert.equal(settings.connections['personal']?.model, 'vendor/exact-model')
  assert.equal(settings.defaults?.budgetUsd, 5)
  assert.equal(settings.setup?.completed, true)
  assert.equal(JSON.stringify(settings).includes(env.OPENROUTER_API_KEY), false)
})
