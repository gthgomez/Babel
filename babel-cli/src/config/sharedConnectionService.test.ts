import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSharedConnectionService } from './sharedConnectionService.js'
import { createSharedCredentialStore, type CredentialBackend } from './sharedCredentialStore.js'
import { readUserSettings, updateUserSettings } from './userSettings.js'

function fixture() {
  const path = join(mkdtempSync(join(tmpdir(), 'babel-shared-service-')), 'preferences.json')
  const entries = new Map<string, string>(); let counter = 0
  const backend: CredentialBackend = { get: id => entries.get(id) ?? null, set: (id, key) => { entries.set(id, key) }, remove: id => entries.delete(id) }
  const store = createSharedCredentialStore(backend, () => `${String(++counter).padStart(8, '0')}-1111-4111-8111-111111111111`)
  return { path, entries, service: createSharedConnectionService({ path, store: () => store }) }
}

test('migration retains existing defaults and routes both interfaces through one reference', () => {
  const { path, service } = fixture()
  updateUserSettings({ connections: { existing: { id: 'existing', provider: 'command-code', model: 'old-model' } }, defaults: { connection: 'existing' } }, { path })
  const input = { id: 'desktop-openrouter-one', provider: 'openrouter' as const, model: 'vendor/model', key: 'synthetic-original' }
  const ref = service.register(input)
  assert.equal(service.register(input), ref)
  assert.equal(service.read(input.id, input.provider), input.key)
  assert.equal(readUserSettings({ path }).defaults?.connection, 'existing')
  assert.equal(readFileSync(path, 'utf8').includes(input.key), false)
  const newRef = service.replace(input.id, input.provider, 'synthetic-replacement')
  assert.notEqual(newRef, ref)
  assert.equal(service.read(input.id, input.provider), 'synthetic-replacement')
  assert.equal(service.remove(input.id, input.provider), true)
  assert.throws(() => service.read(input.id, input.provider), /missing/i)
  assert.equal(readUserSettings({ path }).connections[input.id]?.credentialRef, newRef)
})

test('migration refuses collisions, unavailable stores and unrelated providers', () => {
  const { path, service, entries } = fixture()
  updateUserSettings({ connections: { taken: { id: 'taken', provider: 'command-code' } } }, { path })
  assert.throws(() => service.register({ id: 'taken', provider: 'openrouter', key: 'synthetic-key' }), /already|different/i)
  assert.throws(() => service.read('taken', 'openrouter'), /connection/i)
  assert.equal(readUserSettings({ path }).connections.taken?.provider, 'command-code')
  assert.throws(() => service.register({ id: '../unsafe', provider: 'openrouter', key: 'synthetic-key' }), /invalid/i)
  assert.equal(entries.size, 0)
})

test('an uncertain cross-store save preserves existing settings and never deletes the new entry', () => {
  const { path, service, entries } = fixture()
  updateUserSettings({ defaults: { workflow: 'plan' } }, { path })
  const before = readFileSync(path, 'utf8')
  writeFileSync(`${path}.babel-lock`, 'other writer')
  assert.throws(() => service.register({ id: 'desktop-openrouter-test', provider: 'openrouter', key: 'synthetic-key' }), /locked|already/i)
  assert.equal(readFileSync(path, 'utf8'), before)
  assert.equal(entries.size, 1, 'the unconfirmed entry is retained for recovery')
})

test('a failed removal receipt leaves the shared reference authoritative and cannot revive an old key', () => {
  const { path, service } = fixture()
  const id = 'desktop-openrouter-test'
  const reference = service.register({ id, provider: 'openrouter', key: 'synthetic-key' })
  assert.throws(() => service.remove(id, 'openrouter', () => { throw new Error('synthetic Desktop write failure') }), /synthetic Desktop/)
  assert.equal(readUserSettings({ path }).connections[id]?.credentialRef, reference)
  assert.throws(() => service.read(id, 'openrouter'), /missing/i)
})
