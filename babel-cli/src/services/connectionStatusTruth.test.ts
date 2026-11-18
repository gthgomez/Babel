import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { connectionStatus } from './connectionSettings.js'
import { updateUserSettings } from '../config/userSettings.js'

function env(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...process.env, BABEL_STATE_DIR: mkdtempSync(join(tmpdir(), 'babel-status-')), ...overrides }
}

test('status separates configured from verified and names credential presence only', () => {
  const scoped = env()
  updateUserSettings({
    connections: { saved: { id: 'saved', provider: 'openrouter', model: 'deepseek/deepseek-v4-flash' } },
    defaults: { connection: 'saved', model: 'deepseek/deepseek-v4-flash', budgetUsd: 2 },
  }, { env: scoped })
  const status = connectionStatus({}, process.cwd(), scoped)
  assert.equal(status.requestedModel, 'deepseek/deepseek-v4-flash')
  assert.equal(status.resolvedProvider, 'openrouter')
  assert.equal(status.resolvedModel, 'deepseek/deepseek-v4-flash')
  assert.equal(status.alias, null)
  assert.equal(status.credential.present, false)
  assert.equal(status.state, 'action_required')
  assert.equal(status.reason, 'credential_missing')
  assert.equal(status.connectivity, 'unverified')
  assert.equal(status.observedModel, null)
  assert.equal(status.capabilities.native_tools_qualified, true)
  assert.equal(status.budget.enforcement, 'standard-work-task-allowance')
})

test('a saved HTTPS connection is unusable under offline mode instead of silently dispatching', () => {
  const scoped = env({ BABEL_OFFLINE: '1', OPENROUTER_API_KEY: 'synthetic-inert-value' })
  updateUserSettings({
    connections: { saved: { id: 'saved', provider: 'openrouter', model: 'deepseek/deepseek-v4-flash' } },
    defaults: { connection: 'saved', model: 'deepseek/deepseek-v4-flash' },
  }, { env: scoped })
  const status = connectionStatus({}, process.cwd(), scoped)
  assert.equal(status.state, 'action_required')
  assert.equal(status.reason, 'offline_blocked')
  assert.equal(status.offline.active, true)
  assert.equal(status.offline.usable, false)
  assert.match(status.nextCommand, /Run online or select a local Ollama/)
})

test('a loopback Ollama connection is reported usable offline with local capability truth', () => {
  const scoped = env({ BABEL_OFFLINE: '1' })
  updateUserSettings({
    connections: { local: { id: 'local', provider: 'ollama', model: 'llama3:8b', baseUrl: 'http://127.0.0.1:11434/v1' } },
    defaults: { connection: 'local', model: 'llama3:8b' },
  }, { env: scoped })
  const status = connectionStatus({}, process.cwd(), scoped)
  assert.equal(status.state, 'configured_unverified')
  assert.equal(status.reason, 'ready_unverified')
  assert.equal(status.offline.usable, true)
  assert.equal(status.credential.required, false)
  assert.equal(status.capabilities.native_tools_qualified, true)
})
