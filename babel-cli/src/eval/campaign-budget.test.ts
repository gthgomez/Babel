import assert from 'node:assert/strict'
import test from 'node:test'
import { CampaignBudget, type CampaignBudgetSnapshot } from './campaign-budget.js'

const options = { campaignId: 'pilot', limitMicroUsd: 100 }

test('outstanding main, retry and auxiliary reservations share one cap', () => {
  const budget = new CampaignBudget(options)
  assert.equal(budget.reserve('main', 50), true)
  assert.equal(budget.reserve('critic', 30), true)
  let starts = 0
  if (budget.reserve('retry', 21)) starts++
  assert.equal(starts, 0)
  assert.equal(budget.remainingMicroUsd(), 20)
  assert.equal(budget.reserve('compaction', 20), true)
  assert.equal(budget.remainingMicroUsd(), 0)
})

test('unknown or missing usage retains the full reservation until known usage arrives', () => {
  const budget = new CampaignBudget(options)
  budget.reserve('request', 80)
  assert.equal(budget.remainingMicroUsd(), 20)
  assert.equal(budget.settle('request', 'unknown'), 'settled')
  assert.equal(budget.settle('request', 'unknown'), 'unchanged')
  assert.equal(budget.remainingMicroUsd(), 20)
  assert.equal(budget.settle('request', 35), 'settled')
  assert.equal(budget.remainingMicroUsd(), 65)
  assert.equal(budget.settle('request', 'unknown'), 'unchanged')
  assert.equal(budget.remainingMicroUsd(), 65)
})

test('duplicate admission never permits another start and settlement cannot refund twice', () => {
  const budget = new CampaignBudget(options)
  assert.equal(budget.reserve('request', 80), true)
  assert.equal(budget.reserve('request', 80), false)
  assert.throws(() => budget.reserve('request', 81), /reservation conflict/)
  budget.settle('request', 25)
  assert.equal(budget.settle('request', 25), 'unchanged')
  assert.equal(budget.reserve('request', 80), false)
  assert.equal(budget.remainingMicroUsd(), 75)
  assert.throws(() => budget.settle('request', 24), /settlement conflict/)
  assert.equal(budget.remainingMicroUsd(), 75)
  assert.throws(() => budget.settle('unreserved', 1), /reservation missing/)
})

test('actual cost above its bound remains recorded and closes further admission', () => {
  const budget = new CampaignBudget(options)
  budget.reserve('underestimated', 30)
  assert.equal(budget.settle('underestimated', 45), 'bound_exceeded')
  assert.equal(budget.remainingMicroUsd(), 55)
  assert.equal(budget.reserve('later', 1), false)
  assert.equal(budget.snapshot().operations[0]?.actualMicroUsd, 45)
  const restored = new CampaignBudget({ ...options, snapshot: budget.snapshot() })
  assert.equal(restored.reserve('after-resume', 1), false)
})

test('overspending is visible as a negative balance and cannot disappear on resume', () => {
  const budget = new CampaignBudget(options)
  budget.reserve('request', 100)
  budget.settle('request', 125)
  assert.equal(budget.remainingMicroUsd(), -25)
  const restored = new CampaignBudget({ ...options, snapshot: budget.snapshot() })
  assert.equal(restored.remainingMicroUsd(), -25)
  assert.equal(restored.reserve('later', 1), false)
})

test('snapshots retain outstanding and unknown charges and bind campaign and cap', () => {
  const budget = new CampaignBudget(options)
  budget.reserve('outstanding', 20)
  budget.reserve('unknown', 30)
  budget.settle('unknown', 'unknown')
  budget.reserve('known', 40)
  budget.settle('known', 5)
  const snapshot = budget.snapshot()
  const restored = new CampaignBudget({ ...options, snapshot })
  assert.equal(restored.remainingMicroUsd(), 45)
  assert.equal(restored.reserve('outstanding', 20), false)
  assert.throws(() => new CampaignBudget({ ...options, campaignId: 'other', snapshot }), /snapshot identity/)
  assert.throws(() => new CampaignBudget({ ...options, limitMicroUsd: 101, snapshot }), /snapshot identity/)
  assert.throws(() => new CampaignBudget({ ...options, snapshot: { ...snapshot, operations: [...snapshot.operations, snapshot.operations[0]!] } }), /duplicate operation/)
  assert.equal(Object.isFrozen(snapshot), true)
  assert.equal(Object.isFrozen(snapshot.operations), true)
  assert.equal(Object.isFrozen(snapshot.operations[0]), true)
})

test('recording failures prevent admission or refund while preserving prior charges', () => {
  let failRecording = true
  const recorded: CampaignBudgetSnapshot[] = []
  const budget = new CampaignBudget({ ...options, persist: snapshot => {
    if (failRecording) throw new Error('recording unavailable')
    recorded.push(snapshot)
    return undefined
  } })
  let starts = 0
  assert.throws(() => { if (budget.reserve('request', 80)) starts++ }, /recording unavailable/)
  assert.equal(starts, 0)
  assert.equal(budget.remainingMicroUsd(), 100)
  failRecording = false
  assert.equal(budget.reserve('request', 80), true)
  failRecording = true
  assert.throws(() => budget.settle('request', 10), /recording unavailable/)
  assert.equal(budget.remainingMicroUsd(), 20)
  assert.equal(recorded.length, 1)
  assert.equal(recorded[0]?.operations[0]?.actualMicroUsd, null)
})

test('recording callbacks cannot reenter mutation and overwrite a reservation', () => {
  let budget: CampaignBudget
  budget = new CampaignBudget({ ...options, persist: () => {
    assert.throws(() => budget.reserve('reentrant', 100), /mutation in progress/)
    return undefined
  } })
  assert.equal(budget.reserve('original', 70), true)
  assert.equal(budget.remainingMicroUsd(), 30)
})

test('amounts are integral safe micro-USD and invalid input never changes the ledger', () => {
  for (const amount of [NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => new CampaignBudget({ ...options, limitMicroUsd: amount }), /amount/)
    const budget = new CampaignBudget(options)
    assert.throws(() => budget.reserve('invalid', amount), /amount/)
    budget.reserve('valid', 10)
    assert.throws(() => budget.settle('valid', amount), /amount/)
    assert.equal(budget.remainingMicroUsd(), 90)
  }
  assert.throws(() => new CampaignBudget(options).reserve('zero', 0), /amount/)
  const zeroCap = new CampaignBudget({ ...options, limitMicroUsd: 0 })
  assert.equal(zeroCap.reserve('request', 1), false)
  assert.throws(() => new CampaignBudget({ ...options, campaignId: '' }), /identity/)
  assert.throws(() => new CampaignBudget(options).reserve('', 1), /identity/)
})

test('large safe integers cannot wrap the cap arithmetic into an admission', () => {
  const budget = new CampaignBudget({ ...options, limitMicroUsd: Number.MAX_SAFE_INTEGER })
  assert.equal(budget.reserve('large', Number.MAX_SAFE_INTEGER - 1), true)
  assert.equal(budget.reserve('too-large', 2), false)
  assert.equal(budget.reserve('last', 1), true)
  assert.equal(budget.remainingMicroUsd(), 0)
})

test('zero actual settlement is valid and restores through snapshots', () => {
  const budget = new CampaignBudget(options)
  assert.equal(budget.reserve('noop', 40), true)
  assert.equal(budget.settle('noop', 0), 'settled')
  assert.equal(budget.remainingMicroUsd(), 100)
  assert.equal(budget.settle('noop', 0), 'unchanged')
  const snapshot = budget.snapshot()
  assert.equal(snapshot.operations[0]?.actualMicroUsd, 0)
  const restored = new CampaignBudget({ ...options, snapshot })
  assert.equal(restored.remainingMicroUsd(), 100)
  assert.equal(restored.reserve('after-zero', 1), true)
})

test('snapshot import rejects non-boolean admissionClosed and admission drift', () => {
  const budget = new CampaignBudget(options)
  budget.reserve('underestimated', 30)
  budget.settle('underestimated', 45)
  const valid = budget.snapshot()
  assert.throws(
    () => new CampaignBudget({ ...options, snapshot: { ...valid, admissionClosed: 'yes' as unknown as boolean } }),
    /snapshot admission/,
  )
  assert.throws(
    () => new CampaignBudget({ ...options, snapshot: { ...valid, admissionClosed: false } }),
    /snapshot admission/,
  )
  const open = new CampaignBudget(options)
  open.reserve('held', 10)
  const openSnapshot = open.snapshot()
  assert.throws(
    () => new CampaignBudget({ ...options, snapshot: { ...openSnapshot, admissionClosed: true } }),
    /snapshot admission/,
  )
})

test('failed persistence of an over-bound settlement keeps admission closed', () => {
  let failSettleRecording = false
  const budget = new CampaignBudget({ ...options, persist: () => {
    if (failSettleRecording) throw new Error('recording unavailable')
  } })
  assert.equal(budget.reserve('underestimated', 30), true)
  failSettleRecording = true
  assert.throws(() => budget.settle('underestimated', 45), /recording unavailable/)
  assert.equal(budget.remainingMicroUsd(), 70)
  assert.equal(budget.snapshot().operations[0]?.actualMicroUsd, null)
  assert.equal(budget.reserve('must-not-admit', 1), false)
})
