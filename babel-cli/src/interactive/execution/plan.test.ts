import assert from 'node:assert/strict'
import test from 'node:test'
import { PassThrough } from 'node:stream'
import { createInterface } from 'node:readline'
import { AgentSession } from '../../agent/session.js'
import { executePlanTask } from './plan.js'

test('hosted Plan presents its own notice and failure through the shell', async () => {
  const previousRun = AgentSession.prototype.run
  const previousLog = console.log; const previousError = console.error
  const input = new PassThrough(); const rl = createInterface({ input, output: new PassThrough() })
  const notices: string[] = []; const raw: string[] = []
  const ctx = { state: { operatorMode: 'hard_plan', router: 'v9' }, rl, isRunning: false, lastRunDir: null,
    shellRuntime: { store: { epoch: 1 }, appendNotice(text: string) { notices.push(text) } },
    appendTurn() {}, saveSessionState() {}, settleShellTurn() {} }
  console.log = (...args: unknown[]) => { raw.push(args.map(String).join(' ')) }
  console.error = (...args: unknown[]) => { raw.push(args.map(String).join(' ')) }
  try {
    AgentSession.prototype.run = async () => ({ payload: { status: 'PLAN_READY', run_dir: null }, exitCode: 0, planText: 'Plan body' })
    await executePlanTask(ctx as never, 'Plan', 'Plan', { targetRoot: process.cwd(), workspaceRoot: null } as never)
    assert.match(notices.join('\n'), /Planning only/)
    assert.match(notices.join('\n'), /plan source is unavailable/i)
    assert.deepEqual(raw, [])
  } finally { AgentSession.prototype.run = previousRun; console.log = previousLog; console.error = previousError; rl.close(); input.destroy() }
})

test('interactive plan refuses a successful-looking result with no source identity', async () => {
  const previous = AgentSession.prototype.run
  const input = new PassThrough(); const rl = createInterface({ input, terminal: false })
  const ctx = { state: { operatorMode: 'hard_plan', router: 'v9' }, rl, isRunning: false, lastRunDir: null,
    appendTurn() {}, saveSessionState() {}, settleShellTurn(status: string) { this.settlement = status }, settlement: '' }
  try {
    AgentSession.prototype.run = async () => ({ payload: { status: 'PLAN_READY', run_dir: null }, exitCode: 0, planText: 'Plan body' })
    await executePlanTask(ctx as never, 'Plan', 'Plan', { targetRoot: process.cwd(), workspaceRoot: null } as never)
    assert.equal(ctx.settlement, 'failed')
    assert.equal('savedPlanId' in ctx.state, false)
  } finally { AgentSession.prototype.run = previous; rl.close(); input.destroy() }
})

test('automatic Apply reports the governed result instead of retaining Plan status', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { reportPlanApplication } = await import('./plan.js')
  const root = mkdtempSync(join(tmpdir(), 'babel-plan-projection-'))
  let appended: { run_dir?: string } | undefined; let outcome: string | undefined
  const ctx = { state: { mode: 'plan', router: 'v9' }, appendTurn(turn: { run_dir?: string }, status: string) { appended = turn; outcome = status }, lastAssistantStatus: 'PLAN_READY', lastAssistantAnswer: 'Old plan body' }
  const prior = console.log; console.log = () => {}
  try {
    reportPlanApplication(ctx as never, { runDir: root, status: 'EXECUTOR_HALTED', manifest: { target_project: 'fixture' }, plan: null, errors: ['Controlled halt'] } as never, 'Apply fixture', root)
    assert.equal(outcome, 'EXECUTOR_HALTED'); assert.equal(appended?.run_dir, root)
    assert.equal(ctx.lastAssistantStatus, 'EXECUTOR_HALTED'); assert.notEqual(ctx.lastAssistantAnswer, 'Old plan body')
  } finally { console.log = prior; rmSync(root, { recursive: true, force: true }) }
})
