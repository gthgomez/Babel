import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { RunnerInvocationMetadata } from '../runners/base.js'
import { CostTracker, globalCostTracker } from '../services/costTracker.js'
import { chatSessionDir } from '../cli/runsLayout.js'
import { ChatEngine } from './chatEngine.js'
import { createChildBudgetController, deriveChildAllowance, inheritedChildBudgetLimiter } from './childBudget.js'
import { parseTaskAllowance } from './chatEngineTaskAllowance.js'
import { startBackgroundShell, killAllBackgroundShells } from './backgroundShell.js'
import { resolveChatEngineLimits } from '../config/chatEngineLimits.js'

function usageMetadata(inputTokens: number, outputTokens: number): RunnerInvocationMetadata {
  return {
    provider: 'deepseek',
    provider_model_id: 'deepseek-v4-flash',
    latency_ms: 0,
    prompt_tokens: inputTokens,
    completion_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
    estimated_cost_usd: null,
  }
}

function accountingAccess(engine: ChatEngine): {
  currentTaskCostUsd: () => number
  trackRunnerUsage: (runner: {
    getLastInvocationMetadata: () => RunnerInvocationMetadata
  }) => void
} {
  return engine as unknown as {
    currentTaskCostUsd: () => number
    trackRunnerUsage: (runner: {
      getLastInvocationMetadata: () => RunnerInvocationMetadata
    }) => void
  }
}

interface AllowanceSnapshot {
  schemaVersion: 2
  taskOwnerId: string
  accountingEpoch: string
  grant: {
    grantId: string
    provenance: string
    costCap: { kind: 'finite'; usd: number } | { kind: 'unlimited' }
    wallCapMs: number
    turnCap: number
  }
  consumed: {
    costUsd: number
    activeWallMs: number
    turns: number
  }
  repair: {
    criticRepairCostCapUsd: number | null
    postWriteRepairWallCapMs: number | null
    postWriteRepairRestrict: boolean
  }
}

function allowanceAccess(engine: ChatEngine): {
  getTaskAllowanceSnapshot: () => AllowanceSnapshot | null
  renewAllowance: (grant: {
    grantId: string
    provenance: string
    costCapUsd: number
    wallCapMs: number
    turnCap: number
  }) => void
  checkBudgets: () => { ok: boolean; limiter?: string; reason?: string }
  consumeTaskTurn: () => void
  beginActiveExecution: () => void
  pauseActiveExecution: () => void
  applyPostWriteRepairBudget: () => void
  persistTaskAllowance: () => void
} {
  return engine as unknown as {
    getTaskAllowanceSnapshot: () => AllowanceSnapshot | null
    renewAllowance: (grant: {
      grantId: string
      provenance: string
      costCapUsd: number
      wallCapMs: number
      turnCap: number
    }) => void
    checkBudgets: () => { ok: boolean; limiter?: string; reason?: string }
    consumeTaskTurn: () => void
    beginActiveExecution: () => void
    pauseActiveExecution: () => void
    applyPostWriteRepairBudget: () => void
    persistTaskAllowance: () => void
  }
}

test('unlimited wall survives active work, JSON roundtrip and cold resume without an inherited child timer', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-wall-unlimited-'))
  const keys = ['BABEL_RUNS_DIR', 'BABEL_CHAT_MAX_WALL_MS', 'BABEL_CHAT_TASK_CLASS']
  const previous = keys.map(key => process.env[key])
  process.env['BABEL_RUNS_DIR'] = join(root, 'runs')
  delete process.env['BABEL_CHAT_MAX_WALL_MS']
  process.env['BABEL_CHAT_TASK_CLASS'] = 'quick_inspect'
  const originalNow = Date.now
  let now = 1_800_000_000_000
  Date.now = () => now
  try {
    const engine = new ChatEngine({ model: 'deepseek-v4-flash-openrouter', task: 'Count repository files', projectRoot: root })
    engine.applyUserSubmission({ userInput: 'Count repository files' })
    const access = allowanceAccess(engine)
    access.beginActiveExecution()
    now += 1_200_000
    access.consumeTaskTurn()
    assert.equal(access.checkBudgets().ok, true)
    access.pauseActiveExecution()
    const snapshot = JSON.parse(JSON.stringify(access.getTaskAllowanceSnapshot()))
    assert.deepEqual(snapshot.grant.wallAllowance, { kind: 'unlimited' })
    assert.ok(parseTaskAllowance(snapshot))
    const resumed = new ChatEngine({ model: 'deepseek-v4-flash-openrouter', task: 'Count repository files', projectRoot: root,
      runId: engine.getEngineRunId(), resumeExisting: true })
    assert.equal(allowanceAccess(resumed).checkBudgets().ok, true)
    assert.equal(allowanceAccess(resumed).getTaskAllowanceSnapshot()!.consumed.activeWallMs, 1_200_000)
    const owner = (resumed as unknown as { taskAllowanceOwner: { deriveChildAllowance: (rounds: number) => ReturnType<typeof deriveChildAllowance> } }).taskAllowanceOwner
    const child = owner.deriveChildAllowance(2)
    assert.equal(child.deadlineAtMs, null)
    const parent = new AbortController()
    const control = createChildBudgetController(child, parent.signal)
    assert.equal(control.signal.aborted, false)
    parent.abort()
    assert.equal(control.signal.aborted, true)
    assert.equal(control.limiter(), null)
    control.dispose()
    const malformed = structuredClone(snapshot)
    delete malformed.grant.wallAllowance
    assert.equal(parseTaskAllowance(malformed), null, 'unmarked null wall evidence must fail closed')
    malformed.grant.wallAllowance = { kind: 'unlimited' }
    malformed.grant.wallCapMs = 60_000
    assert.equal(parseTaskAllowance(malformed), null, 'a marker cannot upgrade finite evidence')
    malformed.grant.wallCapMs = NaN
    assert.equal(parseTaskAllowance(malformed), null, 'NaN cannot become unlimited')
    malformed.grant.wallCapMs = null
    malformed.grant.wallAllowance = { kind: 'unknown' }
    assert.equal(parseTaskAllowance(malformed), null, 'unknown wall evidence cannot become unlimited')
    malformed.grant.wallAllowance = { kind: 'unlimited' }
    malformed.repair.postWriteRepairWallCapMs = -1
    assert.equal(parseTaskAllowance(malformed), null, 'invalid repair state cannot be discarded before validation')
  } finally {
    Date.now = originalNow
    keys.forEach((key, i) => previous[i] === undefined ? delete process.env[key] : process.env[key] = previous[i])
    rmSync(root, { recursive: true, force: true })
  }
})

test('unlimited repair survives the old 180-second cap and cold resume with stale derived state', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-wall-repair-'))
  const keys = ['BABEL_RUNS_DIR', 'BABEL_CHAT_MAX_WALL_MS', 'BABEL_CHAT_TASK_CLASS']
  const previous = keys.map(key => process.env[key])
  process.env['BABEL_RUNS_DIR'] = join(root, 'runs')
  delete process.env['BABEL_CHAT_MAX_WALL_MS']
  process.env['BABEL_CHAT_TASK_CLASS'] = 'quick_fix'
  const originalNow = Date.now
  let now = 1_800_000_000_000
  Date.now = () => now
  try {
    const engine = new ChatEngine({ model: 'deepseek-v4-flash-openrouter', task: 'fix the failing implementation', projectRoot: root })
    engine.applyUserSubmission({ userInput: 'fix the failing implementation' })
    const access = allowanceAccess(engine)
    const internals = engine as unknown as {
      lastVerifierFailed: boolean
      toolCallLog: Array<{ tool: string; target: string; effect_status: string; mutation_paths: string[] }>
      conversation: Array<{ content: string }>
      postWriteRepairWallCapMs: number | null
      taskAllowanceOwner: { deriveChildAllowance: (rounds: number) => ReturnType<typeof deriveChildAllowance> }
    }
    access.beginActiveExecution()
    now += 10_000
    accountingAccess(engine).trackRunnerUsage({ getLastInvocationMetadata: () => ({
      provider: 'openrouter', provider_model_id: 'z-ai/glm-5.3-flash', latency_ms: 0,
      prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100, estimated_cost_usd: 1.25,
    }) })
    internals.lastVerifierFailed = true
    writeFileSync(join(root, 'implementation.ts'), 'export const fixed = true\n')
    internals.toolCallLog.push({ tool: 'str_replace', target: 'implementation.ts',
      effect_status: 'confirmed_change', mutation_paths: ['implementation.ts'] })
    access.applyPostWriteRepairBudget()
    const entered = access.getTaskAllowanceSnapshot()!
    assert.equal(entered.repair.postWriteRepairRestrict, true)
    assert.equal(entered.repair.postWriteRepairWallCapMs, null)
    assert.doesNotMatch(internals.conversation.at(-1)!.content, /Infinity/)
    access.consumeTaskTurn()
    now += 200_000
    assert.equal(access.checkBudgets().ok, true, access.checkBudgets().reason)
    // Old checkpoints can contain a finite cap derived from an unlimited grant.
    internals.postWriteRepairWallCapMs = 190_000
    assert.equal(access.checkBudgets().ok, true)
    assert.equal(internals.taskAllowanceOwner.deriveChildAllowance(2).deadlineAtMs, null)
    access.pauseActiveExecution()
    const before = access.getTaskAllowanceSnapshot()!
    const resumed = new ChatEngine({ model: 'deepseek-v4-flash-openrouter', task: 'fix the failing implementation', projectRoot: root,
      runId: engine.getEngineRunId(), resumeExisting: true })
    const restored = allowanceAccess(resumed).getTaskAllowanceSnapshot()!
    assert.equal(allowanceAccess(resumed).checkBudgets().ok, true)
    assert.equal(restored.repair.postWriteRepairWallCapMs, null)
    assert.equal(restored.repair.postWriteRepairRestrict, true)
    assert.equal(restored.taskOwnerId, before.taskOwnerId)
    assert.deepEqual(restored.grant, before.grant)
    assert.deepEqual(restored.consumed, before.consumed)
    assert.equal(restored.consumed.activeWallMs, 210_000)
    assert.equal(restored.consumed.turns, 1)
    assert.ok(restored.consumed.costUsd > 0)
  } finally {
    Date.now = originalNow
    keys.forEach((key, i) => previous[i] === undefined ? delete process.env[key] : process.env[key] = previous[i])
    rmSync(root, { recursive: true, force: true })
  }
})

test('historical finite wall evidence expires honestly after cold resume under unlimited defaults', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-wall-finite-'))
  const previous = process.env['BABEL_RUNS_DIR']
  process.env['BABEL_RUNS_DIR'] = join(root, 'runs')
  const originalNow = Date.now
  let now = 1_800_000_000_000
  Date.now = () => now
  try {
    const engine = new ChatEngine({ model: 'deepseek-v4-flash-openrouter', task: 'finite task', projectRoot: root, maxWallMs: 600_000 })
    engine.applyTurnPreparation({ task: 'finite task', projectRoot: root, limits: resolveChatEngineLimits() })
    engine.applyUserSubmission({ userInput: 'finite task' })
    assert.equal(engine.getTaskAllowanceSnapshot()!.grant.wallCapMs, 600_000)
    const access = allowanceAccess(engine)
    access.beginActiveExecution()
    now += 600_000
    access.pauseActiveExecution()
    const file = join(chatSessionDir(engine.getEngineRunId()), 'task-budget.json')
    const historical = JSON.parse(readFileSync(file, 'utf8'))
    delete historical.grant.wallAllowance
    writeFileSync(file, JSON.stringify(historical))
    const resumed = new ChatEngine({ model: 'deepseek-v4-flash-openrouter', task: 'finite task', projectRoot: root,
      runId: engine.getEngineRunId(), resumeExisting: true })
    const result = allowanceAccess(resumed).checkBudgets()
    assert.equal(result.ok, false)
    assert.equal(result.limiter, 'wall')
    assert.match(result.reason!, /600s of 600s/)
    // Normal preparation may select the new default; it cannot expand a retained grant.
    const preparedLimits = resolveChatEngineLimits()
    resumed.applyTurnPreparation({ task: 'finite task', projectRoot: root, limits: preparedLimits })
    const owner = (resumed as unknown as { taskAllowanceOwner: { deriveChildAllowance: (rounds: number) => ReturnType<typeof deriveChildAllowance> } }).taskAllowanceOwner
    assert.equal(owner.deriveChildAllowance(2).deadlineAtMs, now)
  } finally {
    Date.now = originalNow
    if (previous === undefined) delete process.env['BABEL_RUNS_DIR']
    else process.env['BABEL_RUNS_DIR'] = previous
    rmSync(root, { recursive: true, force: true })
  }
})

test('historical finite repair caps survive cold resume under unlimited defaults', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-wall-finite-repair-'))
  const previousRuns = process.env['BABEL_RUNS_DIR']
  process.env['BABEL_RUNS_DIR'] = join(root, 'runs')
  try {
    const engine = new ChatEngine({ model: 'deepseek-v4-flash-openrouter', task: 'finite repair', projectRoot: root, maxWallMs: 600_000 })
    engine.applyUserSubmission({ userInput: 'finite repair' })
    const internals = engine as unknown as {
      postWriteRepairWallCapMs: number | null
      taskAllowance: { consumed: { activeWallMs: number } }
    }
    internals.postWriteRepairWallCapMs = 180_000
    internals.taskAllowance.consumed.activeWallMs = 200_000
    allowanceAccess(engine).persistTaskAllowance()
    const resumed = new ChatEngine({ model: 'deepseek-v4-flash-openrouter', task: 'finite repair', projectRoot: root,
      runId: engine.getEngineRunId(), resumeExisting: true })
    assert.equal(allowanceAccess(resumed).getTaskAllowanceSnapshot()!.repair.postWriteRepairWallCapMs, 180_000)
    assert.equal(allowanceAccess(resumed).checkBudgets().limiter, 'wall_repair')
  } finally {
    if (previousRuns === undefined) delete process.env['BABEL_RUNS_DIR']
    else process.env['BABEL_RUNS_DIR'] = previousRuns
    rmSync(root, { recursive: true, force: true })
  }
})

test('fresh objectives use current wall environment without promoting it to a constructor override', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-wall-precedence-'))
  const previousRuns = process.env['BABEL_RUNS_DIR']
  const previousWall = process.env['BABEL_CHAT_MAX_WALL_MS']
  const originalNow = Date.now
  let now = 1_800_000_000_000
  Date.now = () => now
  process.env['BABEL_RUNS_DIR'] = join(root, 'runs')
  process.env['BABEL_CHAT_MAX_WALL_MS'] = '40000'
  try {
    const engine = new ChatEngine({ model: 'deepseek-v4-flash-openrouter', task: 'first task', projectRoot: root })
    const prepare = (task: string) => engine.applyTurnPreparation({ task, projectRoot: root, limits: resolveChatEngineLimits() })
    prepare('first task')
    engine.applyUserSubmission({ userInput: 'first task' })
    const originalOwner = engine.getTaskAllowanceSnapshot()!.taskOwnerId
    assert.equal(engine.getTaskAllowanceSnapshot()!.grant.wallCapMs, 40_000)
    process.env['BABEL_CHAT_MAX_WALL_MS'] = '12000'
    prepare('a different unrelated task')
    assert.equal(engine.getTaskAllowanceSnapshot()!.grant.wallCapMs, 40_000, 'preparation cannot shrink a retained grant')
    engine.applyUserSubmission({ userInput: 'a different unrelated task' })
    assert.notEqual(engine.getTaskAllowanceSnapshot()!.taskOwnerId, originalOwner)
    assert.equal(engine.getTaskAllowanceSnapshot()!.grant.wallCapMs, 12_000)
    allowanceAccess(engine).beginActiveExecution()
    now += 13_000
    assert.equal(allowanceAccess(engine).checkBudgets().limiter, 'wall')
    allowanceAccess(engine).pauseActiveExecution()

    const constructor = new ChatEngine({ model: 'deepseek-v4-flash-openrouter', task: 'explicit constructor task', projectRoot: root, maxWallMs: 30_000 })
    constructor.applyTurnPreparation({ task: 'explicit constructor task', projectRoot: root, limits: resolveChatEngineLimits() })
    constructor.applyUserSubmission({ userInput: 'explicit constructor task' })
    assert.equal(constructor.getTaskAllowanceSnapshot()!.grant.wallCapMs, 30_000)

    delete process.env['BABEL_CHAT_MAX_WALL_MS']
    prepare('another wholly unrelated task')
    engine.applyUserSubmission({ userInput: 'another wholly unrelated task' })
    assert.deepEqual(engine.getTaskAllowanceSnapshot()!.grant.wallAllowance, { kind: 'unlimited' })
  } finally {
    Date.now = originalNow
    if (previousRuns === undefined) delete process.env['BABEL_RUNS_DIR']
    else process.env['BABEL_RUNS_DIR'] = previousRuns
    if (previousWall === undefined) delete process.env['BABEL_CHAT_MAX_WALL_MS']
    else process.env['BABEL_CHAT_MAX_WALL_MS'] = previousWall
    rmSync(root, { recursive: true, force: true })
  }
})

test('user cancellation still stops a real owned background process under the default wall allowance', { timeout: 10_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-wall-cancel-'))
  const engine = new ChatEngine({ model: 'deepseek-v4-flash-openrouter', task: 'cancel controlled work', projectRoot: root })
  const ownerId = engine.getEngineRunId()
  const script = join(root, 'wait.cjs')
  writeFileSync(script, 'setInterval(function () {}, 1000)')
  const job = startBackgroundShell({ cwd: root, ownerId,
    command: `"${process.execPath.replace(/\\/g, '/')}" "${script.replace(/\\/g, '/')}"` })
  try {
    engine.cancel()
    assert.equal(job.status, 'killed')
    await job.done
    assert.notEqual(job.status, 'running')
  } finally {
    killAllBackgroundShells({ ownerId, includeDetached: true })
    rmSync(root, { recursive: true, force: true })
  }
})

test('A-1: overlapping ChatEngine tasks account provider usage only to their owner', () => {
  const runsRoot = mkdtempSync(join(tmpdir(), 'babel-chat-allowance-a1-'))
  const projectRoot = mkdtempSync(join(tmpdir(), 'babel-chat-allowance-project-'))
  const previousRunsDir = process.env['BABEL_RUNS_DIR']
  const previousUsage = globalCostTracker.getSessionSummary()
  process.env['BABEL_RUNS_DIR'] = runsRoot
  globalCostTracker.resetSession()

  try {
    const engineA = new ChatEngine({ task: 'task A', projectRoot, model: 'deepseek-v4-flash' })
    engineA.applyUserSubmission({ userInput: 'start task A' })
    const engineB = new ChatEngine({ task: 'task B', projectRoot, model: 'deepseek-v4-flash' })
    engineB.applyUserSubmission({ userInput: 'start task B' })
    const taskA = accountingAccess(engineA)
    const taskB = accountingAccess(engineB)

    taskA.trackRunnerUsage({ getLastInvocationMetadata: () => usageMetadata(10_000, 1_000) })
    const taskASpendBeforePause = taskA.currentTaskCostUsd()
    assert.ok(taskASpendBeforePause > 0)
    assert.equal(taskB.currentTaskCostUsd(), 0)

    taskB.trackRunnerUsage({ getLastInvocationMetadata: () => usageMetadata(20_000, 2_000) })
    const continued = engineA.applyUserSubmission({
      userInput: 'continue task A',
      continueTask: true,
    })

    assert.equal(continued.continuedTask, true)
    assert.equal(taskA.currentTaskCostUsd(), taskASpendBeforePause)
    assert.ok(taskB.currentTaskCostUsd() > 0)
  } finally {
    globalCostTracker.resetSession()
    globalCostTracker.restoreSessionCost({
      totalCostUSD: previousUsage.totalCostUSD,
      totalInputTokens: previousUsage.totalInputTokens,
      totalOutputTokens: previousUsage.totalOutputTokens,
      totalTokens: previousUsage.totalTokens,
    })
    if (previousRunsDir === undefined) delete process.env['BABEL_RUNS_DIR']
    else process.env['BABEL_RUNS_DIR'] = previousRunsDir
    rmSync(runsRoot, { recursive: true, force: true })
    rmSync(projectRoot, { recursive: true, force: true })
  }
})

test('A-2: task-indexed usage sums to the independent global aggregate', () => {
  const tracker = new CostTracker()
  const first = tracker.trackUsage('deepseek-v4-flash', 10_000, 1_000, null, null, {
    taskOwnerId: 'task-a',
    chargeId: 'charge-a',
  })
  const second = tracker.trackUsage('deepseek-v4-flash', 20_000, 2_000, null, null, {
    taskOwnerId: 'task-b',
    chargeId: 'charge-b',
  })

  assert.ok(first !== null && second !== null)

  assert.equal(tracker.getTaskSummary('task-a').totalCostUSD, first)
  assert.equal(tracker.getTaskSummary('task-b').totalCostUSD, second)
  assert.equal(tracker.getSessionSummary().totalCostUSD, first + second)
})

test('A-3: delegated child usage charges the child and its parent exactly once', () => {
  const tracker = new CostTracker()
  const allowance = deriveChildAllowance({
    parentTaskOwnerId: 'parent-owner',
    parentTaskBaselineUsd: 0,
    parentEffectiveCostCapUsd: 1,
    parentDeadlineAtMs: null,
    childMaxRounds: 2,
  }) as ReturnType<typeof deriveChildAllowance> & {
    taskOwnerId: string
    parentTaskOwnerId: string
  }
  const cost = tracker.trackUsage('deepseek-v4-flash', 12_000, 1_200, null, null, {
    taskOwnerId: allowance.taskOwnerId,
    parentTaskOwnerId: allowance.parentTaskOwnerId,
    chargeId: 'delegation-charge-1',
  })
  const duplicate = tracker.trackUsage('deepseek-v4-flash', 12_000, 1_200, null, null, {
    taskOwnerId: 'child-owner',
    parentTaskOwnerId: 'parent-owner',
    chargeId: 'delegation-charge-1',
  })

  assert.equal(duplicate, 0)
  assert.notEqual(allowance.taskOwnerId, allowance.parentTaskOwnerId)
  assert.equal(tracker.getTaskSummary(allowance.taskOwnerId).totalCostUSD, cost)
  assert.equal(tracker.getTaskSummary('parent-owner').totalCostUSD, cost)
  assert.equal(tracker.getSessionSummary().totalCostUSD, cost)
})

test('late provider usage remains billed to the cancelled owner after a new task starts', () => {
  const runsRoot = mkdtempSync(join(tmpdir(), 'babel-chat-late-usage-'))
  const projectRoot = mkdtempSync(join(tmpdir(), 'babel-chat-late-project-'))
  const previousRunsDir = process.env['BABEL_RUNS_DIR']
  const previousUsage = globalCostTracker.getSessionSummary()
  process.env['BABEL_RUNS_DIR'] = runsRoot
  globalCostTracker.resetSession()
  try {
    const engine = new ChatEngine({ task: 'task A', projectRoot, model: 'deepseek-v4-flash' })
    engine.applyUserSubmission({ userInput: 'start task A' })
    const ownerA = allowanceAccess(engine).getTaskAllowanceSnapshot()!.taskOwnerId
    const scope = {
      taskOwnerId: ownerA,
      accountingEpoch: globalCostTracker.getAccountingEpoch(),
      turnId: null,
      chargeId: 'late-A-charge',
    }
    engine.applyUserSubmission({ userInput: 'start task B' })
    const ownerB = allowanceAccess(engine).getTaskAllowanceSnapshot()!.taskOwnerId
    assert.notEqual(ownerA, ownerB)
    const tracker = engine as unknown as {
      trackRunnerUsage: (runner: { getLastInvocationMetadata: () => RunnerInvocationMetadata }, usageScope: typeof scope) => void
    }
    tracker.trackRunnerUsage({ getLastInvocationMetadata: () => usageMetadata(10_000, 1_000) }, scope)
    assert.ok(globalCostTracker.getTaskSummary(ownerA).totalCostUSD > 0)
    assert.equal(globalCostTracker.getTaskSummary(ownerB).totalCostUSD, 0)
    assert.deepEqual(globalCostTracker.getTaskChargeIds(ownerA), ['late-A-charge'])
    assert.equal(accountingAccess(engine).currentTaskCostUsd(), 0)
  } finally {
    globalCostTracker.resetSession()
    globalCostTracker.restoreSessionCost({
      totalCostUSD: previousUsage.totalCostUSD,
      totalInputTokens: previousUsage.totalInputTokens,
      totalOutputTokens: previousUsage.totalOutputTokens,
      totalTokens: previousUsage.totalTokens,
    })
    if (previousRunsDir === undefined) delete process.env['BABEL_RUNS_DIR']
    else process.env['BABEL_RUNS_DIR'] = previousRunsDir
    rmSync(runsRoot, { recursive: true, force: true })
    rmSync(projectRoot, { recursive: true, force: true })
  }
})

const CC_MODEL = 'deepseek/deepseek-v4.1-flash'
const CC_PROVIDER = 'command-code'

test('finite Command Code grant blocks after absent usage leaves an unknown charge', () => {
  const runsRoot = mkdtempSync(join(tmpdir(), 'babel-cc-absent-runs-'))
  const projectRoot = mkdtempSync(join(tmpdir(), 'babel-cc-absent-project-'))
  const previousRunsDir = process.env['BABEL_RUNS_DIR']
  const previousUsage = globalCostTracker.getSessionSummary()
  process.env['BABEL_RUNS_DIR'] = runsRoot
  globalCostTracker.resetSession()
  try {
    const engine = new ChatEngine({ task: 'finite cc absent usage', projectRoot, model: 'command-code/deepseek-v4.1-flash', maxCostUsd: 2 })
    engine.applyUserSubmission({ userInput: 'start finite cc task' })
    const owner = allowanceAccess(engine).getTaskAllowanceSnapshot()!.taskOwnerId
    globalCostTracker.settleUsage(CC_MODEL, 0, 0, null, null,
      { taskOwnerId: owner, chargeId: 'cc-absent-usage' }, false, CC_PROVIDER, undefined)
    const summary = globalCostTracker.getTaskSummary(owner)
    assert.equal(summary.unknownChargeCount, 1)
    assert.equal(summary.completeCostUSD, null)
    const budget = allowanceAccess(engine).checkBudgets()
    assert.equal(budget.ok, false)
    assert.equal(budget.limiter, 'cost')
    assert.match(budget.reason ?? '', /unknown pricing/)
  } finally {
    globalCostTracker.resetSession()
    globalCostTracker.restoreSessionCost({
      totalCostUSD: previousUsage.totalCostUSD,
      totalInputTokens: previousUsage.totalInputTokens,
      totalOutputTokens: previousUsage.totalOutputTokens,
      totalTokens: previousUsage.totalTokens,
    })
    if (previousRunsDir === undefined) delete process.env['BABEL_RUNS_DIR']
    else process.env['BABEL_RUNS_DIR'] = previousRunsDir
    rmSync(runsRoot, { recursive: true, force: true })
    rmSync(projectRoot, { recursive: true, force: true })
  }
})

test('finite task dollar cap refuses another request after unknown-price usage', () => {
  const runsRoot = mkdtempSync(join(tmpdir(), 'babel-chat-unknown-cost-'))
  const projectRoot = mkdtempSync(join(tmpdir(), 'babel-chat-unknown-project-'))
  const previousRunsDir = process.env['BABEL_RUNS_DIR']
  const previousUsage = globalCostTracker.getSessionSummary()
  process.env['BABEL_RUNS_DIR'] = runsRoot
  globalCostTracker.resetSession()
  try {
    const engine = new ChatEngine({ task: 'finite cap task', projectRoot, model: 'deepseek-v4-flash', maxCostUsd: 2 })
    engine.applyUserSubmission({ userInput: 'start finite cap task' })
    const owner = allowanceAccess(engine).getTaskAllowanceSnapshot()!.taskOwnerId
    globalCostTracker.recordUnknownCharge('unlisted-provider-model', { taskOwnerId: owner, chargeId: 'unknown-priced-request' })
    const summary = globalCostTracker.getTaskSummary(owner)
    assert.equal(summary.completeCostUSD, null)
    assert.equal(summary.unknownChargeCount, 1)
    const budget = allowanceAccess(engine).checkBudgets()
    assert.equal(budget.ok, false)
    assert.equal(budget.limiter, 'cost')
    assert.match(budget.reason ?? '', /unknown pricing/)
  } finally {
    globalCostTracker.resetSession()
    globalCostTracker.restoreSessionCost({
      totalCostUSD: previousUsage.totalCostUSD,
      totalInputTokens: previousUsage.totalInputTokens,
      totalOutputTokens: previousUsage.totalOutputTokens,
      totalTokens: previousUsage.totalTokens,
    })
    if (previousRunsDir === undefined) delete process.env['BABEL_RUNS_DIR']
    else process.env['BABEL_RUNS_DIR'] = previousRunsDir
    rmSync(runsRoot, { recursive: true, force: true })
    rmSync(projectRoot, { recursive: true, force: true })
  }
})

test('finite task cap uses the Go usage estimate while the actual invoice remains unknown', () => {
  const runsRoot = mkdtempSync(join(tmpdir(), 'babel-go-estimate-runs-'))
  const projectRoot = mkdtempSync(join(tmpdir(), 'babel-go-estimate-project-'))
  const previousRunsDir = process.env['BABEL_RUNS_DIR']
  const previousUsage = globalCostTracker.getSessionSummary()
  process.env['BABEL_RUNS_DIR'] = runsRoot
  globalCostTracker.resetSession()
  try {
    const engine = new ChatEngine({ task: 'finite cap task', projectRoot, model: 'deepseek-v4-flash', maxCostUsd: 2 })
    engine.applyUserSubmission({ userInput: 'start finite cap task' })
    const owner = allowanceAccess(engine).getTaskAllowanceSnapshot()!.taskOwnerId
    globalCostTracker.settleUsage('deepseek-v4.1-flash', 1000, 100, null, null,
      { taskOwnerId: owner, chargeId: 'go-estimate' }, true, 'opencode-go')
    assert.equal(globalCostTracker.getTaskSummary(owner).actualCostUSD, null)
    assert.equal(globalCostTracker.getTaskSummary(owner).costComplete, false)
    assert.equal(globalCostTracker.getTaskSummary(owner).estimateComplete, true)
    assert.equal(allowanceAccess(engine).checkBudgets().ok, true)
  } finally {
    globalCostTracker.resetSession()
    globalCostTracker.restoreSessionCost(previousUsage)
    if (previousRunsDir === undefined) delete process.env['BABEL_RUNS_DIR']
    else process.env['BABEL_RUNS_DIR'] = previousRunsDir
    rmSync(runsRoot, { recursive: true, force: true })
    rmSync(projectRoot, { recursive: true, force: true })
  }
})

test('priced-estimate parent exposes finite child remaining allowance while billing stays incomplete', () => {
  globalCostTracker.resetSession()
  try {
    const parentId = 'parent-priced-estimate'
    globalCostTracker.settleUsage('deepseek-v4-flash', 100, 10, null, null, {
      taskOwnerId: parentId,
      chargeId: 'registry-priced',
    })
    const parentSummary = globalCostTracker.getTaskSummary(parentId)
    assert.equal(parentSummary.costComplete, false)
    assert.equal(parentSummary.estimateComplete, true)
    assert.ok(parentSummary.totalCostUSD > 0)
    const allowance = deriveChildAllowance({
      parentTaskOwnerId: parentId,
      parentTaskBaselineUsd: 0,
      parentEffectiveCostCapUsd: 1,
      parentDeadlineAtMs: null,
      childMaxRounds: 3,
    })
    assert.equal(allowance.accountingComplete, true)
    assert.ok((allowance.remainingCostUsd ?? 0) > 0)
    assert.equal(inheritedChildBudgetLimiter(allowance), null)
  } finally {
    globalCostTracker.resetSession()
  }
})

test('unknown parent accounting blocks finite child remaining allowance and stops immediately', () => {
  globalCostTracker.resetSession()
  try {
    const parentId = 'parent-unknown-accounting'
    globalCostTracker.recordUnknownCharge('unlisted-provider-model', {
      taskOwnerId: parentId,
      chargeId: 'unknown-priced',
    })
    const parentSummary = globalCostTracker.getTaskSummary(parentId)
    assert.equal(parentSummary.estimateComplete, false)
    assert.equal(parentSummary.costComplete, false)
    assert.equal(parentSummary.unknownChargeCount, 1)
    const allowance = deriveChildAllowance({
      parentTaskOwnerId: parentId,
      parentTaskBaselineUsd: 0,
      parentEffectiveCostCapUsd: 1,
      parentDeadlineAtMs: null,
      childMaxRounds: 3,
    })
    assert.equal(allowance.accountingComplete, false)
    assert.equal(allowance.remainingCostUsd, 0)
    assert.equal(inheritedChildBudgetLimiter(allowance), 'cost')
  } finally {
    globalCostTracker.resetSession()
  }
})

test('finite child cost allowance without an owner fails closed despite unrelated session spend', () => {
  const allowance = deriveChildAllowance({
    parentTaskBaselineUsd: 0,
    parentEffectiveCostCapUsd: 1,
    parentDeadlineAtMs: null,
    childMaxRounds: 2,
  })
  assert.equal(allowance.remainingCostUsd, 0)
  assert.equal(inheritedChildBudgetLimiter(allowance), 'cost')
})

test('A-4: provider retry attempts retain task identity and dedupe only the same attempt', () => {
  const tracker = new CostTracker()
  const first = tracker.trackUsage('deepseek-v4-flash', 5_000, 500, null, null, {
    taskOwnerId: 'retry-owner',
    chargeId: 'request-1:attempt-1',
  })
  const retry = tracker.trackUsage('deepseek-v4-flash', 6_000, 600, null, null, {
    taskOwnerId: 'retry-owner',
    chargeId: 'request-1:attempt-2',
  })
  assert.ok(first !== null && retry !== null)
  const replay = tracker.trackUsage('deepseek-v4-flash', 6_000, 600, null, null, {
    taskOwnerId: 'retry-owner',
    chargeId: 'request-1:attempt-2',
  })

  assert.equal(replay, 0)
  assert.equal(tracker.getTaskSummary('retry-owner').totalCostUSD, first + retry)
  assert.equal(tracker.getTaskChargeIds('retry-owner').length, 2)
})

test('A-5: persisted charge identity makes crash-window replay idempotent', () => {
  const runsRoot = mkdtempSync(join(tmpdir(), 'babel-chat-allowance-a5-'))
  const projectRoot = mkdtempSync(join(tmpdir(), 'babel-chat-allowance-project-'))
  const previousRunsDir = process.env['BABEL_RUNS_DIR']
  const previousUsage = globalCostTracker.getSessionSummary()
  process.env['BABEL_RUNS_DIR'] = runsRoot
  globalCostTracker.resetSession()

  try {
    const engine = new ChatEngine({ task: 'crash task', projectRoot, model: 'deepseek-v4-flash' })
    engine.applyUserSubmission({ userInput: 'start crash task' })
    const access = allowanceAccess(engine)
    const owner = access.getTaskAllowanceSnapshot()!.taskOwnerId
    const cost = globalCostTracker.trackUsage('deepseek-v4-flash', 15_000, 1_500, null, null, {
      taskOwnerId: owner,
      chargeId: 'stable-provider-attempt',
    })
    access.persistTaskAllowance()
    const runId = engine.getEngineRunId()

    globalCostTracker.resetSession()
    const resumed = new ChatEngine({
      task: 'crash task',
      projectRoot,
      runId,
      resumeExisting: true,
      model: 'deepseek-v4-flash',
    })
    const restored = allowanceAccess(resumed).getTaskAllowanceSnapshot()!
    const replay = globalCostTracker.trackUsage(
      'deepseek-v4-flash',
      15_000,
      1_500,
      null,
      null,
      { taskOwnerId: restored.taskOwnerId, chargeId: 'stable-provider-attempt' },
    )

    assert.equal(replay, 0)
    assert.equal(restored.consumed.costUsd, cost)
    assert.equal(globalCostTracker.getTaskSummary(restored.taskOwnerId).totalCostUSD, cost)
  } finally {
    globalCostTracker.resetSession()
    globalCostTracker.restoreSessionCost({
      totalCostUSD: previousUsage.totalCostUSD,
      totalInputTokens: previousUsage.totalInputTokens,
      totalOutputTokens: previousUsage.totalOutputTokens,
      totalTokens: previousUsage.totalTokens,
    })
    if (previousRunsDir === undefined) delete process.env['BABEL_RUNS_DIR']
    else process.env['BABEL_RUNS_DIR'] = previousRunsDir
    rmSync(runsRoot, { recursive: true, force: true })
    rmSync(projectRoot, { recursive: true, force: true })
  }
})

test('A-6: explicit continuation preserves owner, grant, active wall, turns, and repair state', async () => {
  const runsRoot = mkdtempSync(join(tmpdir(), 'babel-chat-allowance-a6-'))
  const projectRoot = mkdtempSync(join(tmpdir(), 'babel-chat-allowance-project-'))
  const previousRunsDir = process.env['BABEL_RUNS_DIR']
  process.env['BABEL_RUNS_DIR'] = runsRoot
  try {
    const engine = new ChatEngine({
      task: 'implement a continued code fix',
      projectRoot,
      model: 'deepseek-v4-flash',
      maxTurns: 8,
      maxWallMs: 60_000,
    })
    engine.applyUserSubmission({ userInput: 'implement the continued code fix' })
    const access = allowanceAccess(engine)
    access.consumeTaskTurn()
    access.beginActiveExecution()
    await new Promise((resolve) => setTimeout(resolve, 5))
    access.pauseActiveExecution()
    // Finding 1: the repair window requires evidence of repair.
    const internals = engine as unknown as {
      lastVerifierFailed: boolean
      currentTurnHasMutation: () => boolean
    }
    internals.currentTurnHasMutation = () => true
    internals.lastVerifierFailed = true
    access.applyPostWriteRepairBudget()
    const before = access.getTaskAllowanceSnapshot()!

    const continued = engine.applyUserSubmission({
      userInput: 'continue implementing the code fix',
      continueTask: true,
    })
    const after = access.getTaskAllowanceSnapshot()!

    assert.equal(continued.continuedTask, true)
    assert.equal(after.taskOwnerId, before.taskOwnerId)
    assert.equal(after.grant.grantId, before.grant.grantId)
    assert.equal(after.consumed.turns, 1)
    assert.ok(after.consumed.activeWallMs >= 1)
    assert.equal(after.repair.postWriteRepairRestrict, true)
    assert.ok(after.repair.postWriteRepairWallCapMs !== null)
  } finally {
    if (previousRunsDir === undefined) delete process.env['BABEL_RUNS_DIR']
    else process.env['BABEL_RUNS_DIR'] = previousRunsDir
    rmSync(runsRoot, { recursive: true, force: true })
    rmSync(projectRoot, { recursive: true, force: true })
  }
})

test('A-6b: a fresh non-continued submission clears the repair window and latch', async () => {
  const runsRoot = mkdtempSync(join(tmpdir(), 'babel-chat-allowance-a6b-'))
  const projectRoot = mkdtempSync(join(tmpdir(), 'babel-chat-allowance-project-'))
  const previousRunsDir = process.env['BABEL_RUNS_DIR']
  process.env['BABEL_RUNS_DIR'] = runsRoot
  try {
    const engine = new ChatEngine({
      task: 'implement a continued code fix',
      projectRoot,
      model: 'deepseek-v4-flash',
      maxTurns: 8,
      maxWallMs: 60_000,
    })
    engine.applyUserSubmission({ userInput: 'implement the continued code fix' })
    const access = allowanceAccess(engine)
    const internals = engine as unknown as {
      lastVerifierFailed: boolean
      currentTurnHasMutation: () => boolean
    }
    internals.currentTurnHasMutation = () => true
    internals.lastVerifierFailed = true
    access.applyPostWriteRepairBudget()
    const entered = access.getTaskAllowanceSnapshot()!
    assert.ok(entered.repair.postWriteRepairWallCapMs !== null)
    assert.equal(entered.repair.postWriteRepairRestrict, true)

    // A stale critic rejection from the previous objective must not survive
    // into the fresh task and re-open the repair window on its first write.
    const criticState = engine as unknown as { lastCriticReceipt: unknown }
    criticState.lastCriticReceipt = { verdict: 'reject' }

    // A fresh, non-continued submission must clear task-local repair punishment.
    engine.applyUserSubmission({ userInput: 'a different, unrelated task' })
    const fresh = access.getTaskAllowanceSnapshot()!
    assert.equal(fresh.repair.postWriteRepairWallCapMs, null)
    assert.equal(fresh.repair.postWriteRepairRestrict, false)
    assert.equal(
      criticState.lastCriticReceipt,
      null,
      'a fresh task must not inherit a stale critic verdict',
    )
  } finally {
    if (previousRunsDir === undefined) delete process.env['BABEL_RUNS_DIR']
    else process.env['BABEL_RUNS_DIR'] = previousRunsDir
    rmSync(runsRoot, { recursive: true, force: true })
    rmSync(projectRoot, { recursive: true, force: true })
  }
})

test('A-7: cold resume preserves the durable task allowance without counting downtime', async () => {
  const runsRoot = mkdtempSync(join(tmpdir(), 'babel-chat-allowance-a7-'))
  const projectRoot = mkdtempSync(join(tmpdir(), 'babel-chat-allowance-project-'))
  const previousRunsDir = process.env['BABEL_RUNS_DIR']
  process.env['BABEL_RUNS_DIR'] = runsRoot
  try {
    const engine = new ChatEngine({ task: 'cold task', projectRoot, model: 'deepseek-v4-flash' })
    engine.applyUserSubmission({ userInput: 'start cold task' })
    const access = allowanceAccess(engine)
    access.consumeTaskTurn()
    access.beginActiveExecution()
    await new Promise((resolve) => setTimeout(resolve, 5))
    access.pauseActiveExecution()
    const before = access.getTaskAllowanceSnapshot()!
    const runId = engine.getEngineRunId()
    await new Promise((resolve) => setTimeout(resolve, 10))

    const resumed = new ChatEngine({
      task: 'cold task',
      projectRoot,
      runId,
      resumeExisting: true,
      model: 'deepseek-v4-flash',
    })
    const after = allowanceAccess(resumed).getTaskAllowanceSnapshot()!

    assert.equal(after.taskOwnerId, before.taskOwnerId)
    assert.equal(after.grant.grantId, before.grant.grantId)
    assert.equal(after.consumed.turns, before.consumed.turns)
    assert.equal(after.consumed.activeWallMs, before.consumed.activeWallMs)
  } finally {
    if (previousRunsDir === undefined) delete process.env['BABEL_RUNS_DIR']
    else process.env['BABEL_RUNS_DIR'] = previousRunsDir
    rmSync(runsRoot, { recursive: true, force: true })
    rmSync(projectRoot, { recursive: true, force: true })
  }
})

test('A-8: a new task receives a fresh owner and grant with zero consumed allowance', () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'babel-chat-allowance-project-'))
  try {
    const engine = new ChatEngine({ task: 'first task', projectRoot, model: 'deepseek-v4-flash' })
    engine.applyUserSubmission({ userInput: 'first task' })
    const access = allowanceAccess(engine)
    access.consumeTaskTurn()
    const first = access.getTaskAllowanceSnapshot()!

    const isolated = engine.applyUserSubmission({ userInput: 'second unrelated task' })
    const second = access.getTaskAllowanceSnapshot()!

    assert.equal(isolated.continuedTask, false)
    assert.notEqual(second.taskOwnerId, first.taskOwnerId)
    assert.notEqual(second.grant.grantId, first.grant.grantId)
    assert.deepEqual(second.consumed, { costUsd: 0, unknownChargeCount: 0, activeWallMs: 0, turns: 0 })
  } finally {
    rmSync(projectRoot, { recursive: true, force: true })
  }
})

test('A-9: missing or corrupt durable allowance fails explicit continuation closed', () => {
  for (const mode of ['missing', 'corrupt'] as const) {
    const runsRoot = mkdtempSync(join(tmpdir(), `babel-chat-allowance-a9-${mode}-`))
    const projectRoot = mkdtempSync(join(tmpdir(), 'babel-chat-allowance-project-'))
    const previousRunsDir = process.env['BABEL_RUNS_DIR']
    process.env['BABEL_RUNS_DIR'] = runsRoot
    try {
      const engine = new ChatEngine({ task: `${mode} task`, projectRoot, model: 'deepseek-v4-flash' })
      engine.applyUserSubmission({ userInput: `start ${mode} task` })
      const runId = engine.getEngineRunId()
      const budgetPath = join(chatSessionDir(runId), 'task-budget.json')
      if (mode === 'missing') unlinkSync(budgetPath)
      else writeFileSync(budgetPath, '{not-json', 'utf8')

      const resumed = new ChatEngine({
        task: `${mode} task`,
        projectRoot,
        runId,
        resumeExisting: true,
        model: 'deepseek-v4-flash',
      })
      resumed.applyUserSubmission({ userInput: `continue ${mode} task`, continueTask: true })
      const budget = allowanceAccess(resumed).checkBudgets()

      assert.equal(budget.ok, false, mode)
      assert.equal(budget.limiter, 'cost', mode)
    } finally {
      if (previousRunsDir === undefined) delete process.env['BABEL_RUNS_DIR']
      else process.env['BABEL_RUNS_DIR'] = previousRunsDir
      rmSync(runsRoot, { recursive: true, force: true })
      rmSync(projectRoot, { recursive: true, force: true })
    }
  }
})

test('A-10: only explicit renewal increases allowance and persists grant provenance', () => {
  const runsRoot = mkdtempSync(join(tmpdir(), 'babel-chat-allowance-a10-'))
  const projectRoot = mkdtempSync(join(tmpdir(), 'babel-chat-allowance-project-'))
  const previousRunsDir = process.env['BABEL_RUNS_DIR']
  process.env['BABEL_RUNS_DIR'] = runsRoot
  try {
    const engine = new ChatEngine({
      task: 'renew task',
      projectRoot,
      model: 'deepseek-v4-flash',
      maxCostUsd: 1,
      maxWallMs: 60_000,
      maxTurns: 4,
    })
    engine.applyUserSubmission({ userInput: 'start renew task' })
    const access = allowanceAccess(engine)
    const before = access.getTaskAllowanceSnapshot()!
    access.renewAllowance({
      grantId: 'grant-renewal-2',
      provenance: 'operator:test-renewal',
      costCapUsd: 2,
      wallCapMs: 120_000,
      turnCap: 8,
    })
    const after = access.getTaskAllowanceSnapshot()!

    assert.equal(after.taskOwnerId, before.taskOwnerId)
    assert.equal(after.grant.grantId, 'grant-renewal-2')
    assert.equal(after.grant.provenance, 'operator:test-renewal')
    assert.deepEqual(after.grant.costCap, { kind: 'finite', usd: 2 })
    assert.equal(after.grant.wallCapMs, 120_000)
    assert.equal(after.grant.turnCap, 8)
    assert.throws(
      () => access.renewAllowance({
        grantId: 'grant-not-an-increase',
        provenance: 'operator:test-invalid',
        costCapUsd: 2,
        wallCapMs: 120_000,
        turnCap: 8,
      }),
      /increase/i,
    )

    const persisted = JSON.parse(
      readFileSync(join(chatSessionDir(engine.getEngineRunId()), 'task-budget.json'), 'utf8'),
    ) as AllowanceSnapshot
    assert.equal(persisted.schemaVersion, 2)
    assert.equal(persisted.grant.grantId, 'grant-renewal-2')
    assert.equal(persisted.grant.provenance, 'operator:test-renewal')
  } finally {
    if (previousRunsDir === undefined) delete process.env['BABEL_RUNS_DIR']
    else process.env['BABEL_RUNS_DIR'] = previousRunsDir
    rmSync(runsRoot, { recursive: true, force: true })
    rmSync(projectRoot, { recursive: true, force: true })
  }
})
