import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { updateUserSettings, resolveEffectiveSettings } from '../config/userSettings.js'
import { selectConnection } from '../services/connectionSettings.js'
import { withInvocationSettings } from '../config/invocationSettings.js'

async function fixture(run: () => Promise<void>) {
  const before = { state: process.env['BABEL_STATE_DIR'], offline: process.env['BABEL_OFFLINE'] }
  process.env['BABEL_STATE_DIR'] = mkdtempSync(join(tmpdir(), 'babel-experience-contract-')); process.env['BABEL_OFFLINE'] = '1'
  try {
    updateUserSettings({ schemaVersion: 1, connections: { a: { id: 'a', provider: 'openai', model: 'a-model' }, b: { id: 'b', provider: 'gemini' } }, defaults: { connection: 'a', model: 'a-model' } })
    await run()
  } finally {
    if (before.state === undefined) delete process.env['BABEL_STATE_DIR']; else process.env['BABEL_STATE_DIR'] = before.state
    if (before.offline === undefined) delete process.env['BABEL_OFFLINE']; else process.env['BABEL_OFFLINE'] = before.offline
  }
}

async function capture(args: string[]) {
  const { createCliProgram } = await import('../cliMain.js')
  const { rewriteArgv } = await import('../cli/argv.js')
  const program = createCliProgram().exitOverride()
  let captured: Record<string, unknown> | undefined
  program.commands.find(command => command.name() === 'run')!.action((_task, options) => { captured = options })
  await withInvocationSettings({}, () => program.parseAsync(rewriteArgv(['node', 'babel-agent', ...args], new Set(program.commands.map(command => command.name())))))
  assert.ok(captured); return captured
}

test('bare tasks honor saved workflow and explicit review depth overrides its preference', async () => fixture(async () => {
  updateUserSettings({ defaults: { workflow: 'plan' } })
  assert.equal((await capture(['Implement this change'])).mode, 'plan')
  assert.equal((await capture(['Implement this change', '--headless'])).mode, 'plan')
  updateUserSettings({ defaults: { workflow: 'work', review: 'thorough' } })
  assert.equal((await capture(['Implement this change'])).mode, 'deep')
  assert.equal((await capture(['work', '--review', 'standard', 'Implement this change'])).mode, 'chat')
  assert.equal((await capture(['work', 'Implement this change'])).mode, 'deep')
}))

test('global connection selection precedes canonical command aliases', async () => fixture(async () => {
  assert.equal((await capture(['--connection', 'a', 'work', 'Explain this project'])).model, 'connection/a/a-model')
}))

test('nested offline run commands do not enter model-backed execution setup', async () => fixture(async () => {
  process.env['BABEL_STATE_DIR'] = mkdtempSync(join(tmpdir(), 'babel-offline-command-'))
  delete process.env['BABEL_OFFLINE']
  const { createCliProgram } = await import('../cliMain.js')
  const program = createCliProgram().exitOverride()
  let executed = false
  program.commands.find(command => command.name() === 'agents')!.commands.find(command => command.name() === 'run')!.action(() => { executed = true })
  await withInvocationSettings({}, () => program.parseAsync(['node', 'babel-agent', 'agents', 'run', 'fixture.json', '--json']))
  assert.equal(executed, true)
}))

test('job inference requires explicit selection and honors its target, invocation and budget', async () => fixture(async () => {
  const { resolveAgentJobModel } = await import('../services/agentJobs.js')
  const projectRoot = mkdtempSync(join(tmpdir(), 'babel-job-selection-'))
  const job = { project_root: projectRoot, model: null }
  process.env['BABEL_STATE_DIR'] = mkdtempSync(join(tmpdir(), 'babel-job-profile-'))
  delete process.env['BABEL_OFFLINE']
  assert.throws(() => resolveAgentJobModel(job), /SETUP_REQUIRED/)
  assert.equal(resolveAgentJobModel({ ...job, model: 'explicit-legacy-route' }), 'explicit-legacy-route')
  updateUserSettings({ connections: { a: { id: 'a', provider: 'openai', model: 'a-model' }, b: { id: 'b', provider: 'gemini', model: 'b-model' } }, defaults: { connection: 'a', budgetUsd: 'unlimited' }, projects: { [projectRoot]: { connection: 'b' } } })
  assert.equal(resolveAgentJobModel(job), 'connection/b/b-model')
  withInvocationSettings({ connection: 'a' }, () => assert.equal(resolveAgentJobModel({ ...job, model: 'explicit-legacy-route' }), 'connection/a/a-model'))
  updateUserSettings({ projects: { [projectRoot]: { budgetUsd: 2 } } })
  assert.throws(() => resolveAgentJobModel(job), /BUDGET_UNSUPPORTED/)
}))

test('named target private preferences are resolved before pinning a connection', async () => fixture(async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-named-target-'))
  updateUserSettings({ connections: { b: { id: 'b', provider: 'gemini', model: 'b-model' } }, projects: { [root]: { connection: 'b' } } })
  assert.equal((await capture(['work', '--project', root, 'Explain this project'])).model, 'connection/b/b-model')
}))

test('saving a connection with no model clears the previous account model', async () => fixture(async () => {
  selectConnection('b', {}, { save: 'user' })
  const effective = resolveEffectiveSettings()
  assert.equal(effective.connection.value?.id, 'b'); assert.equal(effective.model.value, null)
}))

test('finite budgets stop unmetered lanes before inference', async () => fixture(async () => {
  const { assertFiniteBudgetSupported } = await import('../config/laneBudget.js')
  const { runPlanLane } = await import('../agent/lanes/planLane.js')
  updateUserSettings({ defaults: { budgetUsd: 2 } })
  assert.throws(() => assertFiniteBudgetSupported('Plan'), /BUDGET_UNSUPPORTED/)
  await assert.rejects(capture(['work', '--review', 'thorough', 'Implement this change']), /BUDGET_UNSUPPORTED/)
  await assert.rejects(runPlanLane({ provider: 'live', projectRoot: tmpdir() } as never), /BUDGET_UNSUPPORTED/)
  const { runReadOnlyAgentLoop } = await import('../agent/lanes/readOnlyAgentLoop.js')
  const { runMutationAgentLoop } = await import('../agent/lanes/runMutationAgentLoop.js')
  const projectRoot = mkdtempSync(join(tmpdir(), 'babel-budget-discovery-'))
  const toolContext = { agentId: 'fixture', runId: 'fixture', babelRoot: projectRoot }
  const actionResolver = async () => [{ type: 'finish' as const, summary: 'Fixture completion', verification: [] }]
  await assert.rejects(runReadOnlyAgentLoop({ verb: 'fix', task: 'Inspect', projectRoot, toolContext, actionResolver }), /BUDGET_UNSUPPORTED/)
  await assert.rejects(runMutationAgentLoop({ agentId: 'fixture', task: 'Inspect', projectRoot, writeScope: [], toolContext, actionResolver }), /BUDGET_UNSUPPORTED/)
  await runReadOnlyAgentLoop({ verb: 'fix', task: 'Inspect', projectRoot, toolContext, actionResolver,
    inheritedAllowance: { taskOwnerId: 'fixture-child', parentTaskOwnerId: 'fixture-parent', remainingCostUsd: 2, costBaselineUsd: 0, maxRounds: 1, deadlineAtMs: null } })
  assert.equal((await capture(['work', '--review', 'standard', 'Explain this project'])).mode, 'chat')
  updateUserSettings({ defaults: { budgetUsd: 'unlimited' } })
  assert.doesNotThrow(() => assertFiniteBudgetSupported('Plan'))
}))

test('interactive review preference works independently and setup follows the retargeted project', async () => fixture(async () => {
  const { bootstrapReplSession } = await import('../interactive/repl/replLifecycle.js')
  const { handleCommand } = await import('../interactive/commands.js')
  const { handleMode } = await import('../interactive/commands/config.js')
  const root = mkdtempSync(join(tmpdir(), 'babel-session-target-'))
  updateUserSettings({ defaults: { review: 'thorough' }, setup: { completed: true }, connections: { b: { id: 'b', provider: 'gemini', model: 'b-model' } }, projects: { [root]: { connection: 'b' } } })
  const ctx = { state: { mode: 'chat', model: 'connection/a/a-model', connectionId: 'a', modelSource: 'session', operatorMode: 'hard_plan' }, projectSettingsApplied: true,
    resolveCurrentTarget: () => ({ targetRoot: root }), resolveSessionModel: () => {}, saveSessionState: () => {} }
  const previous = process.env['BABEL_INTERACTIVE']
  try {
    await bootstrapReplSession(ctx as never, () => null, { warmRuntime: false, startIndexing: false })
    assert.equal(ctx.state.mode, 'deep')
    handleMode(ctx as never, ['work'])
    assert.equal(ctx.state.mode, 'deep'); assert.equal(ctx.state.operatorMode, 'hard_plan')
    await handleCommand(ctx as never, '/setup')
    assert.equal(ctx.state.model, 'connection/b/b-model'); assert.equal(ctx.state.connectionId, 'b')
  } finally { if (previous === undefined) delete process.env['BABEL_INTERACTIVE']; else process.env['BABEL_INTERACTIVE'] = previous }
}))

test('plain presentation does not change approval flags or select an animated renderer', async () => {
  const { createLiveRunRenderer, AppendOnlyRenderer } = await import('../ui/waterfall.js')
  const { BabelEventBus } = await import('../pipeline.js')
  const { applyRunCommandEnvFlags } = await import('./runCommandEnv.js')
  const prior = process.env['BABEL_HEADLESS']
  withInvocationSettings({ presentation: 'plain' }, () => {
    const renderer = createLiveRunRenderer(new BabelEventBus(), {}, { isTTY: true } as NodeJS.WriteStream)
    assert.ok(renderer instanceof AppendOnlyRenderer)
    applyRunCommandEnvFlags({ mode: 'chat' })
    assert.equal(process.env['BABEL_HEADLESS'], prior)
  })
})

test('selected connection header and status retain exact model spelling', async () => fixture(async () => {
  const { printIdleHeader, renderTurnStatusBar } = await import('../interactive/repl/replSessionUi.js')
  const { OutputBuffer } = await import('../ui/outputBuffer.js')
  updateUserSettings({ connections: { a: { id: 'a', provider: 'openai', model: 'Vendor/Exact-Case_v1.2' } } })
  const buffer = OutputBuffer.getInstance(); const previousWrite = buffer.write
  const output: string[] = []
  buffer.write = text => { output.push(text) }
  try {
    const ctx = { state: { mode: 'chat', model: 'connection/a/Vendor/Exact-Case_v1.2', costTotals: { totalTokens: 0, totalCostUSD: 0 } }, turnCounter: 0 }
    printIdleHeader(ctx as never)
    renderTurnStatusBar(ctx as never)
    assert.equal(output.length, 2)
    for (const text of output) assert.ok(text.includes('openai/Vendor/Exact-Case_v1.2'))
  } finally { buffer.write = previousWrite }
}))

test('retained fast Ask session rejects a finite cap before transport dispatch', async () => fixture(async () => {
  const { AgentSession } = await import('../agent/session.js')
  const prior = globalThis.fetch; let dispatched = 0
  globalThis.fetch = async () => { dispatched++; throw new Error('unexpected fixture dispatch') }
  try {
    updateUserSettings({ defaults: { budgetUsd: 2 } })
    const projectRoot = mkdtempSync(join(tmpdir(), 'babel-ask-budget-'))
    await assert.rejects(new AgentSession({ verb: 'ask', task: 'Explain', projectRoot, model: 'connection/a/a-model', provider: 'live' }).runAsk(), /BUDGET_UNSUPPORTED/)
    assert.equal(dispatched, 0)
  } finally { globalThis.fetch = prior }
}))
