import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import test from 'node:test'
import fs, { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('effective settings have no cloud selection and require explicit plan auto-apply', async () => {
  const { resolveEffectiveSettings } = await import('./userSettings.js')
  const result = resolveEffectiveSettings({ env: {}, settings: { schemaVersion: 1, connections: {} } })
  assert.equal(result.connection.value, null)
  assert.equal(result.model.value, null)
  assert.equal(result.workflow.value, 'work')
  assert.equal(result.autoApply.value, false)
  assert.equal(result.autoApply.source, 'built-in')
})

test('settings resolution distinguishes accounts and explicit selection precedence', async () => {
  const { resolveEffectiveSettings } = await import('./userSettings.js')
  const settings = {
    schemaVersion: 1 as const,
    connections: {
      personal: { id: 'personal', provider: 'openai' as const, model: 'same-model' },
      office: { id: 'office', provider: 'gemini' as const, model: 'same-model' },
    },
    defaults: { connection: 'personal' },
  }
  const result = resolveEffectiveSettings({ settings, env: {}, session: { connection: 'office' } })
  assert.equal(result.connection.value?.id, 'office')
  assert.equal(result.connection.value?.provider, 'gemini')
  assert.equal(result.connection.source, 'session')
  assert.equal(result.model.value, 'same-model')
  assert.equal(resolveEffectiveSettings({ settings, env: { BABEL_CONNECTION: 'personal' }, session: { connection: 'office' } }).connection.value?.id, 'office')
})

test('invalid settings update preserves the file and valid updates preserve unknown fields', async () => {
  const { updateUserSettings } = await import('./userSettings.js')
  const path = join(mkdtempSync(join(tmpdir(), 'babel-settings-')), 'settings.json')
  writeFileSync(path, JSON.stringify({ schemaVersion: 1, connections: {}, future: { enabled: true } }))
  const before = readFileSync(path, 'utf8')
  assert.throws(() => updateUserSettings({ defaults: { workflow: 'invalid' } } as never, { path }))
  assert.equal(readFileSync(path, 'utf8'), before)
  updateUserSettings({ defaults: { workflow: 'plan' } }, { path })
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).future.enabled, true)
})

test('switching connections never carries another provider model default into the new connection', async () => {
  const { resolveEffectiveSettings } = await import('./userSettings.js')
  const settings = { schemaVersion: 1 as const, connections: {
    a: { id: 'a', provider: 'openai' as const, model: 'model-a' },
    b: { id: 'b', provider: 'gemini' as const, model: 'model-b' },
    c: { id: 'c', provider: 'anthropic' as const },
  }, defaults: { connection: 'a', model: 'model-a' } }
  assert.equal(resolveEffectiveSettings({ settings, env: {}, session: { connection: 'b' } }).model.value, 'model-b')
  assert.equal(resolveEffectiveSettings({ settings, env: {}, session: { connection: 'c' } }).model.value, null)
})


test('literal credentials are rejected without changing existing preferences', async () => {
  const { updateUserSettings } = await import('./userSettings.js')
  const path = join(mkdtempSync(join(tmpdir(), 'babel-settings-')), 'settings.json')
  writeFileSync(path, JSON.stringify({ schemaVersion: 1, connections: {} }))
  const before = readFileSync(path, 'utf8')
  assert.throws(() => updateUserSettings({ connections: { x: { id: 'x', provider: 'openai', apiKey: 'fixture-not-a-real-key' } } } as never, { path }))
  assert.equal(readFileSync(path, 'utf8'), before)
})


test('asynchronous invocation selection outranks environment without leaking into the next command', async () => {
  const { withInvocationSettings } = await import('./invocationSettings.js')
  const { resolveEffectiveSettings } = await import('./userSettings.js')
  const settings = { schemaVersion: 1 as const, connections: { a: { id: 'a', provider: 'openai' as const, model: 'a-model' }, b: { id: 'b', provider: 'gemini' as const, model: 'b-model' } } }
  const env = { BABEL_CONNECTION: 'a' }
  await withInvocationSettings({ connection: 'b' }, async () => { await Promise.resolve(); const effective = resolveEffectiveSettings({ settings, env }); assert.equal(effective.connection.value?.id, 'b'); assert.equal(effective.connection.source, 'invocation') })
  assert.equal(resolveEffectiveSettings({ settings, env }).connection.value?.id, 'a')
})

test('arbitrary exact connection model does not claim unverified native tool capability', async () => {
  const { resolveConnectionModelPolicy } = await import('./connectionModelPolicy.js')
  const policy = resolveConnectionModelPolicy('connection/example/vendor/unknown', { settings: {
    schemaVersion: 1, connections: { example: { id: 'example', provider: 'openrouter', model: 'vendor/unknown' } },
  } })
  assert.equal(policy?.providerModelId, 'vendor/unknown')
  assert.equal(policy?.nativeToolUse, undefined)
})

test('settings compare and commit hold the same lock as an ordinary preference update', async t => {
  const { updateUserSettings, readUserSettings } = await import('./userSettings.js')
  const dir = mkdtempSync(join(tmpdir(), 'babel-settings-lock-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'settings.json')
  updateUserSettings({ defaults: { budgetUsd: 2 } }, { path })
  updateUserSettings(current => {
    assert.equal(current.defaults?.budgetUsd, 2)
    assert.throws(() => updateUserSettings({ defaults: { budgetUsd: 5 } }, { path }), /locked by another writer/)
    return { defaults: { workflow: 'plan' } }
  }, { path })
  assert.equal(readUserSettings({ path }).defaults?.budgetUsd, 2)
  assert.equal(readUserSettings({ path }).defaults?.workflow, 'plan')
  updateUserSettings({ defaults: { budgetUsd: 5 } }, { path })
  assert.equal(readUserSettings({ path }).defaults?.budgetUsd, 5)
})

test('a pre-existing temporary preferences path is not deleted', async () => {
  const { updateUserSettings } = await import('./userSettings.js')
  const dir = mkdtempSync(join(tmpdir(), 'babel-settings-temp-'))
  const original = crypto.randomUUID
  const id = '44444444-4444-4444-8444-444444444444'
  const path = join(dir, 'preferences.json')
  const occupied = `${path}.${id}.tmp`
  try {
    writeFileSync(occupied, 'fixture-owned-data', { flag: 'wx', mode: 0o600 })
    crypto.randomUUID = (() => id) as typeof crypto.randomUUID
    syncBuiltinESMExports()
    assert.throws(() => updateUserSettings({ defaults: { workflow: 'work' } }, { path }))
    assert.equal(existsSync(occupied), true)
    assert.equal(statSync(occupied).size, 'fixture-owned-data'.length)
  } finally {
    crypto.randomUUID = original
    syncBuiltinESMExports()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a failed preferences flush preserves the last committed settings', async () => {
  const { readUserSettings, updateUserSettings } = await import('./userSettings.js')
  const dir = mkdtempSync(join(tmpdir(), 'babel-settings-flush-'))
  const path = join(dir, 'preferences.json')
  const original = fs.fsyncSync
  let injected = false
  try {
    updateUserSettings({ defaults: { workflow: 'work' } }, { path })
    fs.fsyncSync = ((fd: number) => {
      if (readdirSync(dir).some(name => name.startsWith('preferences.json.') && name.endsWith('.tmp'))) {
        injected = true
        throw Object.assign(new Error('Injected flush failure'), { code: 'EIO' })
      }
      return original(fd)
    }) as typeof fs.fsyncSync
    syncBuiltinESMExports()
    assert.throws(() => updateUserSettings({ defaults: { workflow: 'plan' } }, { path }))
    fs.fsyncSync = original
    syncBuiltinESMExports()
    assert.equal(injected, true)
    assert.equal(readUserSettings({ path }).defaults?.workflow, 'work')
    assert.equal(readdirSync(dir).some(name => name.endsWith('.tmp')), false)
  } finally {
    fs.fsyncSync = original
    syncBuiltinESMExports()
    rmSync(dir, { recursive: true, force: true })
  }
})
