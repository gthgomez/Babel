import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { ResolvedModelPolicy } from '../modelPolicy.js'
import type { OpenCodeGoBudget } from '../runners/openCodeGoBudget.js'
import {
  isSyntheticProviderFixtureReady, prepareSyntheticProviderFixture,
  removeSyntheticProviderFixture, summarizeSyntheticProviderOutput,
} from '../testinfra/synthetic-provider-fixture.mjs'

if (!isSyntheticProviderFixtureReady()) {
  test('Go Chat provider contracts execute in a synthetic-only subprocess', async t => {
    const isolated = prepareSyntheticProviderFixture()
    const child = spawn(process.execPath, [
      '--import', new URL('../testinfra/synthetic-provider-fixture.mjs', import.meta.url).href,
      '--import', import.meta.resolve('tsx'), '--test-reporter=tap', '--test', fileURLToPath(import.meta.url),
    ], { cwd: isolated.cwd, env: isolated.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', chunk => { output += String(chunk) })
    child.stderr.on('data', chunk => { output += String(chunk) })
    const code = await new Promise<number>(resolve => {
      child.once('error', () => resolve(1))
      child.once('close', value => resolve(value ?? 1))
    })
    // Preserve scalar test inventory without serializing a runner, environment or raw failure.
    const diagnostic = summarizeSyntheticProviderOutput(output, code)
    t.diagnostic(diagnostic)
    assert.equal(code, 0, 'isolated Go provider regression subprocess must pass')
    const inventory = JSON.parse(diagnostic) as { tests: number; passed: number; failed: number; skipped: number }
    assert.equal(inventory.tests, 14, 'all fourteen provider contracts must execute')
    assert.equal(inventory.passed, 14)
    assert.equal(inventory.failed, 0)
    assert.equal(inventory.skipped, 0)
    removeSyntheticProviderFixture(isolated.root)
  })
} else {
  // Dynamic imports happen only after environment, home, config and transport validation.
  const { resolveChatEngineLimits } = await import('../config/chatEngineLimits.js')
  const { ChatEngine } = await import('./chatEngine.js')
  const { resolveChatModelPolicy } = await import('./chatModelPolicy.js')
  const {
    resolveChatDeliberationRunner, resolveChatSynthesisRunner,
    resolveChatFallbackRunner, resolveChatFallbackOrFail,
  } = await import('./chatEngineProviderRuntime.js')
  const { OpenCodeGoApiRunner } = await import('../runners/openCodeGoApi.js')
  const { OpenCodeGoBudget, OpenCodeGoBudgetError } = await import('../runners/openCodeGoBudget.js')
  const { loadModelPolicyConfig } = await import('../modelPolicy.js')
  const { BABEL_RUNS_DIR } = await import('../cli/constants.js')
  const { getProviderSpec } = await import('../runners/providerRegistry.js')
  const { OpenRouterApiRunner } = await import('../runners/openRouterApi.js')
  const { resolveOrCreateCriticRunner, resolveOrCreateCriticProRunner } = await import('./chatEngineCriticBudget.js')
  const { MODEL_PRICING_REGISTRY } = await import('../services/modelPricingRegistry.js')

  const backendKey = 'opencode-go-deepseek-v4-flash'
  const modelId = 'deepseek-v4-flash'
  const currentBackendKey = 'opencode-go/deepseek-v4.1-flash'
  const goPolicy = { provider: 'opencode-go', providerModelId: modelId } as ResolvedModelPolicy
  const codingTask = "Fix `add(a, b)` so it returns the sum for the finite numeric inputs covered by this repository's tests. Inspect the implementation and tests, make the smallest production-code repair, run the required tests, and report the changed files and actual verification result. Do not change the tests, package scripts, or unrelated files. Do not install dependencies or use project network access."

  function fixture(t: TestContext): { root: string; runId: string } {
    const root = mkdtempSync(join(tmpdir(), 'babel-go-chat-'))
    const runId = `go-chat-${randomUUID()}`
    const keys = ['BABEL_OFFLINE', 'BABEL_OPENCODE_GO_HELPER', 'BABEL_MODEL_POLICY_PATH',
      'BABEL_CHAT_INVESTIGATE_MODEL', 'BABEL_CHAT_MUTATE_MODEL', 'BABEL_READ_ONLY',
      'OPENROUTER_API_KEY', 'DEEPSEEK_API_KEY', 'BABEL_DIFF_CRITIC_MODEL',
      'BABEL_DIFF_CRITIC_PRO_MODEL', 'BABEL_DIFF_CRITIC', 'BABEL_HEADLESS', 'BABEL_LIVE']
    const previous = new Map(keys.map(key => [key, process.env[key]]))
    const priorFetch = globalThis.fetch
    t.after(() => {
      globalThis.fetch = priorFetch
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      rmSync(root, { recursive: true, force: true })
      rmSync(join(BABEL_RUNS_DIR, 'chat-sessions', runId), { recursive: true, force: true })
    })
    delete process.env['BABEL_OFFLINE']
    delete process.env['BABEL_MODEL_POLICY_PATH']
    delete process.env['BABEL_READ_ONLY']
    process.env['OPENROUTER_API_KEY'] = 'synthetic-router-credential'
    process.env['DEEPSEEK_API_KEY'] = 'synthetic-deepseek-credential'
    const config = structuredClone(loadModelPolicyConfig().config)
    config.models![backendKey] = { provider: 'opencode-go', model_id: modelId,
      tier: 'standard', enabled: true, experimental: true }
    config.models!['unqualified-go-model'] = { provider: 'opencode-go', model_id: 'mimo-v2.5',
      tier: 'standard', enabled: true }
    const policyPath = join(root, 'model-policy.json')
    writeFileSync(policyPath, JSON.stringify(config))
    process.env['BABEL_MODEL_POLICY_PATH'] = policyPath
    const helper = join(root, 'auth-helper.cjs')
    writeFileSync(helper, "process.stdout.write('synthetic-go-credential')\n")
    process.env['BABEL_OPENCODE_GO_HELPER'] = helper
    // All transport is controlled; unexpected calls cannot reach a real provider.
    globalThis.fetch = (async () => { throw new Error('unexpected provider dispatch') }) as typeof fetch
    return { root, runId }
  }

  test('explicit supported Go Chat route resolves without relaxing other live routes', t => {
    fixture(t)
    const { policy, offline } = resolveChatModelPolicy({ model: backendKey })
    assert.equal(offline, false)
    assert.equal(policy.provider, 'opencode-go')
    assert.equal(policy.providerModelId, modelId)
    assert.ok(policy.stagePolicies.every(stage => stage.primaryProvider === 'opencode-go' &&
      stage.primaryProviderModelId === modelId && stage.orderedBackends.length === 1))
    assert.throws(() => resolveChatModelPolicy({ model: 'unqualified-go-model' }), /LIVE_MODEL_POLICY/)
    assert.equal(resolveChatModelPolicy({}).policy.provider, 'openrouter')
  })

  test('configured current Go Flash route resolves exact 4.1 identity without substitution', t => {
    fixture(t)
    const { policy } = resolveChatModelPolicy({ model: currentBackendKey })
    assert.equal(policy.provider, 'opencode-go')
    assert.equal(policy.providerModelId, 'deepseek-v4.1-flash')
    assert.ok(policy.stagePolicies.every(stage => stage.primaryProvider === 'opencode-go' &&
      stage.primaryProviderModelId === 'deepseek-v4.1-flash' && stage.orderedBackends.length === 1))
  })

  test('current Go Flash factory preserves its native required-budget failure', t => {
    fixture(t)
    const { policy } = resolveChatModelPolicy({ model: currentBackendKey })
    for (const create of [resolveChatDeliberationRunner, resolveChatSynthesisRunner]) {
      let failureCode: string | null = null
      try { create(null, policy) } catch (error) {
        failureCode = (error as { code?: string }).code ?? null
      }
      assert.equal(failureCode, 'GO_BUDGET_DENIED', 'missing native budget must deny before credential dispatch')
    }
  })

  test('ordinary Go Chat shares one native task budget across primary, synthesis and critic, then fences a fresh task', async t => {
    const { root, runId } = fixture(t)
    const engine = new ChatEngine({ task: codingTask, projectRoot: root, model: currentBackendKey, runId })
    const internal = engine as unknown as {
      resolveDeliberationRunner(): InstanceType<typeof OpenCodeGoApiRunner>
      synthesizeAnswer(observations: string, callbacks: {}): Promise<string>
      startIndependentTaskCostScope(): void
    }
    const reservations: Array<InstanceType<typeof OpenCodeGoBudget>> = []
    const original = OpenCodeGoBudget.prototype.reserve
    // Observe the real caller-owned objects; injected denial prevents inference.
    // This proves wiring and owner fencing, not durable reservation behavior.
    OpenCodeGoBudget.prototype.reserve = async function () {
      reservations.push(this)
      throw new OpenCodeGoBudgetError()
    }
    t.after(() => { OpenCodeGoBudget.prototype.reserve = original })
    assert.equal(engine.getTaskAllowanceSnapshot()?.goReservationRequired, undefined)
    const primary = internal.resolveDeliberationRunner()
    assert.equal(engine.getTaskAllowanceSnapshot()?.goReservationRequired, true)
    await assert.rejects(primary.executeRaw('primary'), /budget denied/i)
    await assert.rejects(internal.synthesizeAnswer('observed tools', {}), /budget denied/i)
    const critic = resolveOrCreateCriticRunner('deepseek-v4.1-flash', null,
      () => internal.resolveDeliberationRunner(), 'opencode-go').runner
    await assert.rejects(critic.executeRaw('critic'), /budget denied/i)
    assert.equal(reservations.length, 3)
    assert.ok(reservations.every(budget => budget === reservations[0]))
    internal.startIndependentTaskCostScope()
    assert.equal(engine.getTaskAllowanceSnapshot()?.goReservationRequired, undefined)
    const successor = internal.resolveDeliberationRunner()
    assert.ok(successor !== primary, 'cached runner must not retain the previous task budget')
    assert.notEqual(successor.getLastOpenCodeSessionId(), primary.getLastOpenCodeSessionId())
    await assert.rejects(successor.executeRaw('successor'), /budget denied/i)
    assert.ok(reservations[3] !== reservations[0])
    assert.throws(() => reservations[0]!.assertCurrentAuthority(), /budget denied/i)
    reservations[3]!.assertCurrentAuthority()
    OpenCodeGoBudget.prototype.reserve = original
    // Real Windows persistence and transport admission use separate native tests.
  })

  test('ordinary Go Chat refuses missing durable task authority before credential lookup', t => {
    const { root, runId } = fixture(t)
    const engine = new ChatEngine({ task: codingTask, projectRoot: root, model: currentBackendKey, runId })
    const internal = engine as unknown as {
      taskCostScopeUnavailable: boolean
      resolveDeliberationRunner(): InstanceType<typeof OpenCodeGoApiRunner>
    }
    internal.taskCostScopeUnavailable = true
    delete process.env['BABEL_OPENCODE_GO_HELPER']
    let code: string | null = null
    try { internal.resolveDeliberationRunner() } catch (error) { code = (error as { code?: string }).code ?? null }
    assert.equal(code, 'GO_BUDGET_DENIED')
  })

  test('Go task keeps its reservation owner through valid allowance renewal and cold resume', t => {
    const { root, runId } = fixture(t)
    const engine = new ChatEngine({ task: codingTask, projectRoot: root, model: currentBackendKey, runId, maxCostUsd: 1 })
    engine.applyUserSubmission({ userInput: codingTask })
    const ownerAccess = (value: InstanceType<typeof ChatEngine>) => value as unknown as {
      taskAllowanceOwner: { resolveGoRunnerOptions(): { budget: InstanceType<typeof OpenCodeGoBudget> } }
    }
    const budget = ownerAccess(engine).taskAllowanceOwner.resolveGoRunnerOptions().budget
    const before = engine.getTaskAllowanceSnapshot()!
    budget.assertCurrentAuthority()
    engine.renewAllowance({ grantId: 'go-renewal', provenance: 'operator:synthetic-renewal', costCapUsd: 2,
      wallCapMs: before.grant.wallCapMs, turnCap: before.grant.turnCap })
    assert.equal(ownerAccess(engine).taskAllowanceOwner.resolveGoRunnerOptions().budget, budget)
    assert.equal(engine.getTaskAllowanceSnapshot()?.taskOwnerId, before.taskOwnerId)
    budget.assertCurrentAuthority()
    const resumed = new ChatEngine({ task: codingTask, projectRoot: root, model: currentBackendKey, runId,
      maxCostUsd: 1, resumeExisting: true })
    assert.equal(resumed.getTaskAllowanceSnapshot()?.taskOwnerId, before.taskOwnerId)
    assert.equal(resumed.getTaskAllowanceSnapshot()?.grant.grantId, 'go-renewal')
    assert.deepEqual(resumed.getTaskAllowanceSnapshot()?.grant.costCap, { kind: 'finite', usd: 2 })
    ownerAccess(resumed).taskAllowanceOwner.resolveGoRunnerOptions().budget.assertCurrentAuthority()
  })

  function controlledCurrentRunner(): InstanceType<typeof OpenCodeGoApiRunner> {
    // Controlled source regression only: no durable-reservation or product proof.
    // The transport's native Windows/missing-budget gates have separate real tests.
    const budget = { reserve: async () => {}, assertCurrentAuthority: () => {} } as unknown as OpenCodeGoBudget
    return new OpenCodeGoApiRunner('deepseek-v4.1-flash', {}, { budget })
  }

  test('Go secondary critics keep the current primary transport and model', async t => {
    fixture(t)
    const runner = controlledCurrentRunner()
    const stale = new OpenRouterApiRunner('z-ai/glm-5.3-flash')
    const requests: Array<{ url: string; model: string }> = []
    globalThis.fetch = (async (input, init) => {
      const body = JSON.parse(String(init?.body)) as { model: string }
      requests.push({ url: String(input), model: body.model })
      if (String(input) !== 'https://opencode.ai/zen/go/v1/chat/completions') throw new Error('unexpected synthetic endpoint')
      return Response.json({ model: body.model,
        choices: [{ message: { content: '{"verdict":"reject","confidence":0.9,"reasons":["verification absent"]}' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 } })
    }) as typeof fetch
    for (const resolve of [resolveOrCreateCriticRunner, resolveOrCreateCriticProRunner]) {
      const result = resolve('deepseek-v4.1-flash', stale, () => runner, 'opencode-go')
      assert.ok(result.runner === runner, 'secondary calls must use the current Go owner, ignoring stale cache')
      await result.runner.executeRaw('review the patch')
    }
    assert.equal(requests.length, 2)
    assert.ok(requests.every(request => request.url === 'https://opencode.ai/zen/go/v1/chat/completions' &&
      request.model === 'deepseek-v4.1-flash'))
  })

  test('Go critic refuses a mismatched current runner instead of using another provider/model', t => {
    fixture(t)
    const wrongProvider = new OpenRouterApiRunner('z-ai/glm-5.3-flash')
    const wrongModel = new OpenCodeGoApiRunner('deepseek-v4-flash')
    for (const runner of [wrongProvider, wrongModel]) {
      assert.throws(() => resolveOrCreateCriticRunner('deepseek-v4.1-flash', null,
        () => runner, 'opencode-go'), /refuses provider\/model substitution/)
    }
  })

  test('controlled current Go write and explicitly exercised owner critic keep every request on the pinned route', async t => {
    const { root, runId } = fixture(t)
    // CostTracker estimates from its model registry, not response metadata.
    // This temporary accounting-only entry represents zero-cost synthetic
    // responses. It does not register production Go pricing or change routing.
    const syntheticKey = 'opencode-go:deepseek-v4.1-flash'
    const priorPricing = MODEL_PRICING_REGISTRY[syntheticKey]
    MODEL_PRICING_REGISTRY[syntheticKey] = { provider: 'opencode-go', modelId: 'deepseek-v4.1-flash',
      inputCostPer1M: 0, outputCostPer1M: 0, sourceUrl: 'fixture:synthetic-only', verifiedAt: 'synthetic-fixture' }
    t.after(() => { if (priorPricing) MODEL_PRICING_REGISTRY[syntheticKey] = priorPricing
      else delete MODEL_PRICING_REGISTRY[syntheticKey] })
    mkdirSync(join(root, 'src'))
    const target = join(root, 'src/add.js')
    writeFileSync(target, 'export function add(a, b) { return a - b }\n')
    process.env['BABEL_LIVE'] = '1'
    process.env['BABEL_HEADLESS'] = '1'
    process.env['BABEL_DIFF_CRITIC_MODEL'] = 'deepseek-v4-pro'
    process.env['BABEL_DIFF_CRITIC_PRO_MODEL'] = 'deepseek-v4-pro'
    const requests: Array<{ url: string; model: string; stream: boolean }> = []
    let primaryRequests = 0
    let criticRequests = 0
    globalThis.fetch = (async (input, init) => {
      const body = JSON.parse(String(init?.body)) as { model: string; stream?: boolean }
      requests.push({ url: String(input), model: body.model, stream: body.stream === true })
      if (String(input) !== 'https://opencode.ai/zen/go/v1/chat/completions') throw new Error('unexpected synthetic endpoint')
      if (body.stream !== true) {
        criticRequests++
        return Response.json({ model: body.model,
          choices: [{ message: { content: '{"verdict":"reject","confidence":0.9,"reasons":["required verification has not run"]}' } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 } })
      }
      primaryRequests++
      if (primaryRequests > 3) throw new Error('controlled primary proposals exhausted')
      const delta = primaryRequests < 3 ? {
        tool_calls: [{ index: 0, id: `go-write-journey-${primaryRequests}`, type: 'function',
          function: { name: primaryRequests === 1 ? 'read_file' : 'write_file',
            arguments: JSON.stringify(primaryRequests === 1 ? { path: target }
              : { path: target, content: 'export function add(a, b) { return a + b }\n' }) } }],
      } : { content: 'The production edit is present; required verification has not run.' }
      const frame = { model: body.model, choices: [{ delta,
        finish_reason: primaryRequests < 3 ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5 } }
      return new Response(`data: ${JSON.stringify(frame)}\n\ndata: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream' } })
    }) as typeof fetch
    const engine = new ChatEngine({ task: codingTask, projectRoot: root, model: currentBackendKey,
      providerRunner: controlledCurrentRunner(), runId })
    const internal = engine as unknown as {
      limits: { maxTurns: number; maxCostUsd: number; maxWallMs: number; stallTurns: number }
      runAsymmetricDiffCritic: (answer: string, callbacks: {}, intent: 'execute') => Promise<'allow' | 'reject' | 'block'>
    }
    // Go follows the accepted task's native tune, including the constructor's
    // task classification; the provider does not replace it with raw defaults.
    const nativeLimits = resolveChatEngineLimits({}, undefined, { taskText: codingTask })
    assert.equal(internal.limits.maxTurns, nativeLimits.maxTurns)
    assert.equal(internal.limits.maxCostUsd, nativeLimits.maxCostUsd)
    assert.equal(internal.limits.maxWallMs, nativeLimits.maxWallMs)
    assert.equal(internal.limits.stallTurns, nativeLimits.stallTurns)
    const eventTypes: string[] = []
    let ownerCriticExercised = false
    for await (const event of engine.submitMessageStream(codingTask, 'execute')) {
      eventTypes.push(event.type)
      if (event.type === 'tool_complete' && event.tool === 'write_file' && !event.error && !ownerCriticExercised) {
        assert.equal(readFileSync(target, 'utf8'), 'export function add(a, b) { return a + b }\n')
        // Required verification deliberately has not run, so ordinary completion
        // correctly refuses before critic. Exercise the actual engine-owned
        // critic branch at this observed settled-write barrier, without a fake
        // verifier receipt or changing completion policy. This is wiring proof,
        // not an automatically reached completed product journey.
        ownerCriticExercised = true
        const decision = await internal.runAsymmetricDiffCritic('Required verification has not run.', {}, 'execute')
        assert.ok(decision === 'reject' || decision === 'block')
      }
    }
    t.diagnostic(JSON.stringify({ primaryRequests, criticRequests, requestIdentities: requests,
      eventTypes, ownerCriticExercised, unknownChargeCount: engine.getTaskAllowanceSnapshot()?.consumed.unknownChargeCount ?? null }))
    assert.equal(readFileSync(target, 'utf8'), 'export function add(a, b) { return a + b }\n')
    assert.ok(primaryRequests >= 3, 'real inspection/write/result continuation must execute')
    assert.ok(ownerCriticExercised && criticRequests >= 1, 'engine-owned critic must dispatch after the observed write')
    assert.ok(requests.every(request => request.url === 'https://opencode.ai/zen/go/v1/chat/completions' &&
      request.model === 'deepseek-v4.1-flash'), 'every observed request must keep exact current Go identity')
  })

  test('Go Chat deliberation and synthesis use the approved helper and pinned transport', t => {
    fixture(t)
    assert.ok(resolveChatDeliberationRunner(null, goPolicy) instanceof OpenCodeGoApiRunner)
    assert.ok(resolveChatSynthesisRunner(null, goPolicy) instanceof OpenCodeGoApiRunner)
  })

  test('Go Chat refuses configured and generic cross-provider fallbacks', async t => {
    fixture(t)
    assert.ok(resolveChatFallbackRunner(null, { fallbackModel: 'deepseek-v4-pro' }, goPolicy) === null,
      'Go must not construct a different provider fallback')
    let fallbackResolved = false
    const stream = resolveChatFallbackOrFail({
      err: new Error('temporary interruption'), turn: 0, ownerGeneration: 1,
      options: { model: backendKey }, modelPolicy: goPolicy,
      isSubmissionCurrent: () => true, cancelled: () => null,
      failed: error => ({ type: 'failed', error }),
      tryFailover: () => ({ fromModel: 'deepseek-v4-pro', toModel: 'deepseek-v4-flash',
        reason: 'retry', countsAsVerification: false }),
      resolveFallback: () => { fallbackResolved = true; return null }, installFailover: () => {},
    })
    const first = await stream.next()
    assert.equal(first.done, false)
    if (!first.done) {
      assert.equal(first.value.type, 'failed')
      if (first.value.type === 'failed') assert.match(first.value.error, /Go route refuses provider substitution/)
    }
    assert.equal(fallbackResolved, false)
    assert.equal((await stream.next()).value, null)
  })

  test('Go Chat ignores phase overrides and keeps native task limits', t => {
    const { root, runId } = fixture(t)
    process.env['BABEL_CHAT_INVESTIGATE_MODEL'] = 'deepseek-v4-pro'
    process.env['BABEL_CHAT_MUTATE_MODEL'] = 'deepseek-v4-pro'
    const engine = new ChatEngine({ task: codingTask, projectRoot: root, model: backendKey, runId })
    const internal = engine as unknown as {
      _lastPhase: 'investigate' | 'mutate'; resolveRoutedRunner: () => unknown;
      limits: { maxTurns: number; maxCostUsd: number; maxWallMs: number; stallTurns: number }
    }
    internal._lastPhase = 'investigate'
    const runner = internal.resolveRoutedRunner()
    assert.ok(runner instanceof OpenCodeGoApiRunner)
    internal._lastPhase = 'mutate'
    assert.ok(internal.resolveRoutedRunner() === runner, 'Go phases must retain the pinned runner')
    // Go follows the accepted task's native tune, including the constructor's
    // task classification; the provider does not replace it with raw defaults.
    const nativeLimits = resolveChatEngineLimits({}, undefined, { taskText: codingTask })
    assert.equal(internal.limits.maxTurns, nativeLimits.maxTurns)
    assert.equal(internal.limits.maxCostUsd, nativeLimits.maxCostUsd)
    assert.equal(internal.limits.maxWallMs, nativeLimits.maxWallMs)
    // Chat's constructor passes no model to native limit resolution; the CLI
    // preflight projection's DeepSeek scaling is not the engine's actual setting.
    assert.equal(internal.limits.stallTurns, nativeLimits.stallTurns)
  })

  for (const [label, key, provider, expectedModel, endpoint] of [
    ['Go', backendKey, 'opencode-go', modelId, 'https://opencode.ai/zen/go/v1/chat/completions'],
    ['OpenRouter control', 'glm-5.3-flash', 'openrouter', 'z-ai/glm-5.3-flash', 'https://openrouter.ai/api/v1/chat/completions'],
  ] as const) test(`${label} native proposals retain explicit read-only authority and deliver denied results`, async t => {
    const { root, runId } = fixture(t)
    // Mechanics-only provider seam. Ordinary Windows Go remains denied by its
    // native reservation guard, exercised above and in transport controls.
    const syntheticKey = `opencode-go:${expectedModel}`
    const priorPricing = MODEL_PRICING_REGISTRY[syntheticKey]
    if (provider === 'opencode-go') {
      MODEL_PRICING_REGISTRY[syntheticKey] = { provider: 'opencode-go', modelId: expectedModel,
        inputCostPer1M: 0, outputCostPer1M: 0, sourceUrl: 'fixture:synthetic-only', verifiedAt: 'synthetic-fixture' }
      t.after(() => { if (priorPricing) MODEL_PRICING_REGISTRY[syntheticKey] = priorPricing
        else delete MODEL_PRICING_REGISTRY[syntheticKey] })
    }
    // The raw engine seam does not create an ordinary CLI prepared turn. Supply
    // the same explicit read-only authority used by installed mechanics, rather
    // than pretending a model/user phrase mints a capability restriction.
    process.env['BABEL_READ_ONLY'] = 'true'
    const target = join(root, 'fixture.txt')
    writeFileSync(target, 'unchanged\n')
    const bodies: Array<Record<string, unknown>> = []
    globalThis.fetch = (async (input, init) => {
      assert.equal(String(input), endpoint)
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      assert.equal(body.model, expectedModel)
      bodies.push(body)
      const delta = bodies.length === 1 ? {
        tool_calls: [{ index: 0, id: 'go-denied-write', type: 'function',
          function: { name: 'write_file', arguments: JSON.stringify({ path: target, content: 'forbidden' }) } }],
      } : { content: 'The requested write was denied; the file is unchanged.' }
      const frame = { model: expectedModel, choices: [{ delta, finish_reason: bodies.length === 1 ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }
      return new Response(`data: ${JSON.stringify(frame)}\n\ndata: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream' } })
    }) as typeof fetch
    const engine = new ChatEngine({ task: 'Explain this file without changing it.',
      projectRoot: root, model: key, runId,
      ...(provider === 'opencode-go' ? { providerRunner: new OpenCodeGoApiRunner(expectedModel, {},
        { budget: { reserve: async () => {}, assertCurrentAuthority: () => {} } as unknown as OpenCodeGoBudget }) } : {}) })
    for await (const _event of engine.submitMessageStream('Explain this file without changing it.', 'explain')) { /* drain */ }
    assert.equal(readFileSync(target, 'utf8'), 'unchanged\n')
    assert.equal(bodies.length, 2)
    const messages = bodies[1]!['messages'] as Array<{ role: string; tool_call_id?: string; content: string }>
    const denial = messages.find(message => message.tool_call_id === 'go-denied-write')
    assert.equal(denial?.role, 'tool')
    assert.match(denial?.content ?? '', /denied|read.only|not allowed|READ_ONLY/i)
    const events = engine.getParityRuntime().sessionEvents.events
    const input = events.find(event => event.kind === 'model_input_receipt')
    assert.equal(input?.kind === 'model_input_receipt' ? input.provider : null, provider)
    const result = events.find(event => event.kind === 'model_result_delivery')
    assert.equal(result?.kind === 'model_result_delivery' ? result.observed_model_id : null, expectedModel)
    assert.equal(getProviderSpec('opencode-go').authorityConformance, 'certified')
  })
}
