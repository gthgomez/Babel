import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChatEngine } from './chatEngine.js'
import { globalCostTracker } from '../services/costTracker.js'
import { resolveChatEngineLimits } from '../config/chatEngineLimits.js'
import { computeCriticRepairCostCap } from './chatEngineCriticBudget.js'

test('default task-class limits are monetarily unlimited without env override', () => {
  const previous = process.env['BABEL_CHAT_MAX_COST']
  delete process.env['BABEL_CHAT_MAX_COST']
  try {
    const limits = resolveChatEngineLimits()
    assert.equal(limits.maxCostUsd, Infinity)
    assert.deepEqual(limits.runAllowance?.costAllowance, { kind: 'unlimited' })
  } finally {
    if (previous === undefined) delete process.env['BABEL_CHAT_MAX_COST']
    else process.env['BABEL_CHAT_MAX_COST'] = previous
  }
})

test('critic repair does not shrink unlimited parent dollar cap', () => {
  const { capUsd } = computeCriticRepairCostCap({
    spentUsd: 0.5,
    sessionMaxCostUsd: Infinity,
  })
  assert.equal(capUsd, Infinity)
})

test('default unlimited grant tolerates unknown pricing in checkBudgets', () => {
  const limits = resolveChatEngineLimits()
  assert.equal(limits.maxCostUsd, Infinity)
  const engine = new ChatEngine({
    task: 'budget probe',
    projectRoot: mkdtempSync(join(tmpdir(), 'babel-unlimited-probe-')),
    model: 'deepseek-v4-flash',
    maxTurns: 2,
    runtimeMode: 'direct',
  })
  const owner = (engine as unknown as { taskAllowance: { taskOwnerId: string } }).taskAllowance.taskOwnerId
  globalCostTracker.recordUnknownCharge('fixture-unpriced-model', {
    taskOwnerId: owner,
    chargeId: 'probe-unknown-charge',
  })
  const budgets = (engine as unknown as { checkBudgets: (skip?: boolean) => { ok: boolean } }).checkBudgets(true)
  assert.equal(budgets.ok, true)
})

