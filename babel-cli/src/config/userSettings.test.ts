import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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
