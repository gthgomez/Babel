import assert from 'node:assert/strict'
import test from 'node:test'
import { CostTracker } from './costTracker.js'

const CC_MODEL = 'deepseek/deepseek-v4.1-flash'
const CC_PROVIDER = 'command-code'

test('Command Code registry estimate keeps allowance without billing actual label', () => {
  const tracker = new CostTracker()
  const attribution = { taskOwnerId: 'cc', chargeId: 'cc-est' }
  tracker.settleUsage(CC_MODEL, 1000, 2000, null, null, attribution, true, CC_PROVIDER)
  const summary = tracker.getTaskSummary('cc')
  assert.ok(Math.abs(summary.totalCostUSD - 0.0027) < 1e-12)
  assert.equal(summary.actualCostUSD, null)
  assert.equal(summary.costComplete, false)
  assert.equal(summary.estimateComplete, true)
  const receipt = tracker.getTaskChargeObservations('cc')[0]!
  assert.equal(receipt.costBasis, 'published_usage_estimate')
  assert.equal(receipt.costEstimate?.basis, 'published_usage_estimate')
})

test('registry-priced provider keeps measured-zero allowance as estimate', () => {
  const tracker = new CostTracker()
  const attribution = { taskOwnerId: 'cc', chargeId: 'cc-zero-est' }
  tracker.settleUsage(CC_MODEL, 0, 0, null, null, attribution, true, CC_PROVIDER)
  const summary = tracker.getTaskSummary('cc')
  assert.equal(summary.totalCostUSD, 0)
  assert.equal(summary.actualCostUSD, null)
  assert.equal(summary.unknownChargeCount, 0)
  const receipt = tracker.getTaskChargeObservations('cc')[0]!
  assert.equal(receipt.costBasis, 'published_usage_estimate')
  assert.ok(receipt.costEstimate)
})

test('late equal-value provider report against priced estimate is duplicate without provenance promotion', () => {
  const tracker = new CostTracker()
  const model = 'deepseek/deepseek-v4-flash-0731'
  const attribution = { taskOwnerId: 'or', chargeId: 'or-late' }
  tracker.settleUsage(model, 100, 10, null, null, attribution, true, 'openrouter')
  const before = tracker.getTaskChargeObservations('or')[0]!
  const allowance = tracker.getTaskSummary('or').totalCostUSD
  const late = tracker.settleUsage(model, 100, 10, null, null, attribution, true, 'openrouter', allowance)
  assert.equal(late.kind, 'duplicate')
  const after = tracker.getTaskChargeObservations('or')[0]!
  assert.equal(after.costBasis, 'published_usage_estimate')
  assert.equal(after.costEstimate?.basis, 'published_usage_estimate')
  assert.equal(after.reportedCostUSD, undefined)
  assert.equal(tracker.getTaskSummary('or').totalCostUSD, allowance)
  assert.equal(tracker.getTaskSummary('or').actualCostUSD, null)
})

test('late different-value provider report against priced estimate conflicts without mutation', () => {
  const tracker = new CostTracker()
  const model = 'deepseek/deepseek-v4-flash-0731'
  const attribution = { taskOwnerId: 'or', chargeId: 'or-late-diff' }
  tracker.settleUsage(model, 100, 10, null, null, attribution, true, 'openrouter')
  const allowance = tracker.getTaskSummary('or').totalCostUSD
  const late = tracker.settleUsage(model, 100, 10, null, null, attribution, true, 'openrouter', allowance + 0.01)
  assert.equal(late.kind, 'conflict')
  assert.equal(tracker.getTaskSummary('or').totalCostUSD, allowance)
  assert.equal(tracker.getTaskChargeObservations('or')[0]?.costBasis, 'published_usage_estimate')
})

test('confirmed reported zero cannot become a positive actual', () => {
  const tracker = new CostTracker()
  const attribution = { taskOwnerId: 'cc', chargeId: 'cc-zero-lock' }
  tracker.settleUsage(CC_MODEL, 0, 0, null, null, attribution, false, CC_PROVIDER, 0)
  assert.equal(
    tracker.settleUsage(CC_MODEL, 0, 0, null, null, attribution, false, CC_PROVIDER, 0.001).kind,
    'conflict',
  )
  assert.equal(tracker.getTaskSummary('cc').totalCostUSD, 0)
  assert.equal(tracker.getTaskChargeObservations('cc')[0]?.reportedCostUSD, 0)
})
