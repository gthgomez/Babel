import assert from 'node:assert/strict'
import test from 'node:test'
import { CostTracker } from './costTracker.js'

const NATIVE_DEEPSEEK = 'deepseek'

type ProviderRow = {
  provider: string
  label: string
  modelId: string
  inputTokens: number
  outputTokens: number
}

const PROVIDERS: ProviderRow[] = [
  { provider: NATIVE_DEEPSEEK, label: 'native DeepSeek', modelId: 'deepseek-v4.1-flash', inputTokens: 1000, outputTokens: 200 },
  { provider: 'openrouter', label: 'OpenRouter', modelId: 'deepseek/deepseek-v4-flash-0731', inputTokens: 100, outputTokens: 10 },
  { provider: 'deepinfra', label: 'DeepInfra', modelId: 'deepseek/deepseek-v4-flash-0731', inputTokens: 100, outputTokens: 10 },
  { provider: 'command-code', label: 'Command Code', modelId: 'deepseek/deepseek-v4.1-flash', inputTokens: 1000, outputTokens: 2000 },
  { provider: 'opencode-go', label: 'Go', modelId: 'deepseek-v4.1-flash', inputTokens: 1000, outputTokens: 200 },
]

for (const row of PROVIDERS) {
  test(`explicit zero-dollar report is authoritative for ${row.label}`, () => {
    const tracker = new CostTracker()
    const attribution = { taskOwnerId: row.provider, chargeId: `${row.provider}-zero` }
    tracker.settleUsage(row.modelId, 0, 0, null, null, attribution, false, row.provider, 0)
    const summary = tracker.getTaskSummary(row.provider)
    assert.equal(summary.totalCostUSD, 0)
    assert.equal(summary.unknownChargeCount, 0)
    const receipt = tracker.getTaskChargeObservations(row.provider)[0]!
    assert.equal(receipt.costBasis, 'provider_reported')
    assert.equal(receipt.usageKnown, false)
    assert.equal(receipt.usageComplete, false)
    assert.notEqual(receipt.usageComplete, true)
  })

  test(`explicit null report stays unresolved for ${row.label}`, () => {
    const tracker = new CostTracker()
    const attribution = { taskOwnerId: row.provider, chargeId: `${row.provider}-null` }
    tracker.settleUsage(row.modelId, 10, 5, null, null, attribution, true, row.provider, null)
    assert.equal(tracker.getTaskSummary(row.provider).unknownChargeCount, 1)
  })

  if (row.provider === 'openrouter' || row.provider === 'command-code' || row.provider === 'opencode-go') {
    test(`undefined report with known tokens uses registry estimate for ${row.label}`, () => {
      const tracker = new CostTracker()
      const attribution = { taskOwnerId: row.provider, chargeId: `${row.provider}-est` }
      tracker.settleUsage(row.modelId, row.inputTokens, row.outputTokens, null, null, attribution, true, row.provider)
      const summary = tracker.getTaskSummary(row.provider)
      const receipt = tracker.getTaskChargeObservations(row.provider)[0]!
      assert.equal(summary.unknownChargeCount, 0)
      assert.equal(receipt.costBasis, 'published_usage_estimate')
      assert.ok(receipt.costEstimate)
      assert.equal(summary.actualCostUSD, null)
      assert.ok(summary.totalCostUSD >= 0)
    })
  }
}

test('second confirmed actual rejects even when tokens match', () => {
  const tracker = new CostTracker()
  const attribution = { taskOwnerId: 'or', chargeId: 'or-twice' }
  const model = 'deepseek/deepseek-v4-flash-0731'
  tracker.settleUsage(model, 100, 10, null, null, attribution, true, 'openrouter', 0.01)
  assert.equal(
    tracker.settleUsage(model, 100, 10, null, null, attribution, true, 'openrouter', 0.02).kind,
    'conflict',
  )
})

test('later bill without tokens preserves measured usage on first provider report', () => {
  const tracker = new CostTracker()
  const attribution = { taskOwnerId: 'cc', chargeId: 'cc-bill-only' }
  tracker.recordUnknownCharge('deepseek/deepseek-v4.1-flash', attribution)
  tracker.settleUsage('deepseek/deepseek-v4.1-flash', 1000, 2000, 40, 60, attribution, true, 'command-code', 0.01)
  tracker.settleUsage('deepseek/deepseek-v4.1-flash', 0, 0, null, null, attribution, false, 'command-code', 0.01)
  const receipt = tracker.getTaskChargeObservations('cc')[0]!
  assert.equal(receipt.inputTokens, 1000)
  assert.equal(receipt.outputTokens, 2000)
  assert.equal(receipt.cacheHitTokens, 40)
  assert.equal(receipt.cacheMissTokens, 60)
  assert.equal(receipt.knownCostUSD, 0.01)
  assert.equal(receipt.usageKnown, true)
})

test('receipt view does not treat deferred estimate-to-reported replacement as coverage', () => {
  const tracker = new CostTracker()
  const attribution = { taskOwnerId: 'or', chargeId: 'or-cover' }
  const model = 'deepseek/deepseek-v4-flash-0731'
  tracker.settleUsage(model, 100, 10, null, null, attribution, true, 'openrouter')
  const prior = tracker.getSessionChargeObservations()
  const allowance = tracker.getTaskSummary('or').totalCostUSD
  assert.equal(
    tracker.settleUsage(model, 100, 10, null, null, attribution, true, 'openrouter', allowance).kind,
    'duplicate',
  )
  const current = tracker.getSessionChargeObservations()
  const covers = (tracker as unknown as {
    receiptViewCovers: (a: typeof prior, b: typeof current) => boolean
  }).receiptViewCovers.bind(tracker)
  assert.equal(covers(prior, current), true)
  assert.equal(current[0]?.costBasis, 'published_usage_estimate')
})

test('restore checkpoints reconcile null-to-priced owner receipt over stale session', () => {
  const original = new CostTracker()
  const attribution = { taskOwnerId: 'A', chargeId: 'restore-priced' }
  const model = 'deepseek-v4-flash'
  original.recordUnknownCharge(model, attribution)
  const staleSession = {
    ...original.getSessionSummary(),
    accountedChargeIds: original.getSessionChargeIds(),
    chargeObservations: original.getSessionChargeObservations(),
  }
  original.settleUsage(model, 500, 50, null, null, attribution, true, undefined, 0.02)
  const latestOwner = {
    totalCostUSD: original.getTaskSummary('A').totalCostUSD,
    unknownChargeCount: 0,
    chargeIds: original.getTaskChargeIds('A'),
    chargeObservations: original.getTaskChargeObservations('A'),
  }
  const resumed = new CostTracker()
  resumed.restoreSessionCost(staleSession)
  resumed.restoreTaskUsage('A', latestOwner)
  assert.equal(resumed.getSessionSummary().unknownChargeCount, 0)
  assert.equal(resumed.getTaskSummary('A').totalCostUSD, 0.02)
  assert.equal(resumed.settleUsage(model, 500, 50, null, null, attribution, true, undefined, 0.02).kind, 'duplicate')
})

test('restore checkpoints prefer newer session receipt over stale pending owner', () => {
  const original = new CostTracker()
  const attribution = { taskOwnerId: 'A', chargeId: 'restore-order' }
  const model = 'deepseek-v4-flash'
  original.recordUnknownCharge(model, attribution)
  const staleOwner = {
    totalCostUSD: 0,
    unknownChargeCount: 1,
    chargeIds: original.getTaskChargeIds('A'),
    chargeObservations: original.getTaskChargeObservations('A'),
  }
  original.settleUsage(model, 200, 20, null, null, attribution, true, undefined, 0.005)
  const resumed = new CostTracker()
  resumed.restoreSessionCost({
    ...original.getSessionSummary(),
    accountedChargeIds: original.getSessionChargeIds(),
    chargeObservations: original.getSessionChargeObservations(),
  })
  resumed.restoreTaskUsage('A', staleOwner)
  assert.equal(resumed.getTaskSummary('A').totalCostUSD, 0.005)
  assert.equal(resumed.getTaskSummary('A').unknownChargeCount, 0)
})
