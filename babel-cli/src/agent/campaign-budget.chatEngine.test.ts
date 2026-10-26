import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { buildProviderRetryCallbacks } from './chatEngineProviderAccounting.js'
import { createParityRuntime } from './chatEngineParityBridge.js'
import { ChatEngine } from './chatEngine.js'
import type { ResolvedModelPolicy } from '../modelPolicy.js'
import { OpenRouterApiRunner } from '../runners/openRouterApi.js'
import { CampaignBudgetStore } from '../eval/campaign-budget-store.js'
import { CampaignDispatchGate, CampaignBudgetDeniedError } from '../runners/campaignDispatchGate.js'
import { buildCampaignOperationId } from '../eval/campaign-metering.js'
import { PILOT_CAMPAIGN_LIMIT_MICRO_USD } from '../eval/campaign-budget.js'
import { CAMPAIGN_QUALIFIED_OPENROUTER_MODEL_ID } from '../eval/campaign-qualified-routes.js'
import { globalCostTracker } from '../services/costTracker.js'
import { TurnRoutingReceiptLog } from './turnRoutingReceipt.js'

const QUALIFIED_OPENROUTER_POLICY: ResolvedModelPolicy = {
  policyPath: 'campaign-qualified-openrouter',
  family: 'openrouter',
  selectedTier: 'cheap',
  resolvedBackendKey: 'deepseek-v4-flash-openrouter',
  provider: 'openrouter',
  providerModelId: CAMPAIGN_QUALIFIED_OPENROUTER_MODEL_ID,
  expensive: false,
  enabled: true,
  experimental: false,
  blockedWithoutExplicitOptIn: false,
  approximateInputTokens: 0,
  approximateOutputTokens: 0,
  warnings: [],
  waterfall: [],
  stagePolicies: [],
  contextWindow: 128_000,
  contextLimit: 128_000,
  maxOutputTokens: 4096,
  nativeToolUse: true,
}

function seedCampaignEngine(t: test.TestContext, limitMicroUsd: number): {
  root: string
  owner: string
  gate: CampaignDispatchGate
  store: CampaignBudgetStore
  engine: ChatEngine
  runner: OpenRouterApiRunner
} {
  const root = mkdtempSync(join(tmpdir(), 'babel-campaign-engine-'))
  mkdirSync(join(root, 'src'), { recursive: true })
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const owner = randomUUID()
  const store = new CampaignBudgetStore({
    statePath: join(root, 'campaign-budget.json'),
    campaignId: 'pilot',
    limitMicroUsd,
  })
  const gate = new CampaignDispatchGate({ campaignId: 'pilot', store, taskOwnerId: owner })
  const runner = new OpenRouterApiRunner(CAMPAIGN_QUALIFIED_OPENROUTER_MODEL_ID, { maxTokens: 128 }, {
    explicitCredential: 'synthetic-fixture',
    env: { OPENROUTER_API_KEY: 'synthetic-fixture' },
  })
  const engine = new ChatEngine({
    task: 'Say ok',
    projectRoot: root,
    model: CAMPAIGN_QUALIFIED_OPENROUTER_MODEL_ID,
    providerRunner: runner,
    providerPolicy: QUALIFIED_OPENROUTER_POLICY,
    campaignDispatchGate: gate,
    maxTurns: 2,
  })
  const parity = (engine as unknown as { parity: ReturnType<typeof createParityRuntime> }).parity
  parity.turnId = 'turn-1'
  const allowance = (engine as unknown as { taskAllowance: { taskOwnerId: string } }).taskAllowance
  allowance.taskOwnerId = owner
  return { root, owner, gate, store, engine, runner }
}

test('ChatEngine submitMessageStream runs one qualified native turn under campaign gate', async (t) => {
  const priorOffline = process.env['BABEL_OFFLINE']
  const priorMaxCost = process.env['BABEL_CHAT_MAX_COST']
  const priorCompaction = process.env['BABEL_COMPACTION']
  process.env['BABEL_OFFLINE'] = '1'
  process.env['BABEL_CHAT_MAX_COST'] = 'unlimited'
  process.env['BABEL_COMPACTION'] = 'off'
  t.after(() => {
    if (priorOffline === undefined) delete process.env['BABEL_OFFLINE']
    else process.env['BABEL_OFFLINE'] = priorOffline
    if (priorMaxCost === undefined) delete process.env['BABEL_CHAT_MAX_COST']
    else process.env['BABEL_CHAT_MAX_COST'] = priorMaxCost
    if (priorCompaction === undefined) delete process.env['BABEL_COMPACTION']
    else process.env['BABEL_COMPACTION'] = priorCompaction
  })
  const { engine, store } = seedCampaignEngine(t, PILOT_CAMPAIGN_LIMIT_MICRO_USD)
  let physicalFetch = 0
  let postedBody = ''
  const saved = globalThis.fetch
  globalThis.fetch = async (_input, init) => {
    physicalFetch++
    postedBody = String(init?.body ?? '')
    const frame = {
      model: CAMPAIGN_QUALIFIED_OPENROUTER_MODEL_ID,
      choices: [{ delta: { content: 'Campaign pilot ok.' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 4, completion_tokens: 2, cost: 0.00001 },
    }
    return new Response(`data: ${JSON.stringify(frame)}\n\ndata: [DONE]\n\n`, {
      headers: { 'Content-Type': 'text/event-stream' },
    })
  }
  t.after(() => { globalThis.fetch = saved })
  const { consumeChatStream } = await import('../interactive/execution/chatCore.js')
  const result = await consumeChatStream(engine.submitMessageStream('Say ok', 'explain'), null)
  assert.equal(physicalFetch, 1)
  assert.match(result.answer ?? '', /Campaign pilot ok/)
  assert.equal(store.readSnapshot().operations.length, 1)
  const parsed = JSON.parse(postedBody) as {
    provider?: { max_price?: { prompt?: number; completion?: number; request?: number } }
  }
  assert.equal(parsed.provider?.max_price?.prompt, 0.14)
  assert.equal(parsed.provider?.max_price?.completion, 0.28)
  assert.equal(parsed.provider?.max_price?.request, 0)
})

test('engine-owned callback integration: main path blocks fetch when campaign budget is exhausted', async (t) => {
  const { store, engine, runner } = seedCampaignEngine(t, 500)
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
  const enginePrivate = engine as unknown as {
    providerRetryCallbacks: (context: Record<string, unknown>) => import('../runners/base.js').RunnerCallbacks
    activeSubmissionGeneration: number
    isSubmissionCurrent: (generation: number) => boolean
    parity: { turnId: string | null }
    taskAllowance: { taskOwnerId: string }
  }
  const generation = enginePrivate.activeSubmissionGeneration
  const ownerCurrent = () => enginePrivate.isSubmissionCurrent(generation)
  const callbacks = enginePrivate.providerRetryCallbacks({
    executionStage: 'chat',
    usageScope: {
      taskOwnerId: enginePrivate.taskAllowance.taskOwnerId,
      accountingEpoch: globalCostTracker.getAccountingEpoch(),
      turnId: enginePrivate.parity.turnId,
      chargeId: null,
      isOwnerCurrent: ownerCurrent,
    },
    isOwnerCurrent: ownerCurrent,
  })
  await assert.rejects(
    () => runner.executeRaw('hello', callbacks),
    (error: unknown) => error instanceof CampaignBudgetDeniedError,
  )
  assert.equal(physicalFetch, 0)
})

test('engine-owned callback integration: critic path attaches campaign meter from engine options', async (t) => {
  const { engine, runner, store } = seedCampaignEngine(t, PILOT_CAMPAIGN_LIMIT_MICRO_USD)
  let physicalFetch = 0
  const saved = globalThis.fetch
  globalThis.fetch = async () => {
    physicalFetch++
    return new Response(JSON.stringify({
      model: CAMPAIGN_QUALIFIED_OPENROUTER_MODEL_ID,
      choices: [{ message: { content: 'critic ok' } }],
      usage: { prompt_tokens: 8, completion_tokens: 4, cost: 0.00001 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  t.after(() => { globalThis.fetch = saved })
  const enginePrivate = engine as unknown as {
    providerRetryCallbacks: (context: Record<string, unknown>) => import('../runners/base.js').RunnerCallbacks
    activeSubmissionGeneration: number
    isSubmissionCurrent: (generation: number) => boolean
    parity: { turnId: string | null }
    taskAllowance: { taskOwnerId: string }
  }
  const generation = enginePrivate.activeSubmissionGeneration
  const ownerCurrent = () => enginePrivate.isSubmissionCurrent(generation)
  const callbacks = enginePrivate.providerRetryCallbacks({
    executionStage: 'critic',
    usageScope: {
      taskOwnerId: enginePrivate.taskAllowance.taskOwnerId,
      accountingEpoch: globalCostTracker.getAccountingEpoch(),
      turnId: enginePrivate.parity.turnId,
      chargeId: null,
      isOwnerCurrent: ownerCurrent,
    },
    isOwnerCurrent: ownerCurrent,
  })
  assert.equal(callbacks.campaignMeter?.executionStage, 'critic')
  await runner.executeRaw('critic prompt', callbacks)
  assert.equal(physicalFetch, 1)
  assert.equal(store.readSnapshot().operations.length, 1)
})

test('engine-owned callback integration: retry reserves once per physical transport attempt', async (t) => {
  const priorMaxCost = process.env['BABEL_CHAT_MAX_COST']
  process.env['BABEL_CHAT_MAX_COST'] = 'unlimited'
  t.after(() => {
    if (priorMaxCost === undefined) delete process.env['BABEL_CHAT_MAX_COST']
    else process.env['BABEL_CHAT_MAX_COST'] = priorMaxCost
  })
  class RetryOnceRunner extends OpenRouterApiRunner {
    protected override getRequestMaxRetries(): number {
      return 2
    }
  }
  const { store, engine } = seedCampaignEngine(t, PILOT_CAMPAIGN_LIMIT_MICRO_USD)
  const runner = new RetryOnceRunner(CAMPAIGN_QUALIFIED_OPENROUTER_MODEL_ID, { maxTokens: 128 }, {
    explicitCredential: 'synthetic-fixture',
    env: { OPENROUTER_API_KEY: 'synthetic-fixture' },
  })
  let calls = 0
  const saved = globalThis.fetch
  globalThis.fetch = async () => {
    calls += 1
    if (calls === 1) {
      return new Response('timeout', { status: 408 })
    }
    return new Response(JSON.stringify({
      model: CAMPAIGN_QUALIFIED_OPENROUTER_MODEL_ID,
      choices: [{ message: { content: 'ok' } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.00001 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  t.after(() => { globalThis.fetch = saved })
  const enginePrivate = engine as unknown as {
    providerRetryCallbacks: (context: Record<string, unknown>) => import('../runners/base.js').RunnerCallbacks
    activeSubmissionGeneration: number
    isSubmissionCurrent: (generation: number) => boolean
    parity: { turnId: string | null }
    taskAllowance: { taskOwnerId: string }
  }
  const generation = enginePrivate.activeSubmissionGeneration
  const ownerCurrent = () => enginePrivate.isSubmissionCurrent(generation)
  const callbacks = enginePrivate.providerRetryCallbacks({
    executionStage: 'chat',
    usageScope: {
      taskOwnerId: enginePrivate.taskAllowance.taskOwnerId,
      accountingEpoch: globalCostTracker.getAccountingEpoch(),
      turnId: enginePrivate.parity.turnId,
      chargeId: null,
      isOwnerCurrent: ownerCurrent,
    },
    isOwnerCurrent: ownerCurrent,
  })
  await runner.executeRaw('hello', callbacks)
  assert.equal(calls, 2)
  assert.equal(store.readSnapshot().operations.length, 2)
})

test('late completion settles captured campaign gate before owner supersession guard', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'babel-campaign-supersede-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const owner = randomUUID()
  const store = new CampaignBudgetStore({
    statePath: join(root, 'campaign-budget.json'),
    campaignId: 'pilot',
    limitMicroUsd: PILOT_CAMPAIGN_LIMIT_MICRO_USD,
  })
  const gate = new CampaignDispatchGate({ campaignId: 'pilot', store, taskOwnerId: owner })
  const parity = createParityRuntime(owner)
  parity.turnId = null
  let ownerCurrent = false
  const host = {
    conversation: [],
    engineRunDir: root,
    options: { projectRoot: root, task: 't' },
    parity,
    taskAllowance: { taskOwnerId: owner },
    campaignDispatchGate: null as CampaignDispatchGate | null,
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
  host.campaignDispatchGate = gate
  const callbacks = buildProviderRetryCallbacks(host, {
    executionStage: 'chat',
    isOwnerCurrent: () => ownerCurrent,
    usageScope: {
      taskOwnerId: owner,
      accountingEpoch: globalCostTracker.getAccountingEpoch(),
      turnId: null,
      chargeId: null,
    },
  })
  const requestId = randomUUID()
  const attemptId = randomUUID()
  callbacks.onInvocationStarted?.({
    inference_id: randomUUID(),
    request_id: requestId,
    attempt_id: attemptId,
    provider: 'openrouter',
    requested_model_id: CAMPAIGN_QUALIFIED_OPENROUTER_MODEL_ID,
    normalized_model_id: CAMPAIGN_QUALIFIED_OPENROUTER_MODEL_ID,
    sent_model_id: CAMPAIGN_QUALIFIED_OPENROUTER_MODEL_ID,
    input_digest: 'digest',
  })
  const operationId = buildCampaignOperationId({
    campaignId: 'pilot',
    taskOwnerId: owner,
    executionStage: 'chat',
    requestId,
    attemptId,
  })
  store.transact((budget) => {
    budget.reserve(operationId, 500)
  })
  host.campaignDispatchGate = null
  callbacks.onInvocationCompleted?.({
    inference_id: randomUUID(),
    provider: 'openrouter',
    model: CAMPAIGN_QUALIFIED_OPENROUTER_MODEL_ID,
    status: 'delivered',
    usage_metadata: {
      provider: 'openrouter',
      provider_model_id: CAMPAIGN_QUALIFIED_OPENROUTER_MODEL_ID,
      latency_ms: 1,
      prompt_tokens: 3,
      completion_tokens: 2,
      total_tokens: 5,
      provider_reported_total_charge_usd: 0.000002,
      estimated_cost_usd: 0.000002,
      cost_precision: 'exact',
    },
  })
  const settled = store.readSnapshot().operations.find((operation) => operation.operationId.endsWith(attemptId))
  assert.ok(settled)
  assert.equal(settled?.actualMicroUsd, 2)
})
