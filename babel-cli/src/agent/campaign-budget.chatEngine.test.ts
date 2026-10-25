import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { buildProviderRetryCallbacks } from './chatEngineProviderAccounting.js'
import { createParityRuntime } from './chatEngineParityBridge.js'
import { OpenRouterApiRunner } from '../runners/openRouterApi.js'
import { CampaignBudgetStore } from '../eval/campaign-budget-store.js'
import { CampaignDispatchGate, CampaignBudgetDeniedError } from '../runners/campaignDispatchGate.js'
import { LIVE_OPENROUTER_MODEL_ID } from '../modelPolicy.js'
import { globalCostTracker } from '../services/costTracker.js'
import { TurnRoutingReceiptLog } from './turnRoutingReceipt.js'

test('provider accounting callbacks block main chat fetch when campaign budget is exhausted', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'babel-campaign-engine-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const owner = randomUUID()
  const store = new CampaignBudgetStore({
    statePath: join(root, 'campaign-budget.json'),
    campaignId: 'pilot',
    limitMicroUsd: 500,
  })
  const gate = new CampaignDispatchGate({ campaignId: 'pilot', store, taskOwnerId: owner })
  store.transact((budget) => budget.reserve('prefill', 500))
  let physicalFetch = 0
  const saved = globalThis.fetch
  globalThis.fetch = async () => {
    physicalFetch++
    return new Response(JSON.stringify({
      choices: [{ message: { content: 'ok' } }],
      usage: { prompt_tokens: 5, completion_tokens: 2, cost: 0.000001 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  t.after(() => { globalThis.fetch = saved })
  const parity = createParityRuntime(owner)
  parity.turnId = 'turn-1'
  const host = {
    conversation: [],
    engineRunDir: root,
    options: { projectRoot: root, task: 'Say ok' },
    parity,
    taskAllowance: { taskOwnerId: owner },
    campaignDispatchGate: gate,
    _turnIndex: 1,
    _lastPhase: null,
    routingReceiptLog: new TurnRoutingReceiptLog(),
    apiTokenCount: 0,
    lastRequestCompletionTokens: null,
    lastRequestPromptTokens: null,
    lastRequestModelId: null,
    lastLogicalRequestId: null,
    pendingParentRequestId: null,
    pendingUsageChargeId: null,
    checkBudgets: () => ({ ok: true }),
    persistOwnerCharges: () => {},
    persistTaskCostBaseline: () => {},
    recordOwnerAccountingFault: () => {},
  }
  const callbacks = buildProviderRetryCallbacks(host, {
    executionStage: 'chat',
    usageScope: {
      taskOwnerId: owner,
      accountingEpoch: globalCostTracker.getAccountingEpoch(),
      turnId: parity.turnId,
      chargeId: null,
      isOwnerCurrent: () => true,
    },
  })
  const runner = new OpenRouterApiRunner(LIVE_OPENROUTER_MODEL_ID, {}, {
    explicitCredential: 'synthetic-fixture',
    env: { OPENROUTER_API_KEY: 'synthetic-fixture' },
  })
  await assert.rejects(
    () => runner.executeRaw('hello', callbacks),
    (error: unknown) => error instanceof CampaignBudgetDeniedError,
  )
  assert.equal(physicalFetch, 0)
})

test('critic-stage provider callbacks attach the shared campaign meter', () => {
  const owner = randomUUID()
  const gate = new CampaignDispatchGate({
    campaignId: 'pilot',
    taskOwnerId: owner,
    store: new CampaignBudgetStore({
      statePath: join(mkdtempSync(join(tmpdir(), 'babel-campaign-meter-')), 'campaign-budget.json'),
      campaignId: 'pilot',
    }),
  })
  const parity = createParityRuntime(owner)
  const host = {
    conversation: [],
    engineRunDir: '/tmp/unused',
    options: { projectRoot: null, task: 't' },
    parity,
    taskAllowance: { taskOwnerId: owner },
    campaignDispatchGate: gate,
    _turnIndex: 1,
    _lastPhase: null,
    routingReceiptLog: new TurnRoutingReceiptLog(),
    apiTokenCount: 0,
    lastRequestCompletionTokens: null,
    lastRequestPromptTokens: null,
    lastRequestModelId: null,
    lastLogicalRequestId: null,
    pendingParentRequestId: null,
    pendingUsageChargeId: null,
    checkBudgets: () => ({ ok: true }),
    persistOwnerCharges: () => {},
    persistTaskCostBaseline: () => {},
    recordOwnerAccountingFault: () => {},
  }
  const callbacks = buildProviderRetryCallbacks(host, {
    executionStage: 'critic',
    usageScope: {
      taskOwnerId: owner,
      accountingEpoch: globalCostTracker.getAccountingEpoch(),
      turnId: null,
      chargeId: null,
    },
  })
  assert.equal(callbacks.campaignMeter?.executionStage, 'critic')
  assert.equal(callbacks.campaignMeter?.gate, gate)
})
