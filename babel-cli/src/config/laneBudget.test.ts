import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { assertFiniteBudgetSupported } from './laneBudget.js'
import { updateUserSettings } from './userSettings.js'

function isolatedEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const scoped: NodeJS.ProcessEnv = { ...process.env, BABEL_STATE_DIR: mkdtempSync(join(tmpdir(), 'babel-lane-budget-')), ...overrides }
  for (const name of ['BABEL_CHAT_MAX_COST', 'BABEL_OFFLINE', 'BABEL_DESKTOP_PROVIDER']) {
    if (!(name in overrides)) delete scoped[name]
  }
  return scoped
}

test('a finite hard ceiling is rejected on an unenforced remote lane before inference', () => {
  const env = isolatedEnv({ BABEL_CHAT_MAX_COST: '5' })
  delete env['BABEL_OFFLINE']
  assert.throws(
    () => assertFiniteBudgetSupported('Plan', env['BABEL_PROJECT_ROOT'] ?? process.cwd(), env),
    /BUDGET_UNSUPPORTED: Plan cannot preauthorize the saved \$5 hard ceiling.*Request rejected before dispatch/,
  )
})

test('offline or local-only execution cannot spend remote money and is not rejected', () => {
  const offline = isolatedEnv({ BABEL_CHAT_MAX_COST: '5', BABEL_OFFLINE: '1' })
  assert.doesNotThrow(() => assertFiniteBudgetSupported('Plan', process.cwd(), offline))

  const env = isolatedEnv()
  delete env['BABEL_OFFLINE']
  updateUserSettings({
    connections: { local: { id: 'local', provider: 'ollama', model: 'llama3:8b', baseUrl: 'http://127.0.0.1:11434/v1' } },
    defaults: { connection: 'local', model: 'llama3:8b', budgetUsd: 5 },
  }, { env })
  assert.doesNotThrow(() => assertFiniteBudgetSupported('Plan', process.cwd(), env))
})

test('a finite saved ceiling remains rejected on a saved remote connection', () => {
  const env = isolatedEnv()
  delete env['BABEL_OFFLINE']
  updateUserSettings({
    connections: { remote: { id: 'remote', provider: 'deepseek', model: 'deepseek-v4-flash' } },
    defaults: { connection: 'remote', model: 'deepseek-v4-flash', budgetUsd: 5 },
  }, { env })
  assert.throws(
    () => assertFiniteBudgetSupported('Apply', process.cwd(), env),
    /BUDGET_UNSUPPORTED: Apply cannot preauthorize the saved \$5 hard ceiling/,
  )
})

test('an invalid budget is rejected without pretending enforcement', () => {
  const env = isolatedEnv({ BABEL_CHAT_MAX_COST: '0' })
  assert.throws(() => assertFiniteBudgetSupported('Plan', process.cwd(), env), /Invalid task budget/)
})
