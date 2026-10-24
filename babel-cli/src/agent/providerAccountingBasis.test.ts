/**
 * Campaign Task 5 accounting tests: billing-basis persistence and the
 * pre-dispatch reservation budget.
 *
 * Offline only. A fresh CostTracker instance per test keeps the global
 * singleton untouched; no provider network access occurs.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CostTracker, globalCostTracker, type UsageAttribution } from '../services/costTracker.js'
import { buildProviderRetryCallbacks, type ChatProviderRetryHost } from './chatEngineProviderAccounting.js'
import { OPENROUTER_PRICING_SOURCE_URL, COMMANDCODE_PRICING_SOURCE_URL } from '../services/modelPricingRegistry.js'
import type { ProviderInvocationStarted, RunnerInvocationMetadata } from '../runners/base.js'

function attributionOf(chargeId: string, epoch = 'epoch-test'): UsageAttribution {
  return {
    taskOwnerId: 'owner-1',
    chargeId,
    accountingEpoch: epoch,
  }
}

function freshTracker(): CostTracker {
  return new CostTracker(mkdtempSync(join(tmpdir(), 'babel-cost-basis-')))
}

test('tariff-derived charges stamp a tariff_estimate basis with its pricing source', () => {
  const tracker = freshTracker()
  tracker.restoreTaskUsage('owner-1', { totalCostUSD: 0, chargeIds: [] })
  const update = tracker.settleUsage(
    'z-ai/glm-5.3-flash', 1000, 500, null, null,
    attributionOf('charge-tariff', tracker.getAccountingEpoch()), true, 'commandcode',
  )
  assert.equal(update.kind, 'inserted')
  const receipts = tracker.getTaskChargeObservations('owner-1')
  assert.equal(receipts.length, 1)
  const receipt = receipts[0]!
  assert.equal(receipt.billingBasis, 'tariff_estimate')
  assert.equal(receipt.billingBasisSource, COMMANDCODE_PRICING_SOURCE_URL)
  assert.ok(receipt.billingBasisAt !== undefined)
  // The amount is known from the pinned tariff; the basis marks it as an
  // estimate, never a provider invoice.
  assert.ok(Math.abs((receipt.knownCostUSD ?? -1) - 0.0004) < 1e-12)
  assert.equal(receipt.estimatedCostUSD, undefined)
})

test('openrouter tariff charges carry the openrouter pricing source', () => {
  const tracker = freshTracker()
  tracker.restoreTaskUsage('owner-1', { totalCostUSD: 0, chargeIds: [] })
  tracker.settleUsage(
    'z-ai/glm-5.3-flash', 1000, 500, 200, 800,
    attributionOf('charge-or', tracker.getAccountingEpoch()), true, 'openrouter',
  )
  const receipt = tracker.getTaskChargeObservations('owner-1')[0]!
  assert.equal(receipt.billingBasis, 'tariff_estimate')
  assert.equal(receipt.billingBasisSource, OPENROUTER_PRICING_SOURCE_URL)
})

test('provider-reported cost keeps its basis and never masquerades as a tariff', () => {
  const tracker = freshTracker()
  tracker.restoreTaskUsage('owner-1', { totalCostUSD: 0, chargeIds: [] })
  // A model with no pinned registry price accepts the provider-reported charge.
  tracker.settleUsage(
    'test/unpriced-model', 1000, 500, null, null,
    attributionOf('charge-reported', tracker.getAccountingEpoch()), true, 'openrouter', 0.007,
  )
  const receipt = tracker.getTaskChargeObservations('owner-1')[0]!
  assert.equal(receipt.billingBasis, 'provider_reported')
  assert.equal(receipt.billingBasisSource, 'provider_reported')
  assert.equal(receipt.knownCostUSD, 0.007)
  assert.equal(receipt.estimatedCostUSD, undefined)
})

test('missing usage stays unknown and never becomes zero', () => {
  const tracker = freshTracker()
  tracker.restoreTaskUsage('owner-1', { totalCostUSD: 0, chargeIds: [] })
  tracker.settleUsage(
    'test/unpriced-model', 0, 0, null, null,
    attributionOf('charge-unknown', tracker.getAccountingEpoch()), false, 'openrouter',
  )
  const receipt = tracker.getTaskChargeObservations('owner-1')[0]!
  assert.equal(receipt.billingBasis, 'unknown')
  assert.equal(receipt.knownCostUSD, null)
  const summary = tracker.getTaskSummary('owner-1')
  assert.equal(summary.unknownChargeCount, 1)
  assert.equal(summary.completeCostUSD, null)
})

test('an invalid stamped basis is rejected on restore', () => {
  const tracker = freshTracker()
  assert.throws(() => tracker.restoreTaskUsage('owner-1', {
    totalCostUSD: 0.5,
    chargeIds: ['charge-bad'],
    unknownChargeCount: 0,
    chargeObservations: [{
      attribution: { taskOwnerId: 'owner-1', chargeId: 'charge-bad', accountingEpoch: 'epoch-test' },
      modelId: 'test/unpriced-model',
      inputTokens: 10, outputTokens: 10, cacheHitTokens: 0, cacheMissTokens: 0,
      knownCostUSD: 0.5,
      // A claimed provider invoice whose amount was actually tariff-derived
      // must not pass validation.
      billingBasis: 'provider_reported',
      billingBasisAt: '2026-10-23T00:00:00.000Z',
      billingBasisSource: 'https://example.invalid/pricing',
    }],
  }), /Invalid durable charge observation/)
})

test('a stamped basis survives a durable restore round-trip', () => {
  const first = freshTracker()
  first.restoreTaskUsage('owner-1', { totalCostUSD: 0, chargeIds: [] })
  first.settleUsage(
    'test/unpriced-model', 100, 50, null, null,
    attributionOf('charge-keep', first.getAccountingEpoch()), true, 'openrouter', 0.02,
  )
  const saved = first.getTaskChargeObservations('owner-1')
  const second = freshTracker()
  second.restoreTaskUsage('owner-1', {
    totalCostUSD: saved.reduce((sum, r) => sum + (r.knownCostUSD ?? 0), 0),
    chargeIds: saved.map((r) => r.attribution.chargeId),
    unknownChargeCount: saved.filter((r) => r.knownCostUSD === null).length,
    chargeObservations: saved,
  })
  const restored = second.getTaskChargeObservations('owner-1')[0]!
  assert.equal(restored.billingBasis, 'provider_reported')
  assert.equal(restored.knownCostUSD, 0.02)
  // Same-process re-settlement of an identical confirmed receipt is a
  // duplicate, not a second charge.
  const refine = first.settleUsage(
    'test/unpriced-model', 100, 50, null, null,
    attributionOf('charge-keep', first.getAccountingEpoch()), true, 'openrouter', 0.02,
  )
  assert.equal(refine.kind, 'duplicate')
  // Unmodified token counters persist untouched.
  assert.equal(restored.inputTokens, 100)
  assert.equal(restored.outputTokens, 50)
})

// ── Pre-dispatch reservation budget ─────────────────────────────────────────

function fakeHost(): { host: ChatProviderRetryHost; reservations: Map<string, number> } {
  const reservations = new Map<string, number>()
  return {
    reservations,
    host: {
      conversation: [],
      engineRunDir: 'unused',
      options: { projectRoot: null, task: 'test' },
      parity: {
        turnId: null,
        sessionEvents: { events: [] },
      } as unknown as ChatProviderRetryHost['parity'],
      taskAllowance: null,
      _turnIndex: 0,
      _lastPhase: null,
      routingReceiptLog: { push: () => {} } as unknown as ChatProviderRetryHost['routingReceiptLog'],
      apiTokenCount: 0,
      lastRequestCompletionTokens: null,
      lastRequestModelId: null,
      lastRequestPromptTokens: null,
      lastLogicalRequestId: null,
      pendingParentRequestId: null,
      pendingUsageChargeId: null,
      checkBudgets: () => ({ ok: true }),
      persistOwnerCharges: () => {},
      persistTaskCostBaseline: () => {},
      recordOwnerAccountingFault: () => {},
      reserveDispatchCost: (chargeId, usd) => { reservations.set(chargeId, usd) },
      releaseDispatchCost: (chargeId) => { reservations.delete(chargeId) },
      get outstandingDispatchReservationUsd() {
        let total = 0
        for (const value of reservations.values()) total += value
        return total
      },
    },
  }
}

function startedEvent(overrides: Partial<ProviderInvocationStarted> = {}): ProviderInvocationStarted {
  return {
    inference_id: 'inf-reserve-1',
    provider: 'commandcode',
    requested_model_id: 'glm-5.3-flash-commandcode',
    normalized_model_id: 'glm-5.3-flash-commandcode',
    sent_model_id: 'z-ai/glm-5.3-flash',
    input_digest: 'digest',
    ...overrides,
  }
}

test('dispatch reserves bounded cost and completion releases it exactly once', () => {
  const { host, reservations } = fakeHost()
  const callbacks = buildProviderRetryCallbacks(host, {
    usageScope: {
      taskOwnerId: 'owner-1',
      accountingEpoch: globalCostTracker.getAccountingEpoch(),
      turnId: null, chargeId: null,
    },
    reservation: { inputTokens: 1_000_000, outputTokens: 100_000 },
  })
  callbacks.onInvocationStarted?.(startedEvent())
  // 1M input at 0.15/M + 100k output at 0.50/M = 0.20.
  const reserved = reservations.get('inf-reserve-1')
  assert.ok(reserved !== undefined)
  assert.ok(Math.abs(reserved - 0.2) < 1e-9)
  assert.ok(Math.abs(host.outstandingDispatchReservationUsd - 0.2) < 1e-9)

  callbacks.onInvocationCompleted?.({
    inference_id: 'inf-reserve-1',
    provider: 'commandcode',
    model: 'z-ai/glm-5.3-flash',
    status: 'delivered',
  } as unknown as Parameters<NonNullable<typeof callbacks.onInvocationCompleted>>[0])
  assert.equal(reservations.size, 0)
  assert.equal(host.outstandingDispatchReservationUsd, 0)
})

test('unpriced routes reserve nothing instead of inventing a ceiling', () => {
  const { host, reservations } = fakeHost()
  const callbacks = buildProviderRetryCallbacks(host, {
    usageScope: {
      taskOwnerId: 'owner-1',
      accountingEpoch: globalCostTracker.getAccountingEpoch(),
      turnId: null, chargeId: null,
    },
    reservation: { inputTokens: 1_000_000, outputTokens: 100_000 },
  })
  callbacks.onInvocationStarted?.(startedEvent({
    inference_id: 'inf-unpriced',
    provider: 'openrouter',
    sent_model_id: 'test/unpriced-model',
  }))
  assert.equal(reservations.size, 0)
})

test('a failed invocation also releases its reservation', () => {
  const { host, reservations } = fakeHost()
  const callbacks = buildProviderRetryCallbacks(host, {
    usageScope: {
      taskOwnerId: 'owner-1',
      accountingEpoch: globalCostTracker.getAccountingEpoch(),
      turnId: null, chargeId: null,
    },
    reservation: { inputTokens: 1_000_000, outputTokens: 100_000 },
  })
  callbacks.onInvocationStarted?.(startedEvent({ inference_id: 'inf-fail' }))
  assert.equal(reservations.size, 1)
  callbacks.onInvocationCompleted?.({
    inference_id: 'inf-fail',
    provider: 'commandcode',
    model: 'z-ai/glm-5.3-flash',
    status: 'failed',
    inference_started: true,
  } as unknown as Parameters<NonNullable<typeof callbacks.onInvocationCompleted>>[0])
  assert.equal(reservations.size, 0)
})

test('invocation metadata reports provider-reported cost basis through settlement', () => {
  // The metadata path used by trackRunnerUsage: reported cost flows through
  // settleUsage's reportedCost channel only when the route is unpriced.
  const tracker = freshTracker()
  tracker.restoreTaskUsage('owner-1', { totalCostUSD: 0, chargeIds: [] })
  const metadata: RunnerInvocationMetadata = {
    provider: 'commandcode',
    provider_model_id: 'z-ai/glm-5.3-flash',
    prompt_tokens: 1000,
    completion_tokens: 1000,
    prompt_cache_hit_tokens: null,
    prompt_cache_miss_tokens: null,
    total_tokens: 2000,
    estimated_cost_usd: null,
    latency_ms: 10,
  } as unknown as RunnerInvocationMetadata
  tracker.settleUsage(
    metadata.provider_model_id!, metadata.prompt_tokens!, metadata.completion_tokens!,
    null, null, attributionOf('charge-meta', tracker.getAccountingEpoch()), true, 'commandcode', metadata.estimated_cost_usd,
  )
  const receipt = tracker.getTaskChargeObservations('owner-1')[0]!
  assert.equal(receipt.billingBasis, 'tariff_estimate')
  assert.equal(receipt.billingBasisSource, COMMANDCODE_PRICING_SOURCE_URL)
})
