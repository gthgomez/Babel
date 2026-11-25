import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('noninteractive setup prints the private file and a placeholder example', async () => {
  const { runProviderSetup } = await import('./providerSetup.js')
  const dir = mkdtempSync(join(tmpdir(), 'babel-setup-example-'))
  const env = { BABEL_CONFIG_DIR: dir, OPENROUTER_API_KEY: 'sentinel-do-not-print' }
  let output = ''
  const result = await runProviderSetup({ env, interactive: false, write: text => { output += text } })
  assert.equal(result.state, 'setup_required')
  assert.match(output, /babel-harness setup/)
  assert.match(output, /your-key-here/)
  assert.match(output, /DEEPINFRA_API_KEY=your-key-here/)
  assert.match(output, /Ollama/)
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

for (const legacy of [false, true]) {
  test(`declining setup preserves the ${legacy ? 'legacy' : 'explicit'} account selection and preferences`, async t => {
    const { getSetupStatus, runProviderSetup } = await import('./providerSetup.js')
    const { updateUserSettings, userSettingsPath } = await import('../config/userSettings.js')
    const directory = mkdtempSync(join(tmpdir(), 'babel-setup-decline-'))
    t.after(() => rmSync(directory, { recursive: true, force: true }))
    const env = { BABEL_STATE_DIR: directory, OPENROUTER_API_KEY: 'synthetic-key' }
    updateUserSettings({
      connections: { personal: { id: 'personal', provider: 'openrouter', model: 'vendor/original' } },
      defaults: { connection: 'personal', ...(!legacy ? { model: 'vendor/original' } : {}), budgetUsd: 2 },
      setup: { completed: true, step: 'complete', connection: 'personal' },
    }, { env })
    const path = userSettingsPath(env)
    const previous = readFileSync(path, 'utf8')
    const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected setup request') })
    const answers = ['openrouter', 'personal', 'vendor/replacement', '', '', '3', 'no']
    const result = await runProviderSetup({ env, interactive: true, question: async () => answers.shift()!, write: () => {} })

    assert.equal(answers.length, 0)
    assert.equal(result.connection, 'personal')
    assert.equal(result.model, 'vendor/original')
    assert.equal(getSetupStatus(env).model, 'vendor/original')
    assert.equal(readFileSync(path, 'utf8'), previous)
    assert.equal(fetch.mock.callCount(), 0)
  })
}

test('fresh setup can skip to the composer without creating a profile or sending a request', async t => {
  const { runProviderSetup } = await import('./providerSetup.js')
  const { userSettingsPath } = await import('../config/userSettings.js')
  const directory = mkdtempSync(join(tmpdir(), 'babel-setup-skip-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const env = { BABEL_STATE_DIR: directory }
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected setup request') })
  let output = ''
  const result = await runProviderSetup({ env, interactive: true, question: async () => '0', write: text => { output += text } })

  assert.equal(result.state, 'setup_required')
  assert.equal(result.connection, null)
  assert.equal(existsSync(userSettingsPath(env)), false)
  assert.equal(fetch.mock.callCount(), 0)
  assert.match(output, /0\. Skip setup/)
})

test('the bundled model chooser searches its selected provider and persists the named account and exact ID', async t => {
  const { getSetupStatus, runProviderSetup } = await import('./providerSetup.js')
  const { readUserSettings } = await import('../config/userSettings.js')
  const directory = mkdtempSync(join(tmpdir(), 'babel-setup-catalog-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const env = { BABEL_STATE_DIR: directory, OPENROUTER_API_KEY: 'synthetic-key' }
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected setup request') })
  const answers = ['1', 'personal', '/search deepseek-v4.1-flash-1017', '#1', '', '', '5', 'yes']
  let output = ''
  const result = await runProviderSetup({ env, interactive: true, question: async () => answers.shift()!, write: text => { output += text } })

  assert.equal(answers.length, 0)
  assert.match(output, /1\. OpenRouter\n2\. Command Code/)
  assert.match(output, /#1\. deepseek\/deepseek-v4\.1-flash-1017/)
  assert.equal(result.connection, 'personal')
  assert.equal(getSetupStatus(env).model, 'deepseek/deepseek-v4.1-flash-1017')
  assert.equal(readUserSettings({ env }).defaults?.budgetUsd, 5)
  assert.equal(fetch.mock.callCount(), 0)
})

for (const confirm of [true, false]) {
  test(`going back from review revises the draft before ${confirm ? 'saving' : 'declining'}`, async t => {
    const { runProviderSetup } = await import('./providerSetup.js')
    const { readUserSettings, updateUserSettings, userSettingsPath } = await import('../config/userSettings.js')
    const directory = mkdtempSync(join(tmpdir(), 'babel-setup-back-'))
    t.after(() => rmSync(directory, { recursive: true, force: true }))
    const env = { BABEL_STATE_DIR: directory, BABEL_CONFIG_DIR: directory, OPENROUTER_API_KEY: 'fixture-only' }
    updateUserSettings({
      connections: { personal: { id: 'personal', provider: 'openrouter', model: 'vendor/original' } },
      defaults: { connection: 'personal', model: 'vendor/original', budgetUsd: 2 },
    }, { env })
    const path = userSettingsPath(env)
    const previous = readFileSync(path, 'utf8')
    const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected setup request') })
    const answers = [
      [/^Provider/, 'openrouter'],
      [/^Connection name/, 'personal'],
      [/^Exact model ID/, 'vendor/first'],
      [/^Context capacity/, '128000'],
      [/^Output budget/, '8192'],
      [/^Per-task budget/, '5'],
      [/^Save this connection/, '/back'],
      [/^Exact model ID \[vendor\/first\]/, 'vendor/revised'],
      [/^Context capacity.*blank if unknown/, ''],
      [/^Output budget.*blank for transport default/, ''],
      [/^Per-task budget.*\[5\]/, ''],
      [/^Save this connection/, confirm ? 'yes' : 'no'],
    ] as const
    let step = 0
    const result = await runProviderSetup({ env, interactive: true, write: () => {}, question: async prompt => {
      const answer = answers[step++]
      assert.ok(answer, 'setup asked an unexpected question')
      assert.match(prompt, answer[0])
      assert.equal(readFileSync(path, 'utf8'), previous)
      return answer[1]
    } })
    assert.equal(step, answers.length, 'Back should revisit the model before confirmation')
    const settings = readUserSettings({ env })
    assert.equal(result.connection, 'personal')
    assert.equal(result.model, confirm ? 'vendor/revised' : 'vendor/original')
    assert.equal(settings.defaults?.budgetUsd, confirm ? 5 : 2)
    assert.equal(settings.connections.personal?.contextWindow, undefined)
    assert.equal(settings.connections.personal?.maxOutputTokens, undefined)
    if (!confirm) assert.equal(readFileSync(path, 'utf8'), previous)
    assert.equal(fetch.mock.callCount(), 0)
  })
}

test('invalid confirmed setup is rejected before requesting or saving a credential', async t => {
  const { runProviderSetup } = await import('./providerSetup.js')
  const { userSettingsPath } = await import('../config/userSettings.js')
  const directory = mkdtempSync(join(tmpdir(), 'babel-setup-invalid-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const env = { BABEL_CONFIG_DIR: directory, BABEL_STATE_DIR: directory }
  const answers = ['openrouter', 'personal', 'vendor/exact-model', 'bad-context', '', '5', 'yes']
  await assert.rejects(runProviderSetup({ env, interactive: true, write: () => {}, question: async prompt => {
    assert.doesNotMatch(prompt, /Save a key/, 'An invalid account reached the credential prompt')
    assert.ok(answers.length > 0)
    return answers.shift()!
  } }), /Invalid Babel preference update.*contextWindow/)
  assert.equal(answers.length, 0)
  assert.equal(existsSync(userSettingsPath(env)), false)
  assert.equal(existsSync(join(directory, '.env')), false)
})
