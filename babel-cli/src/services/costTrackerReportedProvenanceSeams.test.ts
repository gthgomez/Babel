import assert from 'node:assert/strict'
import test, { after, before } from 'node:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CostTracker } from './costTracker.js'
import { resetGlobalTokenHistoryDb } from './tokenHistoryDb.js'

let historyRoot = ''
let priorHistoryPath: string | undefined
before(() => {
  priorHistoryPath = process.env['BABEL_TOKEN_DB_PATH']
  historyRoot = mkdtempSync(join(tmpdir(), 'babel-actual-billing-fixture-'))
  resetGlobalTokenHistoryDb()
  process.env['BABEL_TOKEN_DB_PATH'] = join(historyRoot, 'history.db')
})
after(() => {
  resetGlobalTokenHistoryDb()
  if (priorHistoryPath === undefined) delete process.env['BABEL_TOKEN_DB_PATH']
  else process.env['BABEL_TOKEN_DB_PATH'] = priorHistoryPath
  rmSync(historyRoot, { recursive: true, force: true })
})
import { settlementReportedCostUsd } from './settlementReportedCost.js'
import { formatUsageCost } from '../cli/usageCost.js'
import type { RunnerInvocationMetadata } from '../runners/base.js'

const CC_MODEL = 'deepseek/deepseek-v4.1-flash'
const CC_PROVIDER = 'command-code'

test('valid explicit reported dollars apply without usageKnown (OpenRouter)', () => {
  const tracker = new CostTracker()
  const attribution = { taskOwnerId: 'or', chargeId: 'or-1' }
  tracker.settleUsage('deepseek/deepseek-v4-flash', 0, 0, null, null, attribution, false, 'openrouter', 0.004)
  const summary = tracker.getTaskSummary('or')
  assert.equal(summary.totalCostUSD, 0.004)
  assert.equal(summary.unknownChargeCount, 0)
  const receipt = tracker.getTaskChargeObservations('or')[0]!
  assert.equal(receipt.costBasis, 'provider_reported')
  assert.equal(receipt.usageComplete, false)
})

test('registry estimate applies only when usageKnown and report undefined', () => {
  const tracker = new CostTracker()
  const model = 'deepseek/deepseek-v4-flash-0731'
  const attribution = { taskOwnerId: 'or', chargeId: 'or-est' }
  tracker.settleUsage(model, 100, 10, null, null, attribution, true, 'openrouter')
  assert.ok(tracker.getTaskSummary('or').totalCostUSD > 0)
  assert.equal(
    tracker.settleUsage(model, 100, 10, null, null, attribution, true, 'openrouter', 0.01).kind,
    'conflict',
  )
  assert.ok(tracker.getTaskSummary('or').totalCostUSD > 0)
})

test('null or malformed explicit report stays unknown (not free)', () => {
  const tracker = new CostTracker()
  const attribution = { taskOwnerId: 'cc', chargeId: 'bad' }
  tracker.settleUsage(CC_MODEL, 100, 10, null, null, attribution, true, CC_PROVIDER, null)
  assert.equal(tracker.getTaskSummary('cc').unknownChargeCount, 1)
  assert.equal(tracker.getTaskSummary('cc').totalCostUSD, 0)
  assert.equal(tracker.settleUsage(CC_MODEL, 100, 10, null, null, attribution, true, CC_PROVIDER, Number.NaN).kind, 'duplicate')
  assert.equal(tracker.getTaskSummary('cc').unknownChargeCount, 1)
  assert.equal(tracker.getTaskSummary('cc').totalCostUSD, 0)
  assert.equal(tracker.getTaskChargeObservations('cc')[0]?.reportedCostUSD, undefined)
})

test('settlementReportedCostUsd preserves null versus undefined boundary', () => {
  const meta = (overrides: Partial<RunnerInvocationMetadata>): RunnerInvocationMetadata => ({
    provider: 'openrouter',
    provider_model_id: 'm',
    latency_ms: 0,
    prompt_tokens: null,
    completion_tokens: null,
    total_tokens: null,
    estimated_cost_usd: 0.01,
    ...overrides,
  })
  assert.equal(settlementReportedCostUsd(meta({ provider_reported_total_charge_usd: 0.002 })), 0.002)
  assert.equal(settlementReportedCostUsd(meta({ provider_reported_total_charge_usd: null })), null)
  assert.equal(settlementReportedCostUsd(meta({})), undefined)
})

test('estimate-only projection keeps allowance total with knownCostUSD 0 and estimateComplete true', () => {
  const tracker = new CostTracker()
  tracker.settleUsage(CC_MODEL, 1000, 2000, null, null, { taskOwnerId: 'cc', chargeId: 'e' }, true, CC_PROVIDER)
  const summary = tracker.getTaskSummary('cc')
  assert.ok(Math.abs(summary.totalCostUSD - 0.0027) < 1e-12)
  assert.equal(summary.knownCostUSD, 0)
  assert.equal(summary.completeCostUSD, null)
  assert.equal(summary.costComplete, false)
  assert.equal(summary.estimateComplete, true)
  assert.equal(tracker.getTaskChargeObservations('cc')[0]?.costBasis, 'published_usage_estimate')
})

test('all-reported OpenRouter charges keep estimateComplete and costComplete true', () => {
  const tracker = new CostTracker()
  const model = 'deepseek/deepseek-v4-flash-0731'
  const attribution = { taskOwnerId: 'or', chargeId: 'or-all' }
  tracker.settleUsage(model, 100, 10, null, null, attribution, true, 'openrouter', 0.01)
  const summary = tracker.getTaskSummary('or')
  assert.equal(summary.totalCostUSD, 0.01)
  assert.equal(summary.unknownChargeCount, 0)
  assert.equal(summary.estimateComplete, true)
  assert.equal(summary.costComplete, true)
  assert.equal(summary.completeCostUSD, 0.01)
  assert.equal(summary.knownCostUSD, 0.01)
  assert.equal(tracker.getTaskChargeObservations('or')[0]?.costBasis, 'provider_reported')
})

test('OpenRouter explicit zero report without tokens is authoritative', () => {
  const tracker = new CostTracker()
  const attribution = { taskOwnerId: 'or', chargeId: 'or-zero' }
  tracker.settleUsage('deepseek/deepseek-v4-flash', 0, 0, null, null, attribution, false, 'openrouter', 0)
  const summary = tracker.getTaskSummary('or')
  assert.equal(summary.totalCostUSD, 0)
  assert.equal(summary.unknownChargeCount, 0)
  assert.equal(summary.costComplete, true)
  assert.equal(summary.usageComplete, false)
})

test('all-reported task preserves actualCostUSD in summaries, project stats, and sqlite history', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-all-reported-actual-'))
  try {
    const tracker = new CostTracker(root)
    const model = 'deepseek/deepseek-v4-flash-0731'
    const attribution = { taskOwnerId: 'or', chargeId: 'or-invoice', projectRoot: root, projectRootVersion: 1 as const }
    tracker.settleUsage(model, 100, 10, null, null, attribution, true, 'openrouter', 0.01)
    const task = tracker.getTaskSummary('or')
    assert.equal(task.actualCostUSD, 0.01)
    assert.equal(task.reportedCostUSD, 0.01)
    assert.equal(task.costComplete, true)
    assert.equal(task.unknownChargeCount, 0)
    const session = tracker.getSessionSummary()
    assert.equal(session.actualCostUSD, 0.01)
    tracker.saveToProjectStats(tracker.getProjectSessionId(), undefined, root)
    const stats = JSON.parse(readFileSync(join(root, 'project_stats.json'), 'utf8'))
    assert.equal(stats.actualCostUSD, 0.01)
    assert.equal(tracker.getProjectHistoricalCost(root), 0.01)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('registry estimate keeps billing actual unknown until provider report settles', () => {
  const tracker = new CostTracker()
  const model = 'deepseek/deepseek-v4-flash-0731'
  const attribution = { taskOwnerId: 'or', chargeId: 'or-est-only' }
  tracker.settleUsage(model, 100, 10, null, null, attribution, true, 'openrouter')
  const summary = tracker.getTaskSummary('or')
  assert.equal(summary.actualCostUSD, null)
  assert.ok((summary.estimatedCostUSD ?? 0) > 0)
  assert.equal(summary.costComplete, false)
})

test('registry estimate rejects late provider report replacement', () => {
  const tracker = new CostTracker()
  const model = 'deepseek/deepseek-v4-flash-0731'
  const attribution = { taskOwnerId: 'or', chargeId: 'or-refine' }
  tracker.settleUsage(model, 100, 10, null, null, attribution, true, 'openrouter')
  const before = tracker.getTaskSummary('or').totalCostUSD
  assert.ok(before > 0 && before < 0.01)
  assert.equal(
    tracker.settleUsage(model, 100, 10, null, null, attribution, true, 'openrouter', 0.01).kind,
    'conflict',
  )
  assert.equal(tracker.getTaskSummary('or').totalCostUSD, before)
  assert.equal(tracker.getTaskChargeObservations('or')[0]?.costBasis, 'published_usage_estimate')
})

test('formatUsageCost labels explicit zero-dollar provider reports', () => {
  const labeled = formatUsageCost({
    totalCostUSD: 0,
    knownCostUSD: 0,
    reportedCostUSD: 0,
    unknownChargeCount: 0,
    costComplete: true,
    completeCostUSD: 0,
  })
  assert.match(labeled, /provider-reported/)
  assert.match(labeled, /\$0\.000000 provider-reported/)
})

test('formatUsageCost does not mark incomplete for estimateComplete or reported subtotal alone', () => {
  const labeled = formatUsageCost({
    totalCostUSD: 0.01,
    knownCostUSD: 0.01,
    estimatedCostUSD: 0.0027,
    reportedCostUSD: 0.0025,
    unknownChargeCount: 0,
    costComplete: true,
    completeCostUSD: 0.01,
    estimateComplete: true,
  })
  assert.match(labeled, /usage estimate/)
  assert.match(labeled, /provider-reported/)
  assert.doesNotMatch(labeled, /cost incomplete/)
})

test('legacy Go receipt without costBasis still projects as estimate allowance', () => {
  const legacy = new CostTracker()
  legacy.restoreTaskUsage('legacy', {
    totalCostUSD: 0.1,
    unknownChargeCount: 0,
    chargeIds: ['old'],
    chargeObservations: [{
      attribution: { taskOwnerId: 'legacy', chargeId: 'old' },
      provider: 'opencode-go',
      modelId: 'deepseek-v4.1-flash',
      inputTokens: 100,
      outputTokens: 10,
      cacheHitTokens: 0,
      cacheMissTokens: 0,
      knownCostUSD: 0.1,
    }],
  })
  const summary = legacy.getTaskSummary('legacy')
  assert.equal(summary.knownCostUSD, 0)
  assert.equal(summary.estimatedCostUSD, 0.1)
  assert.equal(summary.costEstimates?.[0]?.precision, 'unknown')
  assert.equal(legacy.getTaskChargeObservations('legacy')[0]?.costBasis, undefined)
})
