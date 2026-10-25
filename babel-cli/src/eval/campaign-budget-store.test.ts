import assert from 'node:assert/strict'
import { fork, type ChildProcess } from 'node:child_process'
import { closeSync, openSync, unlinkSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { CampaignBudgetStore } from './campaign-budget-store.js'

const workerPath = fileURLToPath(new URL('./campaign-budget-store.worker.mjs', import.meta.url))

function startWorker(statePath: string): ChildProcess {
  return fork(workerPath, [statePath], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    execArgv: ['--import', 'tsx/esm'],
    cwd: fileURLToPath(new URL('.', import.meta.url)),
  })
}

test('sync and async transact both persist when started together under barrier', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'babel-campaign-store-race-'))
  const statePath = join(root, 'ledger.json')
  let child: ChildProcess | null = null
  t.after(() => {
    if (child && child.exitCode === null && !child.killed) {
      child.kill('SIGTERM')
    }
    rmSync(root, { recursive: true, force: true })
  })
  child = startWorker(statePath)
  const stderrChunks: string[] = []
  child.stderr?.on('data', (chunk) => { stderrChunks.push(String(chunk)) })
  const ready = once(child, 'message')
  const [message] = await Promise.race([
    ready,
    once(child, 'exit').then(([code]) => {
      throw new Error(`child exited before ready (${code}): ${stderrChunks.join('')}`)
    }),
  ])
  assert.equal((message as { type?: string }).type, 'ready')
  const store = new CampaignBudgetStore({
    statePath,
    campaignId: 'pilot',
    limitMicroUsd: 10_000,
  })
  const childDone = once(child, 'exit')
  child.send({ type: 'go' })
  store.transact((budget) => {
    budget.reserve('sync-op', 100)
  })
  const [exitCode] = await Promise.race([
    childDone,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`child join timeout: ${stderrChunks.join('')}`)), 15_000)
    }),
  ])
  assert.equal(exitCode, 0, stderrChunks.join(''))
  const snapshot = store.readSnapshot()
  assert.equal(snapshot.operations.length, 2)
  const ids = snapshot.operations.map((operation) => operation.operationId)
  assert.ok(ids.some((id) => id.endsWith('async-op')))
  assert.ok(ids.some((id) => id.includes('sync-op')))
})

test('settlement persistence failure poisons gate and blocks later dispatch without task scope', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'babel-campaign-store-poison-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const statePath = join(root, 'ledger.json')
  const lockPath = `${statePath}.lock`
  const store = new CampaignBudgetStore({
    statePath,
    campaignId: 'pilot',
    limitMicroUsd: 10_000,
  })
  const { CampaignDispatchGate } = await import('../runners/campaignDispatchGate.js')
  const { prepareProviderRequest } = await import('../runners/preparedProviderRequest.js')
  const { LIVE_OPENROUTER_MODEL_ID } = await import('../modelPolicy.js')
  const gate = new CampaignDispatchGate({ campaignId: 'pilot', store, taskOwnerId: 'owner-1' })
  const prepared = prepareProviderRequest({
    body: JSON.stringify({ model: LIVE_OPENROUTER_MODEL_ID, messages: [{ role: 'user', content: 'hi' }], max_tokens: 16 }),
    mode: 'text',
    provider: 'openrouter',
    requestedModelId: LIVE_OPENROUTER_MODEL_ID,
    reservedCompletionTokens: 16,
  })
  await gate.admitBeforeDispatch({ executionStage: 'chat', preparedRequest: prepared })
  closeSync(openSync(lockPath, 'wx', 0o600))
  assert.throws(
    () => gate.settleFromCompleted({
      executionStage: 'chat',
      requestId: prepared.request_id,
      attemptId: prepared.attempt_id,
      completed: {
        inference_id: prepared.request_id,
        provider: 'openrouter',
        model: LIVE_OPENROUTER_MODEL_ID,
        status: 'delivered',
        usage_metadata: {
          provider: 'openrouter',
          provider_model_id: LIVE_OPENROUTER_MODEL_ID,
          latency_ms: 1,
          prompt_tokens: 1,
          completion_tokens: 1,
          total_tokens: 2,
          provider_reported_total_charge_usd: 0.000001,
          estimated_cost_usd: 0.000001,
          cost_precision: 'exact',
        },
      },
    }),
  )
  assert.equal(gate.isLedgerPoisoned(), true)
  try { unlinkSync(lockPath) } catch { /* empty */ }
  await assert.rejects(
    () => gate.admitBeforeDispatch({ executionStage: 'chat', preparedRequest: prepared }),
  )
})

test('second campaign gate process fails closed after durable poison from persist failure', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'babel-campaign-store-second-owner-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const statePath = join(root, 'ledger.json')
  const lockPath = `${statePath}.lock`
  const store = new CampaignBudgetStore({
    statePath,
    campaignId: 'pilot',
    limitMicroUsd: 10_000,
  })
  const { CampaignDispatchGate } = await import('../runners/campaignDispatchGate.js')
  const { prepareProviderRequest } = await import('../runners/preparedProviderRequest.js')
  const { LIVE_OPENROUTER_MODEL_ID } = await import('../modelPolicy.js')
  const ownerA = 'owner-a'
  const gateA = new CampaignDispatchGate({ campaignId: 'pilot', store, taskOwnerId: ownerA })
  const prepared = prepareProviderRequest({
    body: JSON.stringify({ model: LIVE_OPENROUTER_MODEL_ID, messages: [{ role: 'user', content: 'hi' }], max_tokens: 16 }),
    mode: 'text',
    provider: 'openrouter',
    requestedModelId: LIVE_OPENROUTER_MODEL_ID,
    reservedCompletionTokens: 16,
  })
  await gateA.admitBeforeDispatch({ executionStage: 'chat', preparedRequest: prepared })
  closeSync(openSync(lockPath, 'wx', 0o600))
  assert.throws(() => gateA.settleFromCompleted({
    executionStage: 'chat',
    requestId: prepared.request_id,
    attemptId: prepared.attempt_id,
    completed: {
      inference_id: prepared.request_id,
      provider: 'openrouter',
      model: LIVE_OPENROUTER_MODEL_ID,
      status: 'delivered',
      usage_metadata: {
        provider: 'openrouter',
        provider_model_id: LIVE_OPENROUTER_MODEL_ID,
        latency_ms: 1,
        prompt_tokens: 1,
        completion_tokens: 1,
        total_tokens: 2,
        provider_reported_total_charge_usd: 0.000001,
        estimated_cost_usd: 0.000001,
        cost_precision: 'exact',
      },
    },
  }))
  try { unlinkSync(lockPath) } catch { /* empty */ }
  const ownerB = 'owner-b'
  const gateB = new CampaignDispatchGate({ campaignId: 'pilot', store, taskOwnerId: ownerB })
  await assert.rejects(
    () => gateB.admitBeforeDispatch({ executionStage: 'chat', preparedRequest: prepared }),
  )
})
