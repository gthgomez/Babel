import assert from 'node:assert/strict'
import test from 'node:test'

import { globalCostTracker } from '../services/costTracker.js'
import { BabelRepl } from './BabelRepl.js'
import type { ReplContext } from './context.js'
import { restoreSessionState, updateCostTotals } from './session.js'
import type { SessionState } from './types.js'

function makeReplContext(): ReplContext {
  const ctx = Object.create(BabelRepl.prototype) as ReplContext
  ctx.state = {
    mode: 'chat',
    router: 'v9',
    costTotals: {
      totalCostUSD: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalTokens: 0,
    },
    turnCount: 0,
  }
  ctx.turnCounter = 0
  ctx.lastAssistantAnswer = null
  ctx.lastResolvedTask = null
  ctx.lastRunDir = null
  return ctx
}

test('updateCostTotals forwards modelBreakdown and cache totals from session summary', (t) => {
  const modelBreakdown = {
    'deepseek-v4-flash': {
      inputTokens: 100,
      outputTokens: 20,
      costUSD: 0,
      unknownChargeCount: 1,
      completeCostUSD: null,
      promptCacheHitTokens: 40,
      promptCacheMissTokens: 60,
    },
  }
  const summary = {
    totalCostUSD: 0,
    knownCostUSD: 0,
    estimatedCostUSD: 0.000168,
    completeCostUSD: null,
    costComplete: false,
    unknownChargeCount: 1,
    totalInputTokens: 100,
    totalOutputTokens: 20,
    totalTokens: 120,
    totalCacheHitTokens: 40,
    totalCacheMissTokens: 60,
    modelBreakdown,
  }
  t.mock.method(globalCostTracker, 'getSessionSummary', () => summary)
  t.mock.method(globalCostTracker, 'getProjectSessionId', () => 'sess-1')
  t.mock.method(globalCostTracker, 'isSessionProjectionComplete', () => true)
  t.mock.method(globalCostTracker, 'getSessionChargeIds', () => ['charge-1'])
  t.mock.method(globalCostTracker, 'getSessionChargeObservations', () => [])

  const ctx = makeReplContext()
  updateCostTotals(ctx)
  assert.deepEqual(ctx.state.costTotals.modelBreakdown, modelBreakdown)
  assert.equal(ctx.state.costTotals.totalCacheHitTokens, 40)
  assert.equal(ctx.state.costTotals.totalCacheMissTokens, 60)
  assert.equal(ctx.state.costTotals.costComplete, false)
})

test('cold restore round-trips modelBreakdown into restoreSessionCost payload', (t) => {
  const modelBreakdown = {
    'deepseek-v4-flash': {
      inputTokens: 50,
      outputTokens: 5,
      costUSD: 0.0000252,
      unknownChargeCount: 0,
      estimatedCostUSD: 0.0000252,
      completeCostUSD: null,
      promptCacheHitTokens: 10,
      promptCacheMissTokens: 0,
    },
  }
  const saved: SessionState = {
    mode: 'chat',
    router: 'v9',
    turnCount: 3,
    costTotals: {
      totalCostUSD: 0.0000252,
      knownCostUSD: 0,
      estimatedCostUSD: 0.0000252,
      completeCostUSD: null,
      costComplete: false,
      unknownChargeCount: 0,
      totalInputTokens: 50,
      totalOutputTokens: 5,
      totalTokens: 55,
      totalCacheHitTokens: 10,
      totalCacheMissTokens: 0,
      modelBreakdown,
      accountedChargeIds: ['priced-1'],
      chargeObservations: [],
    },
  }
  const restoredPayloads: unknown[] = []
  t.mock.method(globalCostTracker, 'restoreSessionCost', (totals: unknown) => {
    restoredPayloads.push(totals)
  })
  t.mock.method(globalCostTracker, 'getSessionSummary', () => ({
    totalCostUSD: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalTokens: 0,
    modelBreakdown: {},
    completeCostUSD: null,
    costComplete: false,
  }))
  t.mock.method(console, 'log', () => undefined)

  const ctx = makeReplContext()
  const roundTrip = JSON.parse(JSON.stringify(saved)) as SessionState
  restoreSessionState(ctx, roundTrip)

  assert.deepEqual(ctx.state.costTotals.modelBreakdown, modelBreakdown)
  assert.equal(ctx.state.costTotals.totalCacheHitTokens, 10)
  assert.deepEqual(
    (restoredPayloads[0] as { modelBreakdown?: typeof modelBreakdown }).modelBreakdown,
    modelBreakdown,
  )
})

test('legacy snapshots without modelBreakdown stay conservatively incomplete', (t) => {
  const legacy: SessionState = {
    mode: 'chat',
    router: 'v9',
    turnCount: 1,
    costTotals: {
      totalCostUSD: 0.01,
      totalInputTokens: 100,
      totalOutputTokens: 10,
      totalTokens: 110,
      completeCostUSD: null,
      unknownChargeCount: 0,
    },
  }
  t.mock.method(globalCostTracker, 'restoreSessionCost', () => undefined)
  t.mock.method(globalCostTracker, 'getSessionSummary', () => ({
    totalCostUSD: 0.01,
    totalInputTokens: 100,
    totalOutputTokens: 10,
    totalTokens: 110,
    modelBreakdown: { __restored__: { inputTokens: 100, outputTokens: 10, costUSD: 0.01 } },
    completeCostUSD: null,
    costComplete: false,
  }))
  t.mock.method(console, 'log', () => undefined)

  const ctx = makeReplContext()
  restoreSessionState(ctx, legacy)
  assert.equal(ctx.state.costTotals.modelBreakdown, undefined)
  assert.equal(ctx.state.costTotals.completeCostUSD, null)
})
