import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readUserSettings, updateUserSettings } from '../config/userSettings.js'
import { resolveProviderCredential } from '../runners/credentialHub.js'
import { runProviderSetup } from './providerSetup.js'

const firstKey = 'synthetic-router-account-first'
const secondKey = 'synthetic-router-account-second'

function profile(t: TestContext): NodeJS.ProcessEnv {
  const root = mkdtempSync(join(tmpdir(), 'babel-setup-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return { BABEL_CONFIG_DIR: join(root, 'config'), BABEL_STATE_DIR: join(root, 'state') }
}

type Step = [prompt: string, answer: string | null, masked?: true]
async function guide(env: NodeJS.ProcessEnv, steps: Step[]) {
  let output = ''
  let prompts = 0
  let unexpected = false
  const result = await runProviderSetup({
    env, interactive: true, write: text => { output += text },
    question: async (prompt, masked) => {
      const step = steps[prompts++]
      if (!step || !prompt.startsWith(step[0]) || Boolean(masked) !== Boolean(step[2])) {
        unexpected = true
        throw new Error('Unexpected setup prompt.')
      }
      return step[1]
    },
  })
  assert.equal(output.includes(firstKey) || output.includes(secondKey), false, 'Setup output must not disclose a fixture key.')
  assert.equal(unexpected, false, 'Expected the documented setup steps in order.')
  assert.equal(prompts, steps.length)
  return { result, output }
}

test('noninteractive setup prints placeholders, never contacts a provider or selects an ambient key', async t => {
  const env: NodeJS.ProcessEnv = { ...profile(t), OPENROUTER_API_KEY: firstKey }
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected dispatch.') })
  let output = ''
  const result = await runProviderSetup({ env, interactive: false, write: text => { output += text } })
  assert.equal(result.state, 'setup_required')
  assert.equal(result.connection, null)
  assert.match(output, /babel-harness setup/)
  assert.match(output, /DEEPINFRA_API_KEY=your-key-here/)
  assert.match(output, /Ollama/)
  assert.ok(output.includes(join(env.BABEL_CONFIG_DIR!, '.env')))
  assert.equal(output.includes(firstKey), false)
  assert.equal(fetch.mock.callCount(), 0)
})

test('blank and unsupported provider choices stay in the picker; Escape leaves no partial account', async t => {
  const env = profile(t)
  const { result, output } = await guide(env, [
    ['Provider', ''], ['Provider', 'groq'], ['Provider', '1'], ['Connection name', ''],
    ['Key number', ''], ['Paste API key', '', true], ['Paste API key', null, true], ['Key number', null], ['Provider', null],
  ])
  assert.equal(result.state, 'setup_required')
  assert.match(output, /1\. OpenRouter\s+2\. Command Code/)
  assert.match(output, /Skip for now/)
  assert.match(output, /Choose one of the displayed numbers/)
  assert.match(output, /Nothing was saved/)
  assert.deepEqual(readUserSettings({ env }).connections, {})
  assert.equal(existsSync(join(env['BABEL_CONFIG_DIR']!, '.env.accounts')), false)
})

test('authenticated catalog is explicitly requested after key entry; search picks a listed model without changing the existing cap', async t => {
  const env = profile(t)
  updateUserSettings({ defaults: { budgetUsd: 3 } }, { env })
  let usedAccountKey = false
  const fetch = t.mock.method(globalThis, 'fetch', async (url: URL, init: RequestInit) => {
    assert.equal(String(url), 'https://openrouter.ai/api/v1/models/user')
    assert.equal(init.method, 'GET')
    assert.equal(init.redirect, 'error')
    assert.equal(init.body, undefined)
    usedAccountKey = new Headers(init.headers).get('Authorization') === `Bearer ${firstKey}`
    return Response.json({ data: [
      { id: 'vendor/code', supported_parameters: ['tools'] },
      { id: 'vendor/non-tool-model', supported_parameters: [] },
      { id: 'openrouter/auto', supported_parameters: ['tools'] },
      { id: 'deepseek/deepseek-v4.1-flash-1017', supported_parameters: ['tools'] },
      { id: firstKey, supported_parameters: ['tools'] },
    ] })
  })
  const { result, output } = await guide(env, [
    ['Provider', '1'], ['Connection name', 'personal'], ['Key number', '1'],
    ['Paste API key', firstKey, true], ['Connection number', '2'],
    ['Model number', 'not-found'], ['Model number', ''], ['Model number', 'flash'], ['Model number', ''],
  ])
  assert.equal(result.state, 'configured_unverified')
  assert.equal(result.model, 'deepseek/deepseek-v4.1-flash-1017')
  assert.equal(fetch.mock.callCount(), 1)
  assert.equal(usedAccountKey, true)
  assert.match(output, /Key saved\. Authentication unverified/)
  assert.match(output, /Authenticated via account metadata\. Model not yet tested/)
  assert.match(output, /1\. deepseek\/deepseek-v4\.1-flash-1017/)
  assert.match(output, /No matching models/)
  assert.doesNotMatch(output, /vendor\/non-tool-model|openrouter\/auto|[Cc]ontext capacity|[Oo]utput budget/)
  const settings = readUserSettings({ env })
  assert.equal(settings.defaults?.budgetUsd, 3)
  assert.equal(settings.defaults?.connection, 'personal')
  assert.equal(JSON.stringify(settings).includes(firstKey), false)
  const ref = settings.connections['personal']!.apiKeyEnvVar!
  assert.equal(env[ref], undefined, 'Profile account keys must not enter the environment.')
  assert.equal(resolveProviderCredential('openrouter', { env, envVarOverride: ref }) === firstKey, true)
  assert.throws(() => resolveProviderCredential('command-code', { env, envVarOverride: ref }), { code: 'PROVIDER_CREDENTIAL_MISSING' })
})

test('resume a saved key after Escape and add another independently named key without network', async t => {
  const env = profile(t)
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected dispatch.') })
  const pending = await guide(env, [
    ['Provider', '1'], ['Connection name', ''], ['Key number', ''], ['Paste API key', firstKey, true],
    ['Connection number', ''], ['Model number', null], ['Connection number', null], ['Provider', null],
  ])
  assert.equal(pending.result.state, 'setup_required')
  assert.equal(readUserSettings({ env }).defaults?.connection, undefined)
  await guide(env, [
    ['Provider', '1'], ['Account number', '1'], ['Key number', ''], ['Connection number', ''],
    ['Model number', '1'], ['Spending number', ''], ['Spending number', '1'], ['Per-task cap', '4.50'],
  ])
  const { result, output } = await guide(env, [
    ['Provider', '1'], ['Account number', '2'], ['Connection name [openrouter-2]', ''], ['Key number', ''],
    ['Paste API key', secondKey, true], ['Connection number', ''], ['Model number', 'a'],
    ['Advanced', ''], ['Advanced', 'vendor/exact-model'],
  ])
  assert.equal(result.connection, 'openrouter-2')
  assert.match(output, /openrouter \(key available\)/)
  assert.match(output, /Add another key/)
  assert.match(output, /unverified/)
  const settings = readUserSettings({ env })
  assert.equal(settings.defaults?.budgetUsd, 4.5)
  const first = settings.connections['openrouter']!.apiKeyEnvVar!
  const second = settings.connections['openrouter-2']!.apiKeyEnvVar!
  assert.notEqual(first, second)
  assert.equal(resolveProviderCredential('openrouter', { env, envVarOverride: first }) === firstKey, true)
  assert.equal(resolveProviderCredential('openrouter', { env, envVarOverride: second }) === secondKey, true)
  assert.equal(fetch.mock.callCount(), 0)
})

test('Command Code catalog is public; transport filtering and status make no authentication claim', async t => {
  const env = { ...profile(t), COMMAND_CODE_API_KEY: secondKey }
  let omittedAuthorization = false
  const fetch = t.mock.method(globalThis, 'fetch', async (url: URL, init: RequestInit) => {
    assert.equal(String(url), 'https://api.commandcode.ai/provider/v1/models')
    assert.equal(init.method, 'GET')
    omittedAuthorization = !new Headers(init.headers).has('Authorization')
    return Response.json({ data: [
      { id: 'vendor/messages-only', supported_endpoints: ['/messages'] },
      { id: 'deepseek/deepseek-v4.1-flash', supported_endpoints: ['/chat/completions'] },
    ] })
  })
  const { result, output } = await guide(env, [
    ['Provider', '2'], ['Connection name', ''], ['Key number', ''], ['Connection number', '2'], ['Model number', '1'], ['Spending number', '2'],
  ])
  assert.equal(result.model, 'deepseek/deepseek-v4.1-flash')
  assert.equal(fetch.mock.callCount(), 1)
  assert.equal(omittedAuthorization, true)
  assert.match(output, /Public catalog loaded\. Authentication unverified/)
  assert.doesNotMatch(output, /messages-only|Authenticated via/)
})

test('metadata rejection and offline mode do not activate any provider or print response bodies', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(secondKey, { status: 401 }))
  const env = { ...profile(t), OPENROUTER_API_KEY: firstKey }
  const rejected = await guide(env, [
    ['Provider', '1'], ['Connection name', ''], ['Key number', ''], ['Connection number', '2'], ['Provider', null],
  ])
  assert.equal(rejected.result.connection, null)
  assert.match(rejected.output, /denied access to account metadata/)
  const offline = await guide({ ...env, BABEL_OFFLINE: '1' }, [
    ['Provider', '1'], ['Account number', '1'], ['Key number', ''], ['Connection number', '2'],
    ['Model number', null], ['Connection number', null], ['Provider', null],
  ])
  assert.equal(offline.result.connection, null)
  assert.match(offline.output, /Offline mode; no request was sent/)
  assert.equal(fetch.mock.callCount(), 1)
})
