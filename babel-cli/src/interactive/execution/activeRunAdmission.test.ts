import assert from 'node:assert/strict'
import test from 'node:test'
import type { ReplContext } from '../context.js'
import { handleCommand } from '../commands.js'
import { executeTask } from './dispatch.js'
import { executePlanTask } from './plan.js'
import { executeGovernedTask } from './governed.js'
import { executeChatTask } from './chat.js'
import type { AgentTargetContext } from '../../services/targetResolver.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readUserSettings, updateUserSettings } from '../../config/userSettings.js'

test('interactive Apply cannot replace an unsettled owner', async () => {
  const cancel = () => {}
  const ctx = { isRunning: true, cancelActiveRun: cancel, state: {}, resolveCurrentTarget: () => ({ targetRoot: process.cwd() }) } as unknown as ReplContext
  await assert.rejects(handleCommand(ctx, '/apply plan_00000000-0000-0000-0000-000000000000'), /active.*settle/i)
  assert.equal(ctx.isRunning, true); assert.equal(ctx.cancelActiveRun, cancel)
})

test('provider and model selection cannot replace an active run', async () => {
  const cancel = () => {}; let closed = 0
  const previous = process.env['BABEL_STATE_DIR']; const state = mkdtempSync(join(tmpdir(), 'babel-active-selection-')); process.env['BABEL_STATE_DIR'] = state
  updateUserSettings({ connections: { existing: { id: 'existing', provider: 'openrouter', model: 'vendor/model' }, other: { id: 'other', provider: 'command-code', model: 'vendor/other' } }, defaults: { connection: 'existing' } })
  const ctx = { isRunning: true, cancelActiveRun: cancel, state: { model: 'connection/existing/vendor/model', connectionId: 'existing' },
    chatEngine: { closeAdmissionStore() { closed++ }, getProviderSelectionStatus() { return null }, getEngineRunId() { return 'active' } }, resolveCurrentTarget: () => ({ targetRoot: process.cwd() }), saveSessionState() {} } as unknown as ReplContext
  try {
    for (const command of ['/provider use other', '/model use vendor/other', '/model clear', '/settings set plans.autoApply true', '/mode plan', '/project other', '/retarget other', '/permissions safe_repo', '/setup', '/fork cell-1', '/rewind cell-1']) {
      await assert.rejects(handleCommand(ctx, command), /active.*settle/i)
      assert.equal(ctx.state.model, 'connection/existing/vendor/model'); assert.equal(ctx.cancelActiveRun, cancel); assert.equal(closed, 0)
    }
    await handleCommand(ctx, '/provider status'); await handleCommand(ctx, '/model show'); await handleCommand(ctx, '/fork'); await handleCommand(ctx, '/rewind')
    assert.equal(closed, 0); assert.equal(ctx.cancelActiveRun, cancel)
    assert.equal(readUserSettings().defaults?.plans?.autoApply, undefined)
  } finally { if (previous === undefined) delete process.env['BABEL_STATE_DIR']; else process.env['BABEL_STATE_DIR'] = previous; rmSync(state, { recursive: true, force: true }) }
})

test('Chat, Plan, Deep and task dispatch reject while an owner is active', async () => {
  const cancel = () => {}
  const ctx = { isRunning: true, cancelActiveRun: cancel, state: {} } as unknown as ReplContext
  const target = { targetRoot: process.cwd(), workspaceRoot: process.cwd() } as AgentTargetContext
  for (const start of [() => executeTask(ctx, 'task'), () => executePlanTask(ctx, 'task', 'task', target),
    () => executeGovernedTask(ctx, 'task', 'task', target), () => executeChatTask(ctx, 'task', 'task', target)]) {
    await assert.rejects(start(), /active.*settle/i)
    assert.equal(ctx.isRunning, true); assert.equal(ctx.cancelActiveRun, cancel)
  }
})

test('REPL rejection cannot clear another active owner', async () => {
  const { BabelRepl } = await import('../BabelRepl.js')
  const ctx = Object.create(BabelRepl.prototype) as ReplContext
  const cancel = () => {}
  ctx.isRunning = true; ctx.cancelActiveRun = cancel; ctx.state = {} as ReplContext['state']
  await (ctx as unknown as { executeTask(input: string): Promise<void> }).executeTask('second task')
  assert.equal(ctx.isRunning, true); assert.equal(ctx.cancelActiveRun, cancel)
})

test('legacy REPL dispatch rejection cannot clear another active owner', async () => {
  const { executeReplTask } = await import('../repl/replCommandDispatch.js')
  const cancel = () => {}
  const ctx = { isRunning: true, cancelActiveRun: cancel, state: {} } as unknown as ReplContext
  await executeReplTask(ctx, 'second task')
  assert.equal(ctx.isRunning, true); assert.equal(ctx.cancelActiveRun, cancel)
})

test('cancelling uncancellable session preparation does not abort the previous engine', async () => {
  const { handleCancelTurn } = await import('../commands/review.js')
  let aborted = 0
  const ctx = { isRunning: false, preparingRun: true, chatEngine: { abortTurn() { aborted++ } } } as unknown as ReplContext
  handleCancelTurn(ctx)
  assert.equal(aborted, 0)
  assert.equal(ctx.preparingRun, true)
})

test('legacy display-text Plan execution is rejected without changing authority or erasing the text', async () => {
  let closed = 0
  const ctx = { isRunning: false, state: { operatorMode: 'hard_plan', pendingPlanBody: 'retained legacy plan' },
    lastAssistantAnswer: 'unapproved display answer', chatEngine: { closeAdmissionStore() { closed++ } }, saveSessionState() {} } as unknown as ReplContext
  await assert.rejects(handleCommand(ctx, '/execute-plan'), /legacy.*plan.*unsafe|unsupported.*plan/i)
  assert.equal(ctx.state.operatorMode, 'hard_plan'); assert.equal(ctx.state.pendingPlanBody, 'retained legacy plan'); assert.equal(closed, 0)
})
