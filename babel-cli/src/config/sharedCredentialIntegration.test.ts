import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveProviderCredential } from '../runners/credentialHub.js'
import { resolveConnectionModelPolicy } from './connectionModelPolicy.js'
import { resolveEffectiveSettings } from './userSettings.js'

const reference = 'babel-os-v1:11111111-1111-4111-8111-111111111111'
const settings = { schemaVersion: 1 as const, connections: {
  selected: { id: 'selected', provider: 'openrouter' as const, model: 'example/model', credentialRef: reference },
}, defaults: { connection: 'selected' } }

test('the selected account reference survives settings and model policy resolution', () => {
  assert.equal(resolveEffectiveSettings({ settings, env: {} }).connection.value?.credentialRef, reference)
  assert.equal(resolveConnectionModelPolicy(undefined, { settings })?.credentialRef, reference)
})

test('a selected protected reference wins over ambient credentials and fails closed', () => {
  const options = { env: { OPENROUTER_API_KEY: 'synthetic-wrong-account' }, credentialRef: reference }
  assert.equal(resolveProviderCredential('openrouter', { ...options, readSharedCredential: ref => ref === reference ? 'synthetic-selected-account' : '' }), 'synthetic-selected-account')
  assert.throws(() => resolveProviderCredential('openrouter', { ...options, readSharedCredential: () => { throw new Error('locked') } }), /locked/)
  assert.equal(resolveProviderCredential('openrouter', { ...options, explicitCredential: 'synthetic-explicit-session', readSharedCredential: () => { throw new Error('must not access store') } }), 'synthetic-explicit-session')
})

test('headless execution does not attempt to unlock an OS credential store', () => {
  let calls = 0
  assert.throws(() => resolveProviderCredential('openrouter', { credentialRef: reference, env: { BABEL_HEADLESS: '1' }, readSharedCredential: () => { calls++; throw new Error('unexpected access') } }), /headless|noninteractive/i)
  assert.equal(calls, 0)
})
