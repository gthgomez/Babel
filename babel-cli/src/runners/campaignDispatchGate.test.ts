import assert from 'node:assert/strict'
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, unlinkSync } from 'node:fs'
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
import type { RunControl } from '../runtime/run-control.js'
import { createRunControl, RunStoppedError } from '../runtime/run-control.js'
import { CampaignPhysicalFetchSession } from './providerCampaignPhysicalFetch.js'
import { prepareCampaignOpenRouterProviderRequest } from '../eval/campaign-openrouter-wire.js'

function committedMicroUsdFromSnapshot(snapshot: {
  operations: readonly { actualMicroUsd: number | null; upperBoundMicroUsd: number }[]
}): number {
  return snapshot.operations.reduce((sum, operation) => {
    if (operation.actualMicroUsd !== null) return sum + operation.actualMicroUsd
    return sum + operation.upperBoundMicroUsd
  }, 0)
}

function committedMicroUsd(store: CampaignBudgetStore): number {
  return committedMicroUsdFromSnapshot(store.readSnapshot())
}

function readPersistedSnapshot(statePath: string) {
  return JSON.parse(readFileSync(statePath, 'utf8')) as {
    operations: { actualMicroUsd: number | null; upperBoundMicroUsd: number; settledUnknown: boolean }[]
  }
}

function blockStoreTransactOnNthCall(store: CampaignBudgetStore, n: number, lockPath: string): void {
  let transactCalls = 0
  const originalTransact = store.transact.bind(store)
  store.transact = (mutate) => {
    transactCalls += 1
    if (transactCalls === n) {
      closeSync(openSync(lockPath, 'wx', 0o600))
    }
    return originalTransact(mutate)
  }
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
  assert.equal(committedMicroUsd(reloaded), 0)
})

function gateThatStopsBeforeWireCheck(
  gate: CampaignDispatchGate,
  control: RunControl,
): CampaignDispatchGate {
  const original = gate.repeatRunControlBeforeFetch.bind(gate)
  return Object.assign(gate, {
    repeatRunControlBeforeFetch(runControl?: RunControl): void {
      control.requestStop({
        owner: control.owner,
        kind: 'cancelled',
        reasonCode: 'cancelled',
        source: 'user',
      })
      original(runControl)
    },
  })
}

test('dispatchAdmittedFetch zero-settles post-handoff stop before fetch callback', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'babel-campaign-physical-prewire-stop-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const owner = randomUUID()
  const statePath = join(root, 'campaign-budget.json')
  const store = new CampaignBudgetStore({
    statePath,
    campaignId: 'pilot',
    limitMicroUsd: PILOT_CAMPAIGN_LIMIT_MICRO_USD,
  })
  const control = createRunControl({ runId: 'run-2', turnId: 'turn-2', generation: 1 })
  const gate = gateThatStopsBeforeWireCheck(
    new CampaignDispatchGate({ campaignId: 'pilot', store, taskOwnerId: owner }),
    control,
  )
  const prepared = qualifiedPreparedRequest()
  const session = new CampaignPhysicalFetchSession({
    campaignMeter: { executionStage: 'chat', gate },
  })
  let physicalFetch = 0
  await assert.rejects(
    () => session.dispatchAdmittedFetch({
      basePrepared: prepared,
      physicalAttemptId: prepared.attempt_id,
      operationId: 'provider_fetch',
      runControl: control,
      fetch: async () => {
        physicalFetch += 1
        return new Response('{}', { status: 200 })
      },
    }),
    (error: unknown) => error instanceof RunStoppedError,
  )
  assert.equal(physicalFetch, 0)
  const operation = store.readSnapshot().operations[0]!
  assert.equal(operation.actualMicroUsd, 0)
  assert.equal(operation.settledUnknown, false)
  assert.equal(committedMicroUsd(store), 0)

  const failedCompleted = {
    inference_id: prepared.request_id,
    provider: 'openrouter' as const,
    model: CAMPAIGN_QUALIFIED_OPENROUTER_MODEL_ID,
    status: 'failed' as const,
    usage_metadata: null,
  }
  session.finalizeInvocation('failed', failedCompleted)
  session.finalizeInvocation('failed', failedCompleted)
  const reloaded = new CampaignBudgetStore({
    statePath,
    campaignId: 'pilot',
    limitMicroUsd: PILOT_CAMPAIGN_LIMIT_MICRO_USD,
  })
  const reloadedGate = new CampaignDispatchGate({ campaignId: 'pilot', store: reloaded, taskOwnerId: owner })
  assert.equal(reloaded.readSnapshot().operations[0]?.actualMicroUsd, 0)
  assert.equal(committedMicroUsd(reloaded), 0)
  reloadedGate.settleZeroForProvableNoWire({
    executionStage: 'chat',
    requestId: prepared.request_id,
    attemptId: prepared.attempt_id,
  })
  assert.equal(committedMicroUsd(reloaded), 0)
})

test('gate window pre-wire zero-settle persistence failure poisons without releasing hold', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'babel-campaign-gate-zero-poison-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const statePath = join(root, 'campaign-budget.json')
  const lockPath = `${statePath}.lock`
  const store = new CampaignBudgetStore({
    statePath,
    campaignId: 'pilot',
    limitMicroUsd: PILOT_CAMPAIGN_LIMIT_MICRO_USD,
  })
  blockStoreTransactOnNthCall(store, 2, lockPath)
  const gate = new CampaignDispatchGate({ campaignId: 'pilot', store, taskOwnerId: randomUUID() })
  const prepared = qualifiedPreparedRequest()
  const control = createRunControl({ runId: 'run-poison-1', turnId: 'turn-poison-1', generation: 1 })
  control.requestStop({
    owner: control.owner,
    kind: 'cancelled',
    reasonCode: 'cancelled',
    source: 'user',
  })
  await assert.rejects(
    () => gate.admitBeforeDispatch({
      executionStage: 'chat',
      preparedRequest: prepared,
      runControl: control,
    }),
    (error: unknown) => error instanceof CampaignBudgetDeniedError,
  )
  assert.equal(gate.isLedgerPoisoned(), true)
  assert.equal(existsSync(`${statePath}.poison`), true)
  const persisted = readPersistedSnapshot(statePath)
  const operation = persisted.operations[0]!
  assert.equal(operation.actualMicroUsd, null)
  assert.equal(committedMicroUsdFromSnapshot(persisted), operation.upperBoundMicroUsd)
  try { unlinkSync(lockPath) } catch { /* empty */ }
  const restarted = new CampaignDispatchGate({
    campaignId: 'pilot',
    store: new CampaignBudgetStore({
      statePath,
      campaignId: 'pilot',
      limitMicroUsd: PILOT_CAMPAIGN_LIMIT_MICRO_USD,
    }),
    taskOwnerId: randomUUID(),
  })
  await assert.rejects(
    () => restarted.admitBeforeDispatch({ executionStage: 'chat', preparedRequest: qualifiedPreparedRequest() }),
    (error: unknown) => error instanceof CampaignBudgetDeniedError,
  )
})

test('physical session zero-settle persistence failure poisons without releasing hold', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'babel-campaign-physical-zero-poison-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const statePath = join(root, 'campaign-budget.json')
  const lockPath = `${statePath}.lock`
  const owner = randomUUID()
  const store = new CampaignBudgetStore({
    statePath,
    campaignId: 'pilot',
    limitMicroUsd: PILOT_CAMPAIGN_LIMIT_MICRO_USD,
  })
  blockStoreTransactOnNthCall(store, 2, lockPath)
  const control = createRunControl({ runId: 'run-poison-2', turnId: 'turn-poison-2', generation: 1 })
  const gate = gateThatStopsBeforeWireCheck(
    new CampaignDispatchGate({ campaignId: 'pilot', store, taskOwnerId: owner }),
    control,
  )
  const prepared = qualifiedPreparedRequest()
  const session = new CampaignPhysicalFetchSession({
    campaignMeter: { executionStage: 'chat', gate },
  })
  let physicalFetch = 0
  await assert.rejects(
    () => session.dispatchAdmittedFetch({
      basePrepared: prepared,
      physicalAttemptId: prepared.attempt_id,
      operationId: 'provider_fetch',
      runControl: control,
      fetch: async () => {
        physicalFetch += 1
        return new Response('{}', { status: 200 })
      },
    }),
    (error: unknown) => error instanceof CampaignBudgetDeniedError,
  )
  assert.equal(physicalFetch, 0)
  assert.equal(gate.isLedgerPoisoned(), true)
  assert.equal(existsSync(`${statePath}.poison`), true)
  const persisted = readPersistedSnapshot(statePath)
  const operation = persisted.operations[0]!
  assert.equal(operation.actualMicroUsd, null)
  assert.equal(committedMicroUsdFromSnapshot(persisted), operation.upperBoundMicroUsd)
  try { unlinkSync(lockPath) } catch { /* empty */ }
  const restarted = new CampaignDispatchGate({
    campaignId: 'pilot',
    store: new CampaignBudgetStore({
      statePath,
      campaignId: 'pilot',
      limitMicroUsd: PILOT_CAMPAIGN_LIMIT_MICRO_USD,
    }),
    taskOwnerId: randomUUID(),
  })
  await assert.rejects(
    () => restarted.admitBeforeDispatch({ executionStage: 'chat', preparedRequest: qualifiedPreparedRequest() }),
    (error: unknown) => error instanceof CampaignBudgetDeniedError,
  )
})

test('physical session stop after fetch callback entered keeps unknown exposure', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'babel-campaign-physical-callback-stop-'))
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
  const control = createRunControl({ runId: 'run-3', turnId: 'turn-3', generation: 1 })
  const stop = {
    owner: control.owner,
    kind: 'cancelled' as const,
    reasonCode: 'cancelled',
    source: 'user' as const,
  }
  let physicalFetch = 0
  await assert.rejects(
    () => session.dispatchAdmittedFetch({
      basePrepared: prepared,
      physicalAttemptId: prepared.attempt_id,
      operationId: 'provider_fetch',
      runControl: control,
      fetch: async () => {
        physicalFetch += 1
        throw new RunStoppedError(stop)
      },
    }),
    (error: unknown) => error instanceof RunStoppedError,
  )
  assert.equal(physicalFetch, 1)
  const operation = store.readSnapshot().operations[0]!
  assert.equal(operation.actualMicroUsd, null)
  assert.equal(operation.settledUnknown, true)
  assert.equal(committedMicroUsd(store), operation.upperBoundMicroUsd)

  const failedCompleted = {
    inference_id: prepared.request_id,
    provider: 'openrouter' as const,
    model: CAMPAIGN_QUALIFIED_OPENROUTER_MODEL_ID,
    status: 'failed' as const,
    usage_metadata: null,
  }
  session.finalizeInvocation('failed', failedCompleted)
  session.finalizeInvocation('failed', failedCompleted)
  const statePath = join(root, 'campaign-budget.json')
  const reloaded = new CampaignBudgetStore({
    statePath,
    campaignId: 'pilot',
    limitMicroUsd: PILOT_CAMPAIGN_LIMIT_MICRO_USD,
  })
  const reloadedGate = new CampaignDispatchGate({ campaignId: 'pilot', store: reloaded, taskOwnerId: owner })
  const reloadedOp = reloaded.readSnapshot().operations[0]!
  assert.equal(reloadedOp.settledUnknown, true)
  assert.equal(committedMicroUsd(reloaded), reloadedOp.upperBoundMicroUsd)
  reloadedGate.settleUnknownOnTransportFailure({
    executionStage: 'chat',
    requestId: prepared.request_id,
    attemptId: prepared.attempt_id,
  })
  assert.equal(committedMicroUsd(reloaded), reloadedOp.upperBoundMicroUsd)
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
  assert.equal(store.readSnapshot().operations.length, 1)
  const operation = store.readSnapshot().operations[0]!
  assert.equal(operation.actualMicroUsd, null)
  assert.equal(operation.settledUnknown, true)
  assert.ok(operation.upperBoundMicroUsd > 0)
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
