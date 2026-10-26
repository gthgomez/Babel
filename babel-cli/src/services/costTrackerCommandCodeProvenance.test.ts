import assert from 'node:assert/strict'
import test from 'node:test'
import { CostTracker } from './costTracker.js'

const CC_MODEL = 'deepseek/deepseek-v4.1-flash'
const CC_PROVIDER = 'command-code'

test('Command Code registry estimate is allowance with estimateComplete and separate reported subtotal', () => {
  const tracker = new CostTracker()
  const attribution = { taskOwnerId: 'cc', chargeId: 'cc-1' }
  tracker.settleUsage(CC_MODEL, 1000, 2000, null, null, attribution, true, CC_PROVIDER)
  const summary = tracker.getTaskSummary('cc')
  assert.ok(Math.abs(summary.totalCostUSD - 0.0027) < 1e-12)
  assert.equal(summary.costComplete, false)
  assert.equal(summary.estimateComplete, true)
  assert.equal(summary.completeCostUSD, null)
  assert.equal(summary.knownCostUSD, 0)
  assert.ok(Math.abs((summary.estimatedCostUSD ?? 0) - 0.0027) < 1e-12)
  const receipt = tracker.getTaskChargeObservations('cc')[0]!
  assert.equal(receipt.knownCostUSD, null)
  assert.ok(Math.abs(receipt.estimatedCostUSD! - 0.0027) < 1e-12)
  assert.equal(receipt.costEstimate?.basis, 'published_usage_estimate')
  assert.equal(receipt.reportedCostUSD, undefined)
})

test('estimate then provider_reported refinement applies signed estimate-to-actual allowance delta once', () => {
  const tracker = new CostTracker()
  const attribution = { taskOwnerId: 'cc', chargeId: 'cc-refine' }
  assert.equal(
    tracker.settleUsage(CC_MODEL, 1000, 2000, null, null, attribution, true, CC_PROVIDER).kind,
    'inserted',
  )
  const estimateAllowance = tracker.getTaskSummary('cc').totalCostUSD
  const refine = tracker.settleUsage(
    CC_MODEL, 1000, 2000, null, null, attribution, true, CC_PROVIDER, 0.0025,
  )
  assert.equal(refine.kind, 'refined')
  assert.ok(Math.abs(refine.knownCostDelta - (0.0025 - estimateAllowance)) < 1e-12)
  const summary = tracker.getTaskSummary('cc')
  assert.equal(summary.totalCostUSD, 0.0025)
  assert.equal(summary.reportedCostUSD, 0.0025)
  assert.equal(summary.costComplete, true)
  const receipt = tracker.getTaskChargeObservations('cc')[0]!
  assert.equal(receipt.reportedCostBasis, 'provider_reported')
  assert.equal(receipt.reportedCostUSD, 0.0025)
  assert.equal(receipt.costBasis, 'provider_reported')
  assert.equal(receipt.knownCostUSD, 0.0025)
  assert.equal(receipt.costEstimate, undefined)
  assert.equal(
    tracker.settleUsage(CC_MODEL, 1000, 2000, null, null, attribution, true, CC_PROVIDER, 0.003).kind,
    'conflict',
  )
})

test('explicit provider_reported zero without tokens is priced allowance on Command Code', () => {
  const tracker = new CostTracker()
  const attribution = { taskOwnerId: 'cc', chargeId: 'cc-zero' }
  tracker.settleUsage(CC_MODEL, 0, 0, null, null, attribution, false, CC_PROVIDER, 0)
  const summary = tracker.getTaskSummary('cc')
  assert.equal(summary.totalCostUSD, 0)
  assert.equal(summary.unknownChargeCount, 0)
  assert.equal(summary.reportedCostUSD, 0)
  const receipt = tracker.getTaskChargeObservations('cc')[0]!
  assert.equal(receipt.usageComplete, false)
  assert.equal(receipt.reportedCostUSD, 0)
})

test('positive explicit report without usageKnown replaces zero-dollar report once', () => {
  const tracker = new CostTracker()
  const attribution = { taskOwnerId: 'cc', chargeId: 'cc-dollars' }
  tracker.settleUsage(CC_MODEL, 0, 0, null, null, attribution, false, CC_PROVIDER, 0)
  tracker.settleUsage(CC_MODEL, 0, 0, null, null, attribution, false, CC_PROVIDER, 0.001)
  const summary = tracker.getTaskSummary('cc')
  assert.equal(summary.reportedCostUSD, 0.001)
  assert.equal(summary.totalCostUSD, 0.001)
  assert.equal(summary.unknownChargeCount, 0)
})

test('malformed reported cost stays unresolved and does not invent a free allowance', () => {
  const tracker = new CostTracker()
  const attribution = { taskOwnerId: 'cc', chargeId: 'cc-bad' }
  tracker.settleUsage(CC_MODEL, 100, 10, null, null, attribution, true, CC_PROVIDER, Number.NaN)
  const summary = tracker.getTaskSummary('cc')
  assert.equal(summary.unknownChargeCount, 1)
  assert.equal(summary.totalCostUSD, 0)
  assert.equal(tracker.getTaskChargeObservations('cc')[0]?.reportedCostUSD, undefined)
})

test('cold restore subtracts owned estimate receipts without double counting session residual', () => {
  const tracker = new CostTracker()
  tracker.settleUsage(CC_MODEL, 1000, 2000, null, null,
    { taskOwnerId: 'cc', chargeId: 'owned' }, true, CC_PROVIDER)
  tracker.trackUsage(CC_MODEL, 500, 100, null, null, undefined, true, CC_PROVIDER)
  const summary = tracker.getSessionSummary()
  const receipts = tracker.getTaskChargeObservations('cc')
  const resumed = new CostTracker()
  resumed.restoreSessionCost({
    ...summary,
    accountedChargeIds: tracker.getSessionChargeIds(),
    chargeObservations: tracker.getSessionChargeObservations(),
  })
  resumed.restoreTaskUsage('cc', {
    totalCostUSD: tracker.getTaskSummary('cc').totalCostUSD,
    chargeIds: ['owned'],
    unknownChargeCount: 0,
    chargeObservations: receipts,
  })
  const restored = resumed.getSessionSummary()
  assert.equal(restored.totalCostUSD, summary.totalCostUSD)
  assert.equal(restored.estimatedCostUSD, summary.estimatedCostUSD)
  assert.equal(restored.costComplete, false)
})
