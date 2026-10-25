import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { OpenRouterApiRunner } from './openRouterApi.js'
import { CampaignBudgetDeniedError } from './campaignDispatchGate.js'
import { CampaignBudgetStore } from '../eval/campaign-budget-store.js'
import { CampaignDispatchGate } from './campaignDispatchGate.js'
import { PILOT_CAMPAIGN_LIMIT_MICRO_USD } from '../eval/campaign-budget.js'
import { CAMPAIGN_QUALIFIED_OPENROUTER_MODEL_ID } from '../eval/campaign-qualified-routes.js'
import { CommandCodeApiRunner } from './commandCodeApi.js'
import { CampaignRouteUnsupportedError } from './campaignDispatchGate.js'
import { createRunControl, RunStoppedError, dispatchRunOperation } from '../runtime/run-control.js'
import { CampaignPhysicalFetchSession } from './providerCampaignPhysicalFetch.js'
import { prepareCampaignOpenRouterProviderRequest } from '../eval/campaign-openrouter-wire.js'

function committedMicroUsd(
  store: CampaignBudgetStore,
): number {
  const snapshot = store.readSnapshot()
  return snapshot.operations.reduce((sum, operation) => {
    if (operation.actualMicroUsd !== null) return sum + operation.actualMicroUsd
    return sum + operation.upperBoundMicroUsd
  }, 0)
}

function qualifiedPreparedRequest() {
  return prepareCampaignOpenRouterProviderRequest({
    bodyObject: {
      model: CAMPAIGN_QUALIFIED_OPENROUTER_MODEL_ID,
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 16,
    },
    mode: 'text',
    provider: 'openrouter',
    requestedModelId: CAMPAIGN_QUALIFIED_OPENROUTER_MODEL_ID,
    reservedCompletionTokens: 16,
  })
}

test('gate pre-wire stop after reserve zero-settles without physical fetch', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'babel-campaign-gate-prewire-stop-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const owner = randomUUID()
  const store = new CampaignBudgetStore({
    statePath: join(root, 'campaign-budget.json'),
    campaignId: 'pilot',
    limitMicroUsd: PILOT_CAMPAIGN_LIMIT_MICRO_USD,
  })
  const gate = new CampaignDispatchGate({ campaignId: 'pilot', store, taskOwnerId: owner })
  const prepared = qualifiedPreparedRequest()
  const control = createRunControl({ runId: 'run-1', turnId: 'turn-1', generation: 1 })
  control.requestStop({
    owner: control.owner,
    kind: 'cancelled',
    reasonCode: 'cancelled',
    source: 'user',
  })
  let physicalFetch = 0
  const saved = globalThis.fetch
  globalThis.fetch = async () => {
    physicalFetch += 1
    return new Response('{}', { status: 200 })
  }
  t.after(() => { globalThis.fetch = saved })

  await assert.rejects(
    () => gate.admitBeforeDispatch({
      executionStage: 'chat',
      preparedRequest: prepared,
      runControl: control,
    }),
    (error: unknown) => error instanceof RunStoppedError,
  )
  assert.equal(physicalFetch, 0)
  assert.equal(store.readSnapshot().operations.length, 1)
  const operation = store.readSnapshot().operations[0]!
  assert.equal(operation.actualMicroUsd, 0)
  assert.equal(operation.settledUnknown, false)
  assert.equal(committedMicroUsd(store), 0)

  const reloaded = new CampaignBudgetStore({
    statePath: join(root, 'campaign-budget.json'),
    campaignId: 'pilot',
    limitMicroUsd: PILOT_CAMPAIGN_LIMIT_MICRO_USD,
  })
  assert.equal(reloaded.readSnapshot().operations[0]?.actualMicroUsd, 0)
  gate.settleZeroForProvableNoWire({
    executionStage: 'chat',
    requestId: prepared.request_id,
    attemptId: prepared.attempt_id,
  })
  gate.settleZeroForProvableNoWire({
    executionStage: 'chat',
    requestId: prepared.request_id,
    attemptId: prepared.attempt_id,
  })
  assert.equal(reloaded.readSnapshot().operations[0]?.actualMicroUsd, 0)
})

test('physical session pre-fetch stop after handoff keeps unknown exposure', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'babel-campaign-physical-prewire-stop-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const owner = randomUUID()
  const store = new CampaignBudgetStore({
    statePath: join(root, 'campaign-budget.json'),
    campaignId: 'pilot',
    limitMicroUsd: PILOT_CAMPAIGN_LIMIT_MICRO_USD,
  })
  const gate = new CampaignDispatchGate({ campaignId: 'pilot', store, taskOwnerId: owner })
  const prepared = qualifiedPreparedRequest()
  const session = new CampaignPhysicalFetchSession({
    campaignMeter: { executionStage: 'chat', gate },
  })
  const control = createRunControl({ runId: 'run-2', turnId: 'turn-2', generation: 1 })
  await session.admitBeforeWire(prepared, prepared.attempt_id, control)
  control.requestStop({
    owner: control.owner,
    kind: 'cancelled',
    reasonCode: 'cancelled',
    source: 'user',
  })
  let physicalFetch = 0
  await assert.rejects(
    () => dispatchRunOperation(control, 'model', 'provider_fetch', async () => {
      physicalFetch += 1
      return new Response('{}', { status: 200 })
    }),
    (error: unknown) => error instanceof RunStoppedError,
  )
  session.settleUnknownOnOpenAdmission()
  assert.equal(physicalFetch, 0)
  const operation = store.readSnapshot().operations[0]!
  assert.equal(operation.actualMicroUsd, null)
  assert.equal(operation.settledUnknown, true)
  assert.ok(operation.upperBoundMicroUsd > 0)
  assert.equal(committedMicroUsd(store), operation.upperBoundMicroUsd)
})

test('rejected campaign reservation never reaches physical fetch on runner path', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'babel-campaign-gate-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const owner = randomUUID()
  const store = new CampaignBudgetStore({
    statePath: join(root, 'campaign-budget.json'),
    campaignId: 'pilot',
    limitMicroUsd: 1000,
  })
  const gate = new CampaignDispatchGate({ campaignId: 'pilot', store, taskOwnerId: owner })
  store.transact((budget) => {
    budget.reserve('prefill', 1000)
  })
  let physicalFetch = 0
  const saved = globalThis.fetch
  globalThis.fetch = async () => {
    physicalFetch++
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 })
  }
  t.after(() => { globalThis.fetch = saved })
  const model = CAMPAIGN_QUALIFIED_OPENROUTER_MODEL_ID
  const runner = new OpenRouterApiRunner(model, {}, {
    explicitCredential: 'synthetic-fixture',
    env: { OPENROUTER_API_KEY: 'synthetic-fixture' },
  })
  await assert.rejects(
    () => runner.executeRaw('hello', {
      campaignMeter: { executionStage: 'chat', gate },
    }),
    (error: unknown) => error instanceof CampaignBudgetDeniedError,
  )
  assert.equal(physicalFetch, 0)
})

test('admitted reservation reaches fetch once and leaves durable ledger evidence', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'babel-campaign-gate-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const owner = randomUUID()
  const store = new CampaignBudgetStore({
    statePath: join(root, 'campaign-budget.json'),
    campaignId: 'pilot',
    limitMicroUsd: PILOT_CAMPAIGN_LIMIT_MICRO_USD,
  })
  const gate = new CampaignDispatchGate({ campaignId: 'pilot', store, taskOwnerId: owner })
  let physicalFetch = 0
  let requestId = ''
  let attemptId = ''
  const saved = globalThis.fetch
  globalThis.fetch = async () => {
    physicalFetch++
    return new Response(JSON.stringify({
      model: CAMPAIGN_QUALIFIED_OPENROUTER_MODEL_ID,
      choices: [{ message: { content: 'ok' } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.00001 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  t.after(() => { globalThis.fetch = saved })
  const model = CAMPAIGN_QUALIFIED_OPENROUTER_MODEL_ID
  const runner = new OpenRouterApiRunner(model, {}, {
    explicitCredential: 'synthetic-fixture',
    env: { OPENROUTER_API_KEY: 'synthetic-fixture' },
  })
  await runner.executeRaw('hello', {
    campaignMeter: { executionStage: 'critic', gate },
    onInvocationStarted: (event) => {
      requestId = event.request_id ?? ''
      attemptId = event.attempt_id ?? ''
    },
  })
  assert.equal(physicalFetch, 1)
  assert.equal(store.readSnapshot().operations.length, 1)
  const operation = store.readSnapshot().operations[0]!
  assert.ok(operation.actualMicroUsd !== null || operation.settledUnknown)
})

test('each physical transport retry reserves before wire', async (t) => {
  class RetryOnceRunner extends OpenRouterApiRunner {
    protected override getRequestMaxRetries(): number {
      return 2
    }
  }
  const root = mkdtempSync(join(tmpdir(), 'babel-campaign-retry-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const owner = randomUUID()
  const store = new CampaignBudgetStore({
    statePath: join(root, 'campaign-budget.json'),
    campaignId: 'pilot',
    limitMicroUsd: PILOT_CAMPAIGN_LIMIT_MICRO_USD,
  })
  const gate = new CampaignDispatchGate({ campaignId: 'pilot', store, taskOwnerId: owner })
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
  const runner = new RetryOnceRunner(CAMPAIGN_QUALIFIED_OPENROUTER_MODEL_ID, {}, {
    explicitCredential: 'synthetic-fixture',
    env: { OPENROUTER_API_KEY: 'synthetic-fixture' },
  })
  await runner.executeRaw('hello', {
    campaignMeter: { executionStage: 'chat', gate },
  })
  assert.equal(calls, 2)
  assert.equal(store.readSnapshot().operations.length, 2)
})

test('campaign gate admits Command Code qualified deepseek route only', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'babel-campaign-command-code-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const owner = randomUUID()
  const store = new CampaignBudgetStore({
    statePath: join(root, 'campaign-budget.json'),
    campaignId: 'pilot',
    limitMicroUsd: PILOT_CAMPAIGN_LIMIT_MICRO_USD,
  })
  const gate = new CampaignDispatchGate({ campaignId: 'pilot', store, taskOwnerId: owner })
  let physicalFetch = 0
  const saved = globalThis.fetch
  globalThis.fetch = async () => {
    physicalFetch++
    return new Response(JSON.stringify({
      model: 'deepseek/deepseek-v4.1-flash',
      choices: [{ message: { content: 'ok' } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  t.after(() => { globalThis.fetch = saved })
  const model = 'deepseek/deepseek-v4.1-flash'
  const runner = new CommandCodeApiRunner(model, { maxTokens: 128 }, {
    explicitCredential: 'synthetic-fixture',
    env: { COMMAND_CODE_API_KEY: 'synthetic-fixture' },
  })
  await runner.executeRaw('hello', {
    campaignMeter: { executionStage: 'chat', gate },
  })
  assert.equal(physicalFetch, 1)
})

test('non-qualified OpenRouter models reject before physical fetch', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'babel-campaign-route-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const owner = randomUUID()
  const store = new CampaignBudgetStore({
    statePath: join(root, 'campaign-budget.json'),
    campaignId: 'pilot',
    limitMicroUsd: PILOT_CAMPAIGN_LIMIT_MICRO_USD,
  })
  const gate = new CampaignDispatchGate({ campaignId: 'pilot', store, taskOwnerId: owner })
  let physicalFetch = 0
  const saved = globalThis.fetch
  globalThis.fetch = async () => {
    physicalFetch++
    return new Response('{}', { status: 200 })
  }
  t.after(() => { globalThis.fetch = saved })
  const runner = new OpenRouterApiRunner('z-ai/glm-5.3-flash', {}, {
    explicitCredential: 'synthetic-fixture',
    env: { OPENROUTER_API_KEY: 'synthetic-fixture' },
  })
  await assert.rejects(
    () => runner.executeRaw('hello', { campaignMeter: { executionStage: 'chat', gate } }),
    (error: unknown) => error instanceof CampaignRouteUnsupportedError,
  )
  assert.equal(physicalFetch, 0)
})
