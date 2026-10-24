/**
 * Offline regression for the historical run stop (chat-3ae78bda3098, 2026-10-23).
 *
 * Observed chain: one successful OpenRouter dispatch reported usage; the old
 * executable's metadata adapter omitted `usage.cost`, the model had no static
 * pricing row, and the accounting gate refused the second paid dispatch under
 * a finite dollar cap. This suite freezes the complete boundary: a reported
 * charge permits continuation and stays authoritative; a missing or invalid
 * charge stays unknown with the typed accounting reason and never projects a
 * zero bill.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CostTracker } from '../services/costTracker.js'
import type { UsageAttribution } from '../services/costTracker.js'
import { buildInvocationMetadata } from '../runners/providerResponseMetadata.js'

const UNPRICED_MODEL = 'deepseek/deepseek-v4.1-flash'
const CAP_USD = 2

function attributionFor(chargeId: string): UsageAttribution {
  return { taskOwnerId: 'task-accounting-continuation', chargeId }
}

/** Reproduce the engine's pre-dispatch accounting check (chatEngine.checkBudgets). */
function paidDispatchAllowed(tracker: CostTracker): boolean {
  const summary = tracker.getTaskSummary('task-accounting-continuation')
  return !(Number.isFinite(CAP_USD) && (summary.estimateComplete ?? summary.costComplete) === false)
}

test('reported charge 0.007 permits continuation to the second model dispatch', () => {
  const tracker = new CostTracker()
  const metadata = buildInvocationMetadata('openrouter', UNPRICED_MODEL, 6554,
    { prompt_tokens: 6554, completion_tokens: 303, total_tokens: 6857, cost: 0.007 })
  assert.equal(metadata.estimated_cost_usd, 0.007)
  assert.equal(metadata.cost_precision, 'exact')

  const firstCharge = tracker.trackUsage(UNPRICED_MODEL, 6554, 303, 0, 6554,
    attributionFor('charge-first-dispatch'), true, 'openrouter', metadata.estimated_cost_usd)
  assert.equal(firstCharge, 0.007)

  const afterFirst = tracker.getTaskSummary('task-accounting-continuation')
  assert.equal(afterFirst.totalCostUSD, 0.007)
  assert.equal(afterFirst.costComplete, true)
  assert.equal(afterFirst.unknownChargeCount ?? 0, 0)
  assert.equal(paidDispatchAllowed(tracker), true)

  const secondCharge = tracker.trackUsage(UNPRICED_MODEL, 100, 20, 0, 100,
    attributionFor('charge-second-dispatch'), true, 'openrouter', 0.002)
  assert.equal(secondCharge, 0.002)
  const afterSecond = tracker.getTaskSummary('task-accounting-continuation')
  assert.ok(Math.abs(afterSecond.totalCostUSD - 0.009) < 1e-9)
  assert.equal(afterSecond.costComplete, true)
  assert.equal(paidDispatchAllowed(tracker), true)
})

test('missing reported charge on an unpriced model stays unknown and refuses paid dispatch', () => {
  const tracker = new CostTracker()
  const metadata = buildInvocationMetadata('openrouter', UNPRICED_MODEL, 1,
    { prompt_tokens: 6554, completion_tokens: 303, total_tokens: 6857 })
  assert.equal(metadata.estimated_cost_usd, null)
  assert.equal(metadata.cost_precision, 'unknown')

  tracker.trackUsage(UNPRICED_MODEL, 6554, 303, 0, 6554,
    attributionFor('charge-unknown-cost'), true, 'openrouter', metadata.estimated_cost_usd)
  const summary = tracker.getTaskSummary('task-accounting-continuation')
  assert.equal(summary.costComplete, false)
  assert.equal(summary.completeCostUSD, null)
  assert.equal(summary.totalCostUSD, 0)
  assert.equal(summary.unknownChargeCount ?? 0, 1)
  assert.equal(paidDispatchAllowed(tracker), false)
})

test('invalid reported charge cannot downgrade an unknown bill to zero or a known amount', () => {
  const tracker = new CostTracker()
  for (const invalid of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const metadata = buildInvocationMetadata('openrouter', UNPRICED_MODEL, 1,
      { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: invalid })
    assert.equal(metadata.estimated_cost_usd, null)
    assert.equal(metadata.cost_precision, 'unknown')
    tracker.trackUsage(UNPRICED_MODEL, 10, 5, 0, 10,
      attributionFor(`charge-invalid-${String(invalid)}`), true, 'openrouter',
      metadata.estimated_cost_usd)
  }
  const summary = tracker.getTaskSummary('task-accounting-continuation')
  assert.equal(summary.costComplete, false)
  assert.equal(summary.completeCostUSD, null)
  assert.equal(summary.totalCostUSD, 0)
  assert.equal((summary.unknownChargeCount ?? 0) >= 1, true)
  assert.equal(paidDispatchAllowed(tracker), false)
})

test('a priced model cannot be silently re-billed through the reported-cost channel', () => {
  const tracker = new CostTracker()
  // Registry-pinned cost wins; a differing provider report is not blended in.
  const first = tracker.trackUsage('z-ai/glm-5.3-flash', 10, 5, 0, 10,
    attributionFor('charge-priced-model'), true, 'openrouter', 999)
  assert.notEqual(first, 999)
  assert.equal(tracker.getTaskSummary('task-accounting-continuation').costComplete, true)
})
