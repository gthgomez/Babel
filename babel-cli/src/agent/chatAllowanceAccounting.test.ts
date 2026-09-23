import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { RunnerInvocationMetadata } from '../runners/base.js'
import { CostTracker, globalCostTracker } from '../services/costTracker.js'
import { chatSessionDir } from '../cli/runsLayout.js'
import { ChatEngine } from './chatEngine.js'
import { deriveChildAllowance, inheritedChildBudgetLimiter } from './childBudget.js'

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

test('finite task dollar cap refuses another request after unknown-price usage', () => {
  const runsRoot = mkdtempSync(join(tmpdir(), 'babel-chat-unknown-cost-'))
  const projectRoot = mkdtempSync(join(tmpdir(), 'babel-chat-unknown-project-'))
  const previousRunsDir = process.env['BABEL_RUNS_DIR']
  const previousUsage = globalCostTracker.getSessionSummary()
  process.env['BABEL_RUNS_DIR'] = runsRoot
  globalCostTracker.resetSession()
  try {
    const engine = new ChatEngine({ task: 'finite cap task', projectRoot, model: 'deepseek-v4-flash' })
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
