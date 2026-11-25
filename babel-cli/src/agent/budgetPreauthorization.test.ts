import assert from 'node:assert/strict'
import test from 'node:test'

import {
  checkCostPreauthorization,
  checkCostWallBudgets,
  estimateRequestCostUsd,
  formatBudgetUsd,
} from './chatEngineCriticBudget.js'

test('tiny nonzero dollar amounts are never rendered as zero', () => {
  assert.equal(formatBudgetUsd(0.004), '$0.004')
  assert.equal(formatBudgetUsd(0.001), '$0.001')
  assert.equal(formatBudgetUsd(1.5), '$1.50')
  assert.notEqual(formatBudgetUsd(0.0000004), '$0.00')
  assert.match(formatBudgetUsd(0.0000004), /e-7/)
  assert.equal(formatBudgetUsd(0), '$0.00')
  assert.equal(formatBudgetUsd(Infinity), 'unlimited')
})

test('a request estimate requires known pricing on both sides', () => {
  assert.equal(estimateRequestCostUsd({ inputTokens: 1000, outputTokens: 1000, inputCostPer1M: 0.28, outputCostPer1M: 0.42 }), 0.0007)
  assert.equal(estimateRequestCostUsd({ inputTokens: 1000, outputTokens: 1000, inputCostPer1M: undefined, outputCostPer1M: 0.42 }), undefined)
  assert.equal(estimateRequestCostUsd({ inputTokens: 1000, outputTokens: 1000, inputCostPer1M: Number.NaN, outputCostPer1M: 0.42 }), undefined)
})

test('a tiny enabled cap is denied before the physical request', () => {
  const estimate = estimateRequestCostUsd({ inputTokens: 2000, outputTokens: 8000, inputCostPer1M: 0.28, outputCostPer1M: 0.42 })
  assert.equal(typeof estimate, 'number')
  const decision = checkCostPreauthorization({ totalCostUsd: 0, maxCostUsd: 0.001, ...(estimate !== undefined ? { estimatedNextRequestCostUsd: estimate } : {}) })
  assert.equal(decision.ok, false)
  assert.match(decision.reason ?? '', /preauthorization denied/)
  assert.match(decision.reason ?? '', /\$0\.001/)
  assert.doesNotMatch(decision.reason ?? '', /of \$0\.00 /)
})

test('a cap that covers the estimate dispatches, and unlimited is unaffected', () => {
  const decision = checkCostWallBudgets({
    totalCostUsd: 0,
    maxCostUsd: 1,
    sessionStartTime: 0,
    maxWallMs: Infinity,
    estimatedNextRequestCostUsd: 0.004,
  })
  assert.equal(decision.ok, true)
  const unlimited = checkCostWallBudgets({
    totalCostUsd: 10,
    maxCostUsd: Infinity,
    sessionStartTime: 0,
    maxWallMs: Infinity,
    estimatedNextRequestCostUsd: 0.004,
  })
  assert.equal(unlimited.ok, true)
})

test('wall limits retain their existing behavior when cost preauthorization is supplied', () => {
  const wall = checkCostWallBudgets({
    totalCostUsd: 0,
    maxCostUsd: 1,
    sessionStartTime: Date.now() - 10_000,
    maxWallMs: 5_000,
    estimatedNextRequestCostUsd: 0.001,
  })
  assert.equal(wall.ok, false)
  assert.equal(wall.limiter, 'wall')
})

test('a finite remote cap with unknown pricing refuses dispatch without treating known zero as unknown', () => {
  const limits = { totalCostUsd: 0, maxCostUsd: 1, sessionStartTime: 0, maxWallMs: Infinity }
  const unknown = checkCostWallBudgets({ ...limits, estimatedNextRequestCostUsd: null })
  assert.equal(unknown.ok, false)
  assert.equal(unknown.limiter, 'cost')
  assert.match(unknown.reason ?? '', /cannot preauthorize/i)
  assert.equal(checkCostWallBudgets({ ...limits, estimatedNextRequestCostUsd: 0 }).ok, true)
  assert.equal(checkCostWallBudgets(limits).ok, true)
  assert.equal(checkCostWallBudgets({ ...limits, maxCostUsd: Infinity, estimatedNextRequestCostUsd: null }).ok, true)
})
