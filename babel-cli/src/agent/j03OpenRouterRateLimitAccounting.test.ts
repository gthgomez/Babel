import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { ChatEngine } from './chatEngine.js'
import { resolveChatModelPolicy } from './chatModelPolicy.js'
import { OpenRouterApiRunner } from '../runners/openRouterApi.js'
import { CampaignBudgetStore } from '../eval/campaign-budget-store.js'
import { CampaignDispatchGate } from '../runners/campaignDispatchGate.js'
import { globalCostTracker } from '../services/costTracker.js'
import { createChatEngineForSession } from '../interactive/execution/chatTransport.js'
import { chatSessionDir } from '../cli/runsLayout.js'

const babelRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const task = 'Inspect this repository and identify the stale entries in REPO_MAP.md. Report corrections without editing files.'

test('fresh finite Chat: OpenRouter 429 cannot dispatch a fallback after accounting stops retry', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'babel-j03-fresh-429-'))
  const projectRoot = join(root, 'project')
  mkdirSync(join(projectRoot, 'apps', 'web'), { recursive: true })
  mkdirSync(join(projectRoot, 'packages', 'api'), { recursive: true })
  writeFileSync(join(projectRoot, 'apps', 'web', 'main.mjs'), 'export const app = true\n')
  writeFileSync(join(projectRoot, 'packages', 'api', 'server.mjs'), 'export const server = true\n')
  writeFileSync(join(projectRoot, 'REPO_MAP.md'), '# Repository map\n- src/client\n- src/server\n')
  execFileSync('git', ['init', '-q', projectRoot])
  execFileSync('git', ['-C', projectRoot, 'add', '.'])
  execFileSync('git', ['-C', projectRoot, '-c', 'user.name=Fixture',
    '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false',
    'commit', '-qm', 'fixture'])

  // Restore ordinary production defaults, never substitute unlimited accounting
  // or disable native execution/critic/compaction. Only the artifact root is isolated.
  const keys = [
    'BABEL_RUNS_DIR', 'BABEL_OFFLINE', 'BABEL_COMPACTION',
    'BABEL_DESKTOP_PROVIDER', 'BABEL_DESKTOP_MODEL_ROUTE',
    'BABEL_NATIVE_TOOLS', 'BABEL_TOOL_PROFILE',
    'BABEL_CHAT_MAX_COST', 'BABEL_CHAT_MAX_TURNS', 'BABEL_CHAT_MAX_WALL_MS',
    'BABEL_CHAT_LONG_TASK', 'BABEL_CHAT_TASK_CLASS',
  ] as const
  const previous = new Map(keys.map(key => [key, process.env[key]]))
  for (const key of keys) delete process.env[key]
  process.env['BABEL_RUNS_DIR'] = join(root, 'runs')
  const savedFetch = globalThis.fetch
  let engine: ChatEngine | undefined
  globalCostTracker.resetSession()
  t.after(() => {
    engine?.closeAdmissionStore()
    globalThis.fetch = savedFetch
    globalCostTracker.resetSession()
    for (const key of keys) {
      const value = previous.get(key)
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(root, { recursive: true, force: true })
  })

  const { policy, offline } = resolveChatModelPolicy({
    model: 'deepseek-v4-flash-openrouter', babelRoot,
  })
  assert.equal(offline, false)
  assert.equal(policy.provider, 'openrouter')
  assert.equal(policy.providerModelId, 'deepseek/deepseek-v4-flash-0731')
  const runner = new OpenRouterApiRunner(policy.providerModelId, {}, {
    explicitCredential: 'synthetic-fixture', env: {},
  })
  const store = new CampaignBudgetStore({
    statePath: join(root, 'campaign-budget.json'),
    campaignId: 'fresh-429', limitMicroUsd: 4_290_000,
  })
  const gate = new CampaignDispatchGate({
    campaignId: 'fresh-429', store, taskOwnerId: randomUUID(),
  })
  let physicalFetch = 0
  globalThis.fetch = async (input) => {
    assert.equal(String(input), 'https://openrouter.ai/api/v1/chat/completions')
    physicalFetch++
    if (physicalFetch === 1) {
      return new Response(JSON.stringify({ error: { code: 429, message: 'fixture rate limit' } }), {
        status: 429, headers: { 'Content-Type': 'application/json' },
      })
    }
    // Only unfixed code reaches this successful, same-model response. It allows
    // the baseline to expose the extra fetch without relying on repeated 429s.
    const frame = {
      model: policy.providerModelId,
      choices: [{
        delta: { tool_calls: [{
          index: 0, id: 'call_fixture_read', type: 'function',
          function: { name: 'read_file',
            arguments: JSON.stringify({ path: join(projectRoot, 'REPO_MAP.md') }) },
        }] },
        finish_reason: 'tool_calls',
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.00001 },
    }
    return new Response(`data: ${JSON.stringify(frame)}\n\ndata: [DONE]\n\n`, {
      headers: { 'Content-Type': 'text/event-stream' },
    })
  }

  engine = await createChatEngineForSession({
    task, projectRoot, runId: randomUUID(), model: 'deepseek-v4-flash-openrouter',
    providerRunner: runner, providerPolicy: policy,
    operation: 'READ_ONLY', runtimeMode: 'direct', campaignDispatchGate: gate,
  }, options => new ChatEngine(options))
  const initial = engine.getTaskAllowanceSnapshot()
  assert.ok(initial)
  assert.deepEqual(initial.grant.costCap, { kind: 'finite', usd: 2 })
  assert.equal(initial.grant.turnCap, 120)
  assert.equal(initial.grant.wallCapMs, 720_000)
  assert.deepEqual(globalCostTracker.getTaskChargeIds(initial.taskOwnerId), [])
  assert.equal(existsSync(join(root, 'campaign-budget.json')), false, 'fresh campaign has no prior admission file')

  const result = await engine.submitMessage(task, {
    onThought: () => {}, onAnswerChunk: () => {},
  }, 'explain')

  // Keep this first: the same unchanged test on f3eb must fail here with 2,
  // not at an assertion depending on newly introduced production helpers.
  assert.equal(physicalFetch, 1, 'fresh 429 must not trigger another physical fetch')
  assert.equal(result.status, 'failed')
  assert.equal(result.reason_code, 'cost_accounting_incomplete')
  assert.equal(result.cause_class, 'harness')
  assert.notEqual(result.budgetExceeded, true)

  // Submission may create its own task owner. Read that public snapshot rather
  // than overwriting private owner identity or injecting a pre-existing charge.
  const allowance = engine.getTaskAllowanceSnapshot()
  assert.ok(allowance)
  assert.deepEqual(allowance.grant.costCap, { kind: 'finite', usd: 2 })
  const charges = globalCostTracker.getTaskChargeObservations(allowance.taskOwnerId)
  const summary = globalCostTracker.getTaskSummary(allowance.taskOwnerId)
  assert.equal(charges.length, 1)
  assert.equal(charges[0]!.knownCostUSD, null)
  assert.equal(summary.unknownChargeCount, 1)
  assert.equal(summary.costComplete, false)
  const operations = store.readSnapshot().operations
  assert.equal(operations.length, 1)
  assert.equal(operations[0]!.actualMicroUsd, null)
  assert.equal(operations[0]!.settledUnknown, true)

  const events = readFileSync(join(chatSessionDir(engine.getEngineRunId()), 'session-events.jsonl'), 'utf8')
    .trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
  const inputs = events.filter(event => event.kind === 'model_input_receipt')
  const dispatches = events.filter(event =>
    event.kind === 'model_invocation_phase' && event.phase === 'request_dispatched')
  const scheduled = events.filter(event => event.kind === 'provider_retry_scheduled')
  const settled = events.filter(event => event.kind === 'provider_retry_settled')
  const deliveries = events.filter(event => event.kind === 'model_result_delivery')
  assert.equal(inputs.length, 1, 'no fallback logical invocation')
  assert.equal(dispatches.length, 1, 'scheduled retry never reached wire')
  assert.equal(scheduled.length, 1)
  assert.equal(scheduled[0]!.attempt, 2)
  assert.equal(scheduled[0]!.reason, 'rate_limit')
  assert.equal(settled.length, 1)
  assert.equal(settled[0]!.attempt_id, scheduled[0]!.attempt_id)
  assert.equal(settled[0]!.outcome, 'failed')
  assert.equal(deliveries.length, 1)
  assert.equal(deliveries[0]!.inference_id, inputs[0]!.inference_id)
  assert.equal(deliveries[0]!.status, 'failed')
  assert.equal(deliveries[0]!.http_status, 429)
  assert.equal(deliveries[0]!.failure_class, 'HTTP_429')
  assert.equal(charges[0]!.attribution.requestId, inputs[0]!.request_id)
  assert.equal(charges[0]!.attribution.attemptId, inputs[0]!.attempt_id)
  assert.notEqual(charges[0]!.attribution.attemptId, scheduled[0]!.attempt_id)
})
