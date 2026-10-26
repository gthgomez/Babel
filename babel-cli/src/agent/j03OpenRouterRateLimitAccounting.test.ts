import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { ChatEngine } from './chatEngine.js'
import { resolveModelByKey } from '../modelPolicy.js'
import { OpenRouterApiRunner } from '../runners/openRouterApi.js'
import { CampaignBudgetStore } from '../eval/campaign-budget-store.js'
import { CampaignDispatchGate } from '../runners/campaignDispatchGate.js'
import { PILOT_CAMPAIGN_LIMIT_MICRO_USD } from '../eval/campaign-budget.js'
import { CAMPAIGN_QUALIFIED_OPENROUTER_MODEL_ID } from '../eval/campaign-qualified-routes.js'
import { globalCostTracker } from '../services/costTracker.js'
import { attachSessionAdmissionStore } from '../interactive/execution/chatTransport.js'

const babelRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

function seedFiniteCampaignEngine(t: test.TestContext): {
  root: string
  owner: string
  store: CampaignBudgetStore
  engine: ChatEngine
} {
  const root = mkdtempSync(join(tmpdir(), 'babel-j03-rate-limit-'))
  mkdirSync(join(root, 'src'), { recursive: true })
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const owner = randomUUID()
  const store = new CampaignBudgetStore({
    statePath: join(root, 'campaign-budget.json'),
    campaignId: 'pilot',
    limitMicroUsd: PILOT_CAMPAIGN_LIMIT_MICRO_USD,
  })
  const gate = new CampaignDispatchGate({ campaignId: 'pilot', store, taskOwnerId: owner })
  const policy = resolveModelByKey({
    key: 'deepseek-v4-flash-openrouter',
    babelRoot,
    liveOnly: true,
  })
  assert.equal(policy.providerModelId, CAMPAIGN_QUALIFIED_OPENROUTER_MODEL_ID)
  const runner = new OpenRouterApiRunner(policy.providerModelId, {}, {
    explicitCredential: 'synthetic-fixture',
    env: { OPENROUTER_API_KEY: 'synthetic-fixture' },
  })
  const engine = new ChatEngine({
    task: 'Say ok',
    projectRoot: root,
    model: policy.resolvedBackendKey,
    providerRunner: runner,
    providerPolicy: policy,
    campaignDispatchGate: gate,
    maxCostUsd: 2,
    maxTurns: 12,
  })
  attachSessionAdmissionStore(engine)
  const allowance = (engine as unknown as { taskAllowance: { taskOwnerId: string } }).taskAllowance
  allowance.taskOwnerId = owner
  return { root, owner, store, engine }
}

test('J03: OpenRouter HTTP 429 with incomplete task accounting blocks retry and fallback', async (t) => {
  const priorOffline = process.env['BABEL_OFFLINE']
  const priorCompaction = process.env['BABEL_COMPACTION']
  const priorMaxCost = process.env['BABEL_CHAT_MAX_COST']
  process.env['BABEL_OFFLINE'] = '1'
  process.env['BABEL_COMPACTION'] = 'off'
  delete process.env['BABEL_CHAT_MAX_COST']
  globalCostTracker.resetSession()
  t.after(() => {
    globalCostTracker.resetSession()
    if (priorOffline === undefined) delete process.env['BABEL_OFFLINE']
    else process.env['BABEL_OFFLINE'] = priorOffline
    if (priorCompaction === undefined) delete process.env['BABEL_COMPACTION']
    else process.env['BABEL_COMPACTION'] = priorCompaction
    if (priorMaxCost === undefined) delete process.env['BABEL_CHAT_MAX_COST']
    else process.env['BABEL_CHAT_MAX_COST'] = priorMaxCost
  })

  const { owner, store, engine } = seedFiniteCampaignEngine(t)
  const priorInferenceId = 'j03-prior-inference'
  const priorRequestId = 'j03-logical-request'
  const priorAttemptId = 'attempt-1'
  const priorLogicalChargeId = `${priorInferenceId}:${priorAttemptId}`
  globalCostTracker.recordUnknownCharge(CAMPAIGN_QUALIFIED_OPENROUTER_MODEL_ID, {
    taskOwnerId: owner,
    chargeId: priorLogicalChargeId,
    requestId: priorRequestId,
    attemptId: priorAttemptId,
  })
  const chargeIdsBeforeSubmit = [...globalCostTracker.getTaskChargeIds(owner)].sort()
  let physicalFetch = 0
  const saved = globalThis.fetch
  globalThis.fetch = async () => {
    physicalFetch++
    return new Response(JSON.stringify({ error: { message: 'rate limited' } }), {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'retry-after': '0',
      },
    })
  }
  t.after(() => {
    globalThis.fetch = saved
  })

  const { consumeChatStream } = await import('../interactive/execution/chatCore.js')
  const events = []
  for await (const event of engine.submitMessageStream('Say ok', 'explain')) {
    events.push(event)
  }

  assert.equal(physicalFetch, 1, 'must not dispatch a fallback or retry physical fetch')
  assert.ok(!events.some((event) => event.type === 'thought' && /Failover|fallback model/i.test(String((event as { text?: string }).text ?? ''))))

  const terminal = events.at(-1)!
  assert.equal(terminal.type, 'failed')
  assert.equal(terminal.outcome, 'INFRA_FAILURE')
  assert.equal(terminal.reason_code, 'cost_accounting_incomplete')
  const terminalError = String((terminal as { error?: string }).error ?? '')
  assert.match(
    terminalError,
    /Provider retry blocked by task allowance|COST_ACCOUNTING_INCOMPLETE:/,
    'terminal must preserve authoritative accounting denial, not a generic provider transport label',
  )
  assert.doesNotMatch(
    terminalError,
    /^\[deepInfraApi\] HTTP 429/,
    'accounting denial must not be replaced by bare HTTP 429 text that could route to fallback',
  )
  assert.doesNotMatch(JSON.stringify(terminal), /budget_exhausted|Failover|fallback model/i)

  const summary = globalCostTracker.getTaskSummary(owner)
  const allowance = engine.getTaskAllowanceSnapshot()
  assert.equal(summary.costComplete, false)
  assert.ok(
    (summary.unknownChargeCount ?? 0) >= 1 ||
      (allowance?.consumed.unknownChargeCount ?? 0) >= 1,
    'unknown liability must be retained',
  )

  const observations = globalCostTracker.getTaskChargeObservations(owner)
  const logicalKey = (requestId: string | undefined, attemptId: string | undefined) =>
    `${requestId ?? ''}\0${attemptId ?? ''}`
  const priorLogicalKey = logicalKey(priorRequestId, priorAttemptId)
  assert.equal(
    observations.filter(
      (row) => logicalKey(row.attribution.requestId, row.attribution.attemptId) === priorLogicalKey,
    ).length,
    1,
    'prior request:attempt unknown must remain a single logical charge after late completion',
  )
  assert.equal(
    globalCostTracker.getTaskChargeIds(owner).filter((id) => id === priorLogicalChargeId).length,
    1,
  )
  const chargeIdsAfter = [...globalCostTracker.getTaskChargeIds(owner)].sort()
  for (const id of chargeIdsBeforeSubmit) {
    assert.equal(chargeIdsAfter.filter((entry) => entry === id).length, 1)
  }

  assert.equal(store.readSnapshot().operations.length, 1, 'no phantom campaign retry operation')

  const parity = (engine as unknown as {
    parity: {
      sessionEvents: {
        events: Array<{
          kind: string
          outcome?: string
          attempt?: number
          status?: string
          failure_receipt?: { details?: { status?: number } }
        }>
      }
    }
  }).parity.sessionEvents.events
  const retrySettled = parity.filter((event) => event.kind === 'provider_retry_settled')
  assert.ok(retrySettled.some((event) => event.outcome === 'failed'), 'scheduled retry must settle failed, not started')
  assert.ok(
    parity.some((event) => event.kind === 'provider_retry_scheduled' && event.attempt === 2),
    'rate-limit retry must be scheduled before accounting stop',
  )

  const deliveries = parity.filter((event) => event.kind === 'model_result_delivery')
  assert.equal(deliveries.length, 1, 'primary invocation must complete exactly once')
  assert.equal(deliveries[0]?.status, 'failed')
  const delivery = deliveries[0] as { http_status?: number; failure_class?: string }
  assert.equal(delivery.http_status, 429)
  assert.equal(delivery.failure_class, 'HTTP_429')
  assert.equal(terminal.reason_code, 'cost_accounting_incomplete', 'user-visible stop is accounting incomplete')
  assert.equal(delivery.http_status, 429, 'primary provider receipt retains HTTP 429 alongside accounting stop')
})
