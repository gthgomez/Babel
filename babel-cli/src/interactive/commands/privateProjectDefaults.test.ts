import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { updateUserSettings } from '../../config/userSettings.js'
import { resolveChatEngineLimits } from '../../config/chatEngineLimits.js'
import { handleRetarget } from './config.js'
import type { ReplContext } from '../context.js'

async function fixture(run: (project: string) => void) {
  const before = { state: process.env['BABEL_STATE_DIR'], cost: process.env['BABEL_CHAT_MAX_COST'] }
  const project = mkdtempSync(join(tmpdir(), 'babel-project-preferences-'))
  process.env['BABEL_STATE_DIR'] = mkdtempSync(join(tmpdir(), 'babel-profile-preferences-')); delete process.env['BABEL_CHAT_MAX_COST']
  try {
    updateUserSettings({ schemaVersion: 1, connections: { a: { id: 'a', provider: 'openai', model: 'a-model' }, b: { id: 'b', provider: 'gemini', model: 'b-model' } }, defaults: { connection: 'a', budgetUsd: 5 }, projects: { [project]: { connection: 'b', budgetUsd: 2, workflow: 'plan' } } })
    run(project)
  } finally {
    if (before.state === undefined) delete process.env['BABEL_STATE_DIR']; else process.env['BABEL_STATE_DIR'] = before.state
    if (before.cost === undefined) delete process.env['BABEL_CHAT_MAX_COST']; else process.env['BABEL_CHAT_MAX_COST'] = before.cost
  }
}

test('retarget refreshes private project defaults while keeping explicit session selection', async () => fixture(project => {
  const ctx = { state: { mode: 'chat', model: 'connection/a/a-model', modelSource: 'project', connectionId: 'a', savedPlanId: 'old-plan' }, targetOverrideRoot: null, chatEngine: undefined,
    resolveCurrentTarget: () => ({ targetRoot: ctx.targetOverrideRoot ?? process.cwd() }), saveSessionState: () => {} } as unknown as ReplContext
  handleRetarget(ctx, [project]); assert.equal(ctx.state.model, 'connection/b/b-model'); assert.equal(ctx.state.mode, 'plan'); assert.equal(ctx.state.savedPlanId, undefined)
  ctx.state.model = 'connection/a/explicit-model'; ctx.state.modelSource = 'session'; ctx.state.connectionId = 'a'
  ctx.state.mode = 'chat'
  handleRetarget(ctx, [project]); assert.equal(ctx.state.model, 'connection/a/explicit-model')
  assert.equal(ctx.state.mode, 'plan')
}))

test('task allowance resolves the target project budget instead of the launcher cwd', async () => fixture(project => {
  const limits = resolveChatEngineLimits({}, undefined, { projectRoot: project })
  assert.equal(limits.maxCostUsd, 2)
}))
