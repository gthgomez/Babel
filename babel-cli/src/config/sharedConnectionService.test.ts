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
  return { path, entries, backend, service: createSharedConnectionService({ path, store: () => store }) }
}

test('migration retains existing defaults and routes both interfaces through one reference', () => {
  const { path, service, entries } = fixture()
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
  assert.equal(entries.size, 0, 'removing the connection also removes its replaced protected credential')
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

test('removing a connection clears all credentials retained across multiple replacements', () => {
  const { service, entries } = fixture()
  const id = 'desktop-openrouter-test'
  service.register({ id, provider: 'openrouter', key: 'fixture-first' })
  service.replace(id, 'openrouter', 'fixture-second')
  service.replace(id, 'openrouter', 'fixture-third')
  assert.equal(service.remove(id, 'openrouter'), true)
  assert.equal(entries.size, 0)
  assert.throws(() => service.read(id, 'openrouter'), /missing/i)
})

test('partial protected-store removal fails closed and can be retried', () => {
  const { path, service, entries, backend } = fixture()
  const id = 'desktop-openrouter-test'
  const oldRef = service.register({ id, provider: 'openrouter', key: 'fixture-first' })
  const currentRef = service.replace(id, 'openrouter', 'fixture-second')
  const remove = backend.remove
  backend.remove = entry => {
    if (entry === oldRef.slice('babel-os-v1:'.length)) throw new Error('synthetic store failure')
    return remove(entry)
  }
  assert.throws(() => service.remove(id, 'openrouter'), /unavailable/i)
  assert.equal(readUserSettings({ path }).connections[id]?.credentialRef, currentRef)
  assert.throws(() => service.read(id, 'openrouter'), /missing/i)
  assert.equal(entries.size, 1)
  backend.remove = remove
  assert.equal(service.remove(id, 'openrouter'), true)
  assert.equal(entries.size, 0)
})

test('removal does not delete a protected reference used by another connection', () => {
  const { path, service, entries } = fixture()
  const first = service.register({ id: 'first', provider: 'openrouter', key: 'fixture-first' })
  service.register({ id: 'second', provider: 'command-code', key: 'fixture-second' })
  updateUserSettings(current => ({ connections: { second: { ...current.connections.second!, retiredCredentialRefs: [first] } } }), { path })
  assert.throws(() => service.remove('first', 'openrouter'), /another connection/i)
  assert.equal(entries.size, 2)
  assert.equal(service.read('first', 'openrouter'), 'fixture-first')
})
