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
import { LIVE_OPENROUTER_MODEL_ID } from '../modelPolicy.js'

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
  const model = LIVE_OPENROUTER_MODEL_ID
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
      model: LIVE_OPENROUTER_MODEL_ID,
      choices: [{ message: { content: 'ok' } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.00001 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  t.after(() => { globalThis.fetch = saved })
  const model = LIVE_OPENROUTER_MODEL_ID
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
    onInvocationCompleted: (event) => {
      gate.settleFromCompleted({
        executionStage: 'critic',
        requestId,
        attemptId,
        completed: event,
      })
    },
  })
  assert.equal(physicalFetch, 1)
  assert.equal(store.readSnapshot().operations.length, 1)
})
