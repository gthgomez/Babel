import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readProviderModelCatalog, refreshProviderModelCatalog } from './providerModelCatalog.js'
import { updateUserSettings } from '../config/userSettings.js'
import { listConnectionModels } from './connectionSettings.js'
import { registerConnectionCommands } from '../commands/connectionCommands.js'
import { Command } from 'commander'

test('an explicit refresh stores public model IDs without sending credentials or claiming qualification', async () => {
  const env = { BABEL_STATE_DIR: mkdtempSync(join(tmpdir(), 'babel-catalog-')), OPENROUTER_API_KEY: 'synthetic-never-send' }
  let calls = 0
  const result = await refreshProviderModelCatalog('openrouter', { env, fetchImpl: async (url, init) => {
    calls++; assert.equal(url, 'https://openrouter.ai/api/v1/models'); assert.equal(init?.redirect, 'error')
    assert.equal(new Headers(init?.headers).has('authorization'), false)
    return new Response(JSON.stringify({ data: [{ id: 'vendor/model-a' }, { id: 'vendor/model-a' }, { id: 'bad\nmodel' }] }))
  } })
  assert.equal(calls, 1); assert.deepEqual(result.models, ['vendor/model-a'])
  assert.deepEqual(readProviderModelCatalog('openrouter', env)?.models, ['vendor/model-a'])
  assert.equal(readFileSync(join(env.BABEL_STATE_DIR, 'model-catalog.json'), 'utf8').includes('synthetic-never-send'), false)
  assert.equal(result.qualification, 'unverified')
})

test('offline and failed refreshes preserve the last successful cache', async () => {
  const env = { BABEL_STATE_DIR: mkdtempSync(join(tmpdir(), 'babel-catalog-failure-')) }
  await refreshProviderModelCatalog('command-code', { env, fetchImpl: async () => new Response(JSON.stringify({ data: [
    { id: 'vendor/chat', supported_endpoints: ['/chat/completions'] }, { id: 'vendor/unsupported', supported_endpoints: ['/other'] },
  ] })) })
  let calls = 0
  await assert.rejects(refreshProviderModelCatalog('command-code', { env: { ...env, BABEL_OFFLINE: '1' }, fetchImpl: async () => { calls++; throw Error('must not call') } }), /offline/i)
  assert.equal(calls, 0)
  await assert.rejects(refreshProviderModelCatalog('command-code', { env, fetchImpl: async () => new Response('', { status: 429 }) }), /429/)
  assert.deepEqual(readProviderModelCatalog('command-code', env)?.models, ['vendor/chat'])
})

test('model refresh is explicit and its cached models are selectable from the shared command grammar', async () => {
  const previousState = process.env.BABEL_STATE_DIR, previousOffline = process.env.BABEL_OFFLINE, previousFetch = globalThis.fetch
  const state = mkdtempSync(join(tmpdir(), 'babel-model-command-'))
  process.env.BABEL_STATE_DIR = state; delete process.env.BABEL_OFFLINE
  let calls = 0; let emitted: unknown
  try {
    updateUserSettings({ connections: { account: { id: 'account', provider: 'openrouter', model: 'known/model' } }, defaults: { connection: 'account' } })
    globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ data: [{ id: 'vendor/discovered-model' }] })) }
    assert.equal(listConnectionModels().models.some(model => model.id === 'vendor/discovered-model'), false)
    assert.equal(calls, 0)
    const program = new Command().exitOverride()
    registerConnectionCommands(program, { emit: value => { emitted = value } })
    await program.parseAsync(['node', 'babel', 'model', 'refresh'])
    assert.equal(calls, 1)
    assert.equal((emitted as { qualification: string }).qualification, 'unverified')
    assert.equal(listConnectionModels().models.some(model => model.id === 'vendor/discovered-model'), true)
  } finally {
    if (previousState === undefined) delete process.env.BABEL_STATE_DIR; else process.env.BABEL_STATE_DIR = previousState
    if (previousOffline === undefined) delete process.env.BABEL_OFFLINE; else process.env.BABEL_OFFLINE = previousOffline
    globalThis.fetch = previousFetch
  }
})
