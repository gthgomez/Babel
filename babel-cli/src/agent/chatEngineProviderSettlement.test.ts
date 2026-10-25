import assert from 'node:assert/strict'
import test from 'node:test'
import type { RunnerInvocationMetadata } from '../runners/base.js'
import type { OpenRouterApiRunner } from '../runners/openRouterApi.js'
import { globalCostTracker } from '../services/costTracker.js'
import { settlementReportedCostUsd } from '../services/settlementReportedCost.js'
import {
  buildProviderRetryCallbacks,
  captureUsageAttribution,
  trackRunnerUsage,
  type ChatProviderRetryHost,
  type ChatUsageScope,
} from './chatEngineProviderAccounting.js'
import type { RunnerCallbacks } from '../runners/base.js'

function mockHost(taskOwnerId: string, overrides: Partial<ChatProviderRetryHost> = {}): ChatProviderRetryHost {
  return {
    conversation: [],
    engineRunDir: '/tmp/babel-provider-settlement-test',
    options: { projectRoot: null, task: 'fixture' },
    parity: { turnId: 'turn-1' } as ChatProviderRetryHost['parity'],
    taskAllowance: { taskOwnerId },
    routingReceiptLog: { receipts: [] } as unknown as ChatProviderRetryHost['routingReceiptLog'],
    apiTokenCount: 0,
    lastRequestCompletionTokens: null,
    lastRequestModelId: null,
    lastRequestPromptTokens: null,
    lastLogicalRequestId: null,
    pendingParentRequestId: null,
    pendingUsageChargeId: null,
    _turnIndex: 0,
    _lastPhase: null,
    checkBudgets: () => ({ ok: true }),
    persistOwnerCharges: () => {},
    persistTaskCostBaseline: () => {},
    recordOwnerAccountingFault: () => {},
    ...overrides,
  } as ChatProviderRetryHost
}

function runnerStub(metadata: RunnerInvocationMetadata): OpenRouterApiRunner {
  return { getLastInvocationMetadata: () => metadata } as unknown as OpenRouterApiRunner
}

function openRouterMetadata(overrides: Partial<RunnerInvocationMetadata>): RunnerInvocationMetadata {
  return {
    provider: 'openrouter',
    provider_model_id: 'deepseek/deepseek-v4-flash-0731',
    latency_ms: 1,
    prompt_tokens: 100,
    completion_tokens: 10,
    total_tokens: 110,
    estimated_cost_usd: 0.000016800000000000002,
    ...overrides,
  }
}

test('settlementReportedCostUsd prefers provider_reported and ignores estimated_cost_usd', () => {
  assert.equal(settlementReportedCostUsd(openRouterMetadata({
    provider_reported_total_charge_usd: 0.002,
  })), 0.002)
  assert.equal(settlementReportedCostUsd(openRouterMetadata({
    provider_reported_total_charge_usd: null,
  })), null)
  assert.equal(settlementReportedCostUsd(openRouterMetadata({})), undefined)
})

test('trackRunnerUsage settles provider_reported_total_charge_usd, not estimated_cost_usd', () => {
  globalCostTracker.resetSession()
  const owner = 'owner-reported-precedence'
  const chargeId = 'inf-reported-precedence'
  const host = mockHost(owner)
  const scope: ChatUsageScope = {
    taskOwnerId: owner,
    accountingEpoch: globalCostTracker.getAccountingEpoch(),
    turnId: 'turn-1',
    chargeId,
    provider: 'openrouter',
  }
  globalCostTracker.settleUsage(
    'deepseek/deepseek-v4-flash-0731', 0, 0, null, null,
    captureUsageAttribution(scope, chargeId)!,
    false,
    'openrouter',
  )
  const metadata = openRouterMetadata({
    provider_reported_total_charge_usd: 0.002,
    prompt_cache_hit_tokens: 40,
    prompt_cache_miss_tokens: 60,
  })
  trackRunnerUsage(host, runnerStub(metadata), scope)
  const summary = globalCostTracker.getTaskSummary(owner)
  assert.equal(summary.totalCostUSD, 0.002)
  assert.equal(summary.unknownChargeCount, 0)
  trackRunnerUsage(host, runnerStub(metadata), scope)
  assert.equal(globalCostTracker.getTaskChargeObservations(owner).length, 1)
})

test('trackRunnerUsage keeps explicit unknown when provider_reported_total_charge_usd is null', () => {
  globalCostTracker.resetSession()
  const owner = 'owner-explicit-unknown'
  const chargeId = 'inf-unknown'
  const host = mockHost(owner)
  const scope: ChatUsageScope = {
    taskOwnerId: owner,
    accountingEpoch: globalCostTracker.getAccountingEpoch(),
    turnId: 'turn-1',
    chargeId,
    provider: 'openrouter',
  }
  globalCostTracker.settleUsage(
    'deepseek/deepseek-v4-flash-0731', 0, 0, null, null,
    captureUsageAttribution(scope, chargeId)!,
    false,
    'openrouter',
  )
  const metadata = openRouterMetadata({
    provider_reported_total_charge_usd: null,
    estimated_cost_usd: 0.5,
  })
  trackRunnerUsage(host, runnerStub(metadata), scope)
  const summary = globalCostTracker.getTaskSummary(owner)
  assert.equal(summary.unknownChargeCount, 1)
  assert.equal(summary.totalCostUSD, 0)
})

test('trackRunnerUsage uses registry when provider charge is absent, not estimated_cost_usd as reported', () => {
  globalCostTracker.resetSession()
  const owner = 'owner-registry-not-estimate'
  const chargeId = 'inf-registry'
  const host = mockHost(owner)
  const scope: ChatUsageScope = {
    taskOwnerId: owner,
    accountingEpoch: globalCostTracker.getAccountingEpoch(),
    turnId: 'turn-1',
    chargeId,
    provider: 'openrouter',
  }
  globalCostTracker.settleUsage(
    'deepseek/deepseek-v4-flash-0731', 0, 0, null, null,
    captureUsageAttribution(scope, chargeId)!,
    false,
    'openrouter',
  )
  const metadata = openRouterMetadata({ estimated_cost_usd: 9.99 })
  delete metadata.provider_reported_total_charge_usd
  trackRunnerUsage(host, runnerStub(metadata), scope)
  const summary = globalCostTracker.getTaskSummary(owner)
  assert.notEqual(summary.totalCostUSD, 9.99)
  assert.ok(summary.totalCostUSD > 0 && summary.totalCostUSD < 1)
})

test('late-owner delivery settlement carries provider_reported and idempotently refines', () => {
  globalCostTracker.resetSession()
  const owner = 'owner-late-settle'
  const inferenceId = 'inf-late-owner'
  const host = mockHost(owner)
  let ownerCurrent = false
  const scope: ChatUsageScope = {
    taskOwnerId: owner,
    accountingEpoch: globalCostTracker.getAccountingEpoch(),
    turnId: 'turn-late',
    chargeId: inferenceId,
    requestId: 'req-late',
    attemptId: 'attempt-late',
    provider: 'openrouter',
  }
  const callbacks: RunnerCallbacks = buildProviderRetryCallbacks(host, {
    usageScope: scope,
    isOwnerCurrent: () => ownerCurrent,
  })
  callbacks.onInvocationStarted?.({
    inference_id: inferenceId,
    request_id: 'req-late',
    attempt_id: 'attempt-late',
    provider: 'openrouter',
    requested_model_id: 'deepseek/deepseek-v4-flash-0731',
    normalized_model_id: 'deepseek/deepseek-v4-flash-0731',
    sent_model_id: 'deepseek/deepseek-v4-flash-0731',
    input_digest: 'digest',
  })
  const metadata = openRouterMetadata({
    provider_reported_total_charge_usd: 0.003,
    prompt_cache_hit_tokens: 10,
    prompt_cache_miss_tokens: 90,
  })
  callbacks.onInvocationCompleted?.({
    inference_id: inferenceId,
    provider: 'openrouter',
    model: 'deepseek/deepseek-v4-flash-0731',
    status: 'delivered',
    usage_metadata: metadata,
  })
  const afterLate = globalCostTracker.getTaskSummary(owner)
  assert.equal(afterLate.totalCostUSD, 0.003)
  ownerCurrent = true
  trackRunnerUsage(host, runnerStub(metadata), scope)
  assert.equal(globalCostTracker.getTaskChargeObservations(owner).length, 1)
  assert.equal(globalCostTracker.getTaskSummary(owner).totalCostUSD, 0.003)
  const attribution = captureUsageAttribution(scope, inferenceId, 'req-late', 'attempt-late')
  const conflict = globalCostTracker.settleUsage(
    metadata.provider_model_id!,
    metadata.prompt_tokens!,
    metadata.completion_tokens!,
    metadata.prompt_cache_hit_tokens,
    metadata.prompt_cache_miss_tokens,
    attribution,
    true,
    'openrouter',
    0.000016800000000000002,
  )
  assert.equal(conflict.kind, 'conflict')
})
