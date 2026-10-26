/** Real ChatEngine/provider/action path; host effects stop at the injected executor. */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test, { mock, type TestContext } from 'node:test'
import type { ProviderInvocationCompleted, RunnerCallbacks, ToolStreamEvent } from '../runners/base.js'
import type { ResolvedModelPolicy } from '../modelPolicy.js'
import type { ToolExecutor } from './toolExecutor.js'
import {
  isSyntheticProviderFixtureReady, prepareSyntheticProviderFixture,
  removeSyntheticProviderFixture, summarizeSyntheticProviderOutput,
} from '../testinfra/synthetic-provider-fixture.mjs'

if (!isSyntheticProviderFixtureReady()) {
  test('stop admission runs the actual engine in a credential-free synthetic process', async t => {
    const fixture = prepareSyntheticProviderFixture()
    t.after(() => removeSyntheticProviderFixture(fixture.root))
    const child = spawn(process.execPath, [
      '--import', new URL('../testinfra/synthetic-provider-fixture.mjs', import.meta.url).href,
      '--import', import.meta.resolve('tsx'), '--test', '--test-reporter=tap', fileURLToPath(import.meta.url),
    ], { cwd: fixture.cwd, env: fixture.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', chunk => { output += String(chunk) })
    child.stderr.on('data', chunk => { output += String(chunk) })
    const code = await new Promise<number>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', code => resolve(code ?? 1))
    })
    t.diagnostic(summarizeSyntheticProviderOutput(output, code))
    if (code !== 0) t.diagnostic(JSON.stringify({ failureSourceLines: [...new Set([...output.matchAll(/chat-engine-stop-admission\.test\.ts:(\d+):\d+/g)].map(match => Number(match[1])))].slice(0, 20) }))
    // Only authored numeric facts cross the child boundary, never raw errors,
    // provider objects, paths, output text or synthetic credential canaries.
    for (const match of output.matchAll(/^\s*# STOP_(?:PROBE|FAILURE) (\{.*\})\r?$/gm)) {
      try {
        const fact: { caseId?: unknown; physicalStarts?: unknown; modelStarts?: unknown; sourceLines?: unknown; failureHints?: unknown } = JSON.parse(match[1]!)
        if (['serial', 'parallel', 'quoted_marker', 'ordinary', 'provider_cancel', 'approval_race', 'governed_replace', 'governed_patch'].includes(String(fact.caseId)) && Number.isInteger(fact.physicalStarts) && Number.isInteger(fact.modelStarts)) {
          t.diagnostic(JSON.stringify({ caseId: fact.caseId, physicalStarts: fact.physicalStarts, modelStarts: fact.modelStarts,
            ...(Array.isArray(fact.sourceLines) && fact.sourceLines.every(line => typeof line === 'string' && /^[A-Za-z0-9_-]+\.ts:\d+$/.test(line)) ? { sourceLines: fact.sourceLines.slice(0, 10) } : {}),
            ...(Array.isArray(fact.failureHints) && fact.failureHints.every(hint => ['admission', 'compaction', 'wire', 'token', 'provider', 'tool', 'persistence', 'authority', 'schema', 'timeout', 'budget', 'invariant', 'undefined', 'synthesis', 'turn'].includes(hint)) ? { failureHints: fact.failureHints } : {}),
          }))
        }
      } catch { /* Raw child diagnostics are deliberately not exported. */ }
    }
    assert.equal(code, 0)
  })
} else {
  const { ChatEngine } = await import('./chatEngine.js')
  const { AgentSession } = await import('./session.js')
  const { executeActionWithPolicy, getCircuitBreakerState } = await import('./toolExecutor.js')
  const { chatReadToolExecutor } = await import('./chatReadExecutor.js')
  const { DeepInfraApiRunner } = await import('../runners/deepInfraApi.js')
  const { DeepSeekApiRunner } = await import('../runners/deepSeekApi.js')
  const { OpenCodeGoApiRunner } = await import('../runners/openCodeGoApi.js')
  const { OpenCodeGoBudget } = await import('../runners/openCodeGoBudget.js')
  const { createParityRuntime, parityOnUserTurn, paritySettleProposeTools, paritySettleToolStarted, paritySettleToolNotStarted } = await import('./chatEngineParityBridge.js')
  const { recordToolTerminal } = await import('./sessionEvents.js')
  const { createRunControl, RunStoppedError } = await import('../runtime/run-control.js')
  const { globalCostTracker } = await import('../services/costTracker.js')
  const { CompactionManager, LLMSummarizeCompaction } = await import('./chatCompaction.js')
  const { openAdmissionStore } = await import('../runtime/admission.js')
  const { ConfirmDialog } = await import('../ui/dialog.js')
  const { executeTool } = await import('../localTools.js')
  type Engine = InstanceType<typeof ChatEngine>
  const policy: ResolvedModelPolicy = {
    policyPath: 'stop-fixture', family: 'stop-fixture', selectedTier: 'cheap', resolvedBackendKey: 'stop-fixture',
    provider: 'deepinfra', providerModelId: 'stop-fixture-model', expensive: false, enabled: true,
    experimental: true, blockedWithoutExplicitOptIn: false, approximateInputTokens: 0, approximateOutputTokens: 0,
    warnings: [], waterfall: [], stagePolicies: [], contextWindow: 128_000, contextLimit: 128_000,
    maxOutputTokens: 4096, nativeToolUse: true,
  }
  process.env['BABEL_BENCHMARK_MODE'] = '1'
  process.env['BABEL_BENCHMARK_AUTO_APPROVE'] = '1'
  process.env['BABEL_EXECUTION_PROFILE'] = 'dev_local'
  process.env['BABEL_ALLOW_HOST_FALLBACK'] = '1'
  process.env['BABEL_DRY_RUN'] = '0'
  process.env['BABEL_DRY_RUN_SOURCE'] = 'session'
  process.env['BABEL_DIFF_CRITIC'] = '0'
  process.env['BABEL_COMPACTION'] = 'off'

  async function scenario(t: TestContext, caseId: 'serial' | 'parallel' | 'quoted_marker' | 'ordinary' | 'governed_replace' | 'governed_patch' | 'direct_web'): Promise<{ physicalStarts: number; modelStarts: number; executionRows: number }> {
    const root = mkdtempSync(join(process.env['BABEL_PROJECT_ROOT']!, 'stop-engine-'))
    process.env['BABEL_AUTONOMY_LEASE'] = JSON.stringify({
      version: 2, leaseId: `synthetic-stop-${caseId}`,
      scope: { repository: 'stop-fixture', objective: 'deterministic stop qualification' },
      allowedCapabilities: ['run_arbitrary_code', 'run_local_command', 'run_tests', 'edit_task_files', 'inspect_repository'],
    })
    mkdirSync(join(root, 'src'))
    for (let i = 0; i < 10; i++) writeFileSync(join(root, `src/read-${i}.txt`), `fixture ${i}\n`)
    for (const args of [
      ['init', '-q', '--initial-branch=main'], ['add', '--', 'src'],
      ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Synthetic stop fixture'],
    ]) {
      const result = spawnSync('git', args, { cwd: root, windowsHide: true, encoding: 'utf8' })
      assert.equal(result.status, 0)
    }
    let physicalStarts = 0
    let modelStarts = 0
    let engine: Engine
    const executor: ToolExecutor = {
      mapAction: () => [],
      async execute(action) {
        physicalStarts++
        const first = physicalStarts === 1
        const stopRequest = first && ['serial', 'parallel'].includes(caseId) ? {
          owner: { runId: `stop-${caseId}`, turnId: engine.getParityRuntime().turnId!, generation: engine['activeSubmissionGeneration'] },
          kind: 'blocked' as const, reasonCode: 'fixture_requested_stop', source: 'executor' as const,
        } : undefined
        return {
          action, terminal: false,
          results: [{ exit_code: 0, stdout: caseId === 'quoted_marker' && first ? 'Documentation quotes CIRCUIT_BREAKER as an enum label.' : 'ordinary fixture result', stderr: '' }],
          ...(stopRequest ? { stopRequest } : {}),
        }
      },
    }
    const calls: ToolStreamEvent[] = caseId === 'parallel'
      ? Array.from({ length: 10 }, (_, index) => ({ type: 'tool_use', id: `read-${index}`, name: 'read_file', input: { path: `src/read-${index}.txt` } }))
      : [0, 1].map(index => ({ type: 'tool_use', id: `command-${index}`, name: 'run_command', input: { command: `node -e "void ${index}"` } }))
    if (caseId === 'parallel') calls.push({ type: 'tool_use', id: 'following-command', name: 'run_command', input: { command: 'node -e "void 0"' } })
    if (caseId === 'governed_replace') calls[0] = { type: 'tool_use', id: 'governed-edit', name: 'str_replace', input: { file_path: 'src/read-0.txt', old_str: 'fixture 0', new_str: 'changed fixture' } }
    if (caseId === 'governed_patch') calls[0] = { type: 'tool_use', id: 'governed-edit', name: 'apply_patch', input: { patch: '--- a/src/read-0.txt\n+++ b/src/read-0.txt\n@@ -1 +1 @@\n-fixture 0\n+changed fixture\n' } }
    if (caseId.startsWith('governed_')) calls.splice(1)
    if (caseId === 'direct_web') { calls[0] = { type: 'tool_use', id: 'prevented-web', name: 'web_fetch', input: { url: 'https://fixture.invalid/source' } }; calls.splice(1) }
    const runner = {
      async *executeWithToolsStream(): AsyncGenerator<ToolStreamEvent> {
        if (modelStarts++ === 0) {
          for (const call of calls) yield call
          yield { type: 'done', finishReason: 'tool_calls' }
        } else {
          yield { type: 'text_delta', text: 'I inspected the fixture; no source changes were made.' }
          yield { type: 'done', finishReason: 'stop' }
        }
      },
      async execute() { modelStarts++; return { type: 'completion', answer: 'Fixture stopped.' } },
      async executeRaw() { modelStarts++; return 'Fixture stopped.' },
      getLastInvocationMetadata() { return null },
      buildNativeToolsWireBody(messages: unknown, tools: unknown, _system?: string, options?: { stream?: boolean }) {
        return JSON.stringify({ model: policy.providerModelId, max_tokens: 4096, messages, tools, stream: options?.stream ?? true })
      },
      getNativeRequestReservedCompletionTokens() { return 4096 },
    }
    engine = new ChatEngine({ task: 'Implement the deterministic stop fixture', projectRoot: root, runId: `stop-${caseId}`,
      operation: 'CHANGE', model: 'deepseek-v4-flash', providerRunner: runner as never, providerPolicy: policy,
      toolExecutorForTesting: executor, maxTurns: 6, maxWallMs: 20_000,
    })
    if (caseId.startsWith('governed_')) {
      for (let i = 0; i < 6; i++) await executeActionWithPolicy({ type: 'run_command', command: 'node -e "void 0"' }, 'workspace_write',
        { runId: `stop-${caseId}`, agentId: 'fixture', babelRoot: root, projectRoot: root },
        { mode: 'chat', isolationRequired: true, isolationAvailable: false, hostFallbackAllowed: false })
      assert.equal(getCircuitBreakerState(`stop-${caseId}`).tripped, true)
    }
    let persistedWebIntent = false
    if (caseId === 'direct_web') {
      const persist = engine['persistToolStartedAtExecutorDispatch'].bind(engine)
      engine['persistToolStartedAtExecutorDispatch'] = (action, meta) => {
        persist(action, meta)
        if (action.type === 'web_fetch') { persistedWebIntent = true; engine.cancel() }
      }
    }
    const events = []
    try {
      for await (const event of engine.submitMessageStream('Implement the deterministic stop fixture. Run the supplied inspection commands first.')) events.push(event)
    } catch (error) {
      let cause: unknown = error
      let stack = ''
      for (let depth = 0; depth < 4 && cause instanceof Error; depth++) { stack += `\n${cause.stack ?? ''}`; cause = cause.cause }
      const sourceLines = [...new Set([...stack.matchAll(/[\\/]([A-Za-z0-9_-]+\.ts):(\d+):\d+/g)].map(match => `${match[1]}:${match[2]}`))]
      t.diagnostic(`STOP_FAILURE ${JSON.stringify({ caseId, physicalStarts, modelStarts, sourceLines })}`)
      throw error
    }
    const failureText = events.filter(event => event.type === 'failed').map(event => event.error).join(' ').toLowerCase()
    const failureHints = ['admission', 'compaction', 'wire', 'token', 'provider', 'tool', 'persistence', 'authority', 'schema', 'timeout', 'budget', 'invariant', 'undefined', 'synthesis', 'turn'].filter(hint => failureText.includes(hint))
    t.diagnostic(`STOP_PROBE ${JSON.stringify({ caseId, physicalStarts, modelStarts, failureHints })}`)
    assert.equal(events.filter(event => ['done', 'failed', 'cancelled'].includes(event.type)).length, 1)
    if (caseId === 'direct_web') assert.equal(persistedWebIntent, true)
    return { physicalStarts, modelStarts, executionRows: engine['toolCallLog'].length }
  }

  test('C01 typed serial stop prevents the next physical tool and model start', async t => {
    const facts = await scenario(t, 'serial')
    assert.equal(facts.physicalStarts, 1)
    assert.equal(facts.modelStarts, 1)
  })
  test('C02 parallel typed stop prevents later chunks and following effects despite successful settlements', async t => {
    const facts = await scenario(t, 'parallel')
    // The current engine admits at most six reads in its first parallel chunk.
    assert.ok(facts.physicalStarts >= 1 && facts.physicalStarts <= 6)
    assert.equal(facts.modelStarts, 1)
  })
  test('C03 quoted stop prose cannot suppress a second authorized physical operation', async t => {
    const facts = await scenario(t, 'quoted_marker')
    assert.equal(facts.physicalStarts, 2)
  })
  test('ordinary successful output runs both authorized operations and settles once', async t => {
    const facts = await scenario(t, 'ordinary')
    assert.equal(facts.physicalStarts, 2)
  })
  for (const caseId of ['governed_replace', 'governed_patch'] as const) test(`C01 ${caseId} preserves terminal breaker authority`, async t => {
    const facts = await scenario(t, caseId)
    assert.equal(facts.physicalStarts, 0)
    assert.equal(facts.modelStarts, 1)
  })
  test('C07 a direct web request stopped at persistence is not logged as executed', async t => {
    const facts = await scenario(t, 'direct_web')
    assert.equal(facts.physicalStarts, 0)
    assert.equal(facts.modelStarts, 1)
    assert.equal(facts.executionRows, 0)
  })

  test('objective admission remains usable without starting an execution submission', () => {
    const engine = new ChatEngine({ task: 'Implement the admission fixture.', projectRoot: process.env['BABEL_PROJECT_ROOT']!, runId: 'admission-only',
      model: 'deepseek-v4-flash', providerPolicy: policy, providerRunner: {} as never })
    assert.equal(engine.admitUserSubmission({ userInput: 'Implement the admission fixture.' }, { model: policy.providerModelId, provider: policy.provider }).status, 'committed')
    const firstTurn = engine.getParityRuntime().turnId
    assert.equal(engine.admitUserSubmission({ userInput: 'continue' }, { model: policy.providerModelId, provider: policy.provider }).status, 'committed')
    assert.notEqual(engine.getParityRuntime().turnId, firstTurn)
  })

  test('C04 starting another session cannot clear a different run denial state', async () => {
    const runId = 'stop-owner-denials'
    const root = process.env['BABEL_PROJECT_ROOT']!
    for (let i = 0; i < 6; i++) await executeActionWithPolicy({ type: 'run_command', command: 'node -e "void 0"' }, 'workspace_write',
      { runId, agentId: 'stop-fixture', babelRoot: root, projectRoot: root },
      { mode: 'chat', isolationRequired: true, isolationAvailable: false, hostFallbackAllowed: false })
    assert.equal(getCircuitBreakerState(runId).tripped, true)
    const session = new AgentSession({ verb: 'ask', task: 'A separate startup fixture.', projectRoot: root })
    // Only the new session's business response is replaced. Public run() and
    // real session initialization execute; this test performs no inference.
    const business = session as unknown as { runAsk: () => Promise<unknown> }
    business.runAsk = async () => ({ answer: 'Synthetic startup response.' })
    await session.run()
    assert.equal(getCircuitBreakerState(runId).tripped, true)
    const control = createRunControl({ runId, turnId: 'direct-tool-turn', generation: 1 })
    const denied = await executeTool({ tool: 'file_read', path: 'unused.txt' }, { runId, agentId: 'fixture', babelRoot: root, projectRoot: root, runControl: control })
    assert.equal(denied.exit_code, 1)
    assert.equal(control.stop()?.kind, 'blocked')
  })

  for (const stage of ['chat', 'compaction'] as const) test(`C07 cancellation at ${stage} admission prevents the actual provider fetch`, async t => {
    const savedFetch = globalThis.fetch
    process.env['BABEL_AUTONOMY_LEASE'] = JSON.stringify({ version: 2, leaseId: `synthetic-fetch-${stage}`,
      scope: { repository: 'stop-fixture', objective: 'deterministic compaction cancellation' },
      allowedCapabilities: ['run_arbitrary_code', 'run_local_command', 'run_tests', 'edit_task_files', 'inspect_repository'] })
    const root = mkdtempSync(join(process.env['BABEL_PROJECT_ROOT']!, 'stop-fetch-'))
    writeFileSync(join(root, 'README.md'), 'Synthetic repository.\n')
    for (const args of [['init', '-q', '--initial-branch=main'], ['add', '--', 'README.md'],
      ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Synthetic provider fixture']]) {
      assert.equal(spawnSync('git', args, { cwd: root, windowsHide: true, encoding: 'utf8' }).status, 0)
    }
    let physicalStarts = 0
    let cancellationObserved = false
    const model = stage === 'compaction' ? 'deepseek-ai/DeepSeek-V3-0324' : 'deepseek-v4-flash'
    globalThis.fetch = async () => {
      physicalStarts++
      const delta = stage === 'compaction' && physicalStarts === 1
        ? { tool_calls: [{ index: 0, id: 'before-compaction-read', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'README.md' }) } }] }
        : { content: 'Fixture answer.' }
      const frame = { model, choices: [{ index: 0, delta, finish_reason: stage === 'compaction' && physicalStarts === 1 ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } }
      return new Response(`data: ${JSON.stringify(frame)}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } })
    }
    try {
      const runner = new DeepInfraApiRunner(model, 'UNUSED_FIXTURE_CREDENTIAL', { maxTokens: 128 }, { explicitCredential: 'fixture-only' })
      const opened = openAdmissionStore({ authorizedRoot: root, runDir: join(root, 'admission') })
      assert.equal(opened.ok, true)
      if (!opened.ok) return
      t.after(() => opened.store.close())
      const fixtureTask = stage === 'compaction' ? 'Implement the synthetic compaction fixture.' : 'Explain this repository.'
      const engine = new ChatEngine({ task: fixtureTask, projectRoot: root, runId: `stop-before-fetch-${stage}`,
        operation: stage === 'compaction' ? 'CHANGE' : 'READ_ONLY', model, providerRunner: runner, providerPolicy: { ...policy, providerModelId: model }, maxTurns: 6, admissionStore: opened.store,
        toolExecutorForTesting: { mapAction: () => [], execute: async action => ({ action, terminal: false, results: [{ exit_code: 0, stdout: 'Synthetic inspection.', stderr: '' }] }) } })
      if (stage === 'compaction') {
        process.env['BABEL_COMPACTION'] = 'on'
        process.env['DEEPINFRA_API_KEY'] = 'fixture-only'
        engine['compactionManager'] = new CompactionManager()
        const compact = engine['compactIfNeeded'].bind(engine)
        let seeded = false
        let compactionChecks = 0
        engine['compactIfNeeded'] = async (callbacks, _force, generation, pressure) => {
          if (++compactionChecks === 1) return compact(callbacks, false, generation, pressure)
          if (!seeded) {
            seeded = true
            for (let i = 0; i < 20; i++) engine['conversation'].push({ role: i % 2 ? 'assistant' : 'user', content: 'Synthetic old conversation. '.repeat(1600) })
          }
          try { return await compact(callbacks, true, generation, pressure) } catch (error) {
            const sourceLines = error instanceof Error ? [...new Set([...error.stack?.matchAll(/[\\/]([A-Za-z0-9_-]+\.ts):(\d+):\d+/g) ?? []].map(match => `${match[1]}:${match[2]}`))] : []
            t.diagnostic(`STOP_FAILURE ${JSON.stringify({ caseId: 'provider_cancel', physicalStarts, modelStarts: 0, sourceLines })}`)
            throw error
          }
        }
      }
      const internals = engine as unknown as { providerRetryCallbacks: (context: unknown) => RunnerCallbacks }
      const original = internals.providerRetryCallbacks.bind(engine)
      internals.providerRetryCallbacks = context => {
        const callbacks = original(context)
        return { ...callbacks, onInvocationPhase: event => {
          callbacks.onInvocationPhase?.(event)
          if (event.phase === 'request_dispatched' && (stage === 'chat' || (context as { executionStage: string }).executionStage === 'compaction')) { cancellationObserved = true; engine.cancel() }
        } }
      }
      const events = []
      try {
        for await (const event of engine.submitMessageStream(fixtureTask)) events.push(event)
      } catch (error) {
        let cause = error
        let stack = ''
        for (let depth = 0; depth < 4 && cause instanceof Error; depth++) { stack += `\n${cause.stack ?? ''}`; cause = cause.cause }
        const sourceLines = [...new Set([...stack.matchAll(/[\\/]([A-Za-z0-9_-]+\.ts):(\d+):\d+/g)].map(match => `${match[1]}:${match[2]}`))]
        t.diagnostic(`STOP_FAILURE ${JSON.stringify({ caseId: 'provider_cancel', physicalStarts, modelStarts: 1, sourceLines })}`)
        throw error
      }
      const failureText = events.filter(event => event.type === 'failed').map(event => event.error).join(' ').toLowerCase()
      const failureHints = ['admission', 'compaction', 'wire', 'token', 'provider', 'tool', 'persistence', 'authority', 'schema', 'timeout', 'budget', 'invariant', 'undefined', 'synthesis', 'turn'].filter(hint => failureText.includes(hint))
      if (!cancellationObserved) for (const type of new Set(events.map(event => event.type))) if (['tool_start', 'tool_complete', 'done', 'failed', 'cancelled', 'progress_recovery', 'context_compacted', 'turn_start'].includes(type)) failureHints.push(type)
      t.diagnostic(`STOP_PROBE ${JSON.stringify({ caseId: 'provider_cancel', physicalStarts, modelStarts: Number(cancellationObserved), failureHints })}`)
      assert.equal(cancellationObserved, true)
      assert.equal(physicalStarts, stage === 'chat' ? 0 : 1)
      const allowance = (engine as unknown as { taskAllowance: { taskOwnerId: string } }).taskAllowance
      const cancelSummary = globalCostTracker.getTaskSummary(allowance.taskOwnerId)
      assert.equal(cancelSummary.unknownChargeCount, 0)
      assert.equal(cancelSummary.estimateComplete, true)
      assert.equal(cancelSummary.costComplete, false)
      assert.equal(cancelSummary.completeCostUSD, null)
      if (stage === 'chat') {
        assert.equal(cancelSummary.totalCostUSD, 0)
        assert.equal(cancelSummary.totalInputTokens, 0)
        assert.equal(cancelSummary.totalOutputTokens, 0)
      } else {
        assert.equal(cancelSummary.totalInputTokens, 2)
        assert.equal(cancelSummary.totalOutputTokens, 1)
        assert.ok((cancelSummary.estimatedCostUSD ?? cancelSummary.totalCostUSD) > 0)
      }
      assert.equal(events.filter(event => ['done', 'failed', 'cancelled'].includes(event.type)).length, 1)
    } finally { globalThis.fetch = savedFetch; process.env['BABEL_COMPACTION'] = 'off'; delete process.env['DEEPINFRA_API_KEY'] }
  })

  for (const family of ['compatible', 'deepseek'] as const) for (const delivery of ['raw', 'native'] as const) {
    test(`C07 ${family} ${delivery} retry rechecks the latch at physical fetch entry`, async t => {
      const savedFetch = globalThis.fetch
      const control = createRunControl({ runId: `retry-${family}-${delivery}`, turnId: 'fixture-turn', generation: 1 })
      let physicalStarts = 0
      let phases = 0
      let retries = 0
      let completion: ProviderInvocationCompleted | undefined
      globalThis.fetch = async () => {
        physicalStarts++
        return new Response('{"error":{"message":"Synthetic retryable failure"}}', { status: 503, headers: { 'Retry-After': '0' } })
      }
      try {
        const runner = family === 'compatible'
          ? new DeepInfraApiRunner('deepseek-v4-flash', 'UNUSED_FIXTURE_CREDENTIAL', { maxTokens: 128 }, { explicitCredential: 'fixture-only' })
          : new DeepSeekApiRunner('deepseek-v4-flash', { explicitCredential: 'sk-fixture-only' })
        const callbacks: RunnerCallbacks = {
          runControl: control,
          onInvocationPhase: event => {
            if (event.phase === 'request_dispatched' && ++phases === 2) control.requestStop({ owner: control.owner, kind: 'cancelled', reasonCode: 'cancelled', source: 'user' })
          },
          onRetry: () => { retries++ },
          onInvocationCompleted: event => { completion = event },
        }
        // No AbortSignal argument: the admission latch itself must fence the
        // retry, independently of the transport's external abort listener.
        const request = async (): Promise<void> => {
          if (delivery === 'raw') await runner.executeRaw('Synthetic retry fixture.', callbacks)
          else for await (const _event of runner.executeWithToolsStream([{ role: 'user', content: 'Synthetic retry fixture.' }], [], undefined, undefined, undefined, callbacks)) { /* Drain. */ }
        }
        let rejectedByControl = false
        let sourceLines: string[] = []
        try { await request() } catch (error) {
          rejectedByControl = error instanceof RunStoppedError
          if (error instanceof Error) sourceLines = [...error.stack?.matchAll(/([A-Za-z0-9_-]+\.ts):(\d+):\d+/g) ?? []].map(match => `${match[1]}:${match[2]}`).slice(0, 5)
        }
        t.diagnostic(JSON.stringify({ family, delivery, rejectedByControl, physicalStarts, phases, retries,
          inferenceStarted: completion?.inference_started, actualAttempt: completion?.actual_attempt, sourceLines }))
        assert.equal(rejectedByControl, true)
        assert.equal(phases, 2)
        assert.equal(physicalStarts, 1)
        assert.equal(retries, 1)
        assert.equal(completion?.inference_started, false)
        assert.equal(completion?.actual_attempt, 2)
      } finally { globalThis.fetch = savedFetch }
    })
  }

  for (const race of ['approval', 'late_success'] as const) test(
    race === 'approval' ? 'C06 a superseded engine owner cannot execute an approval released afterward' : 'C04 late successful tool settlement cannot reopen a superseded owner',
    { timeout: 20_000 }, async t => {
    const deferred = () => {
      let resolve!: () => void
      const promise = new Promise<void>(accept => { resolve = accept })
      return { promise, resolve }
    }
    const entered = deferred()
    const release = deferred()
    t.after(() => release.resolve())
    const root = process.env['BABEL_PROJECT_ROOT']!
    process.env['BABEL_AUTONOMY_LEASE'] = JSON.stringify({ version: 2, leaseId: 'synthetic-approval-race',
      scope: { repository: 'stop-fixture', objective: 'deterministic approval race' },
      allowedCapabilities: ['run_arbitrary_code', 'run_local_command', 'run_tests', 'edit_task_files', 'inspect_repository'] })
    let innerStarts = 0
    let modelStarts = 0
    let hadOwner = false
    const executor: ToolExecutor = {
      mapAction: () => [],
      async execute(action, context) {
        hadOwner = !!context.runControl
        if (race === 'late_success') {
          innerStarts++
          entered.resolve()
          await release.promise
          return { action, terminal: false, results: [{ exit_code: 0, stdout: 'Late synthetic success.', stderr: '' }] }
        }
        // An engine-owned handler delegates through the real policy executor;
        // the approval callback is its supported dependency, not a UI claim.
        return executeActionWithPolicy(action, 'workspace_write', context, {
          mode: 'chat', decide: () => 'ask', hostFallbackAllowed: true, isolationAvailable: false,
          onAskApproval: async () => { entered.resolve(); await release.promise; return true },
          executor: { mapAction: () => [], execute: async action => {
            innerStarts++
            return { action, terminal: false, results: [{ exit_code: 0, stdout: 'Synthetic effect.', stderr: '' }] }
          } },
        })
      },
    }
    const runner = {
      async *executeWithToolsStream(): AsyncGenerator<ToolStreamEvent> {
        if (modelStarts++ === 0) {
          yield { type: 'tool_use', id: 'approval-command', name: 'run_command', input: { command: 'node -e "void 0"' } }
          yield { type: 'done', finishReason: 'tool_calls' }
        } else {
          yield { type: 'text_delta', text: 'No source change was made.' }
          yield { type: 'done', finishReason: 'stop' }
        }
      },
      async execute() { return { type: 'completion', answer: 'Synthetic response.' } },
      async executeRaw() { return 'Synthetic response.' },
      getLastInvocationMetadata() { return null },
      buildNativeToolsWireBody(messages: unknown, tools: unknown) { return JSON.stringify({ model: policy.providerModelId, max_tokens: 4096, messages, tools }) },
      getNativeRequestReservedCompletionTokens() { return 4096 },
    }
    const engine = new ChatEngine({ task: 'Implement the approval fixture.', projectRoot: root, runId: `owner-race-${race}`, operation: 'CHANGE',
      model: 'deepseek-v4-flash', providerRunner: runner as never, providerPolicy: policy, toolExecutorForTesting: executor, maxTurns: 6 })
    const oldEvents: string[] = []
    const old = (async () => { for await (const event of engine.submitMessageStream('Implement the approval fixture.')) oldEvents.push(event.type) })()
    await entered.promise
    const oldControl = engine['runControl']!
    let successorControl = oldControl
    let successorStop = oldControl.stop()
    let successorModelStarts = 0
    try {
      const successorEvents: string[] = []
      for await (const event of engine.submitMessageStream('Implement a separate replacement fixture.')) successorEvents.push(event.type)
      assert.equal(successorEvents.filter(type => ['done', 'failed', 'cancelled'].includes(type)).length, 1)
      successorControl = engine['runControl']!
      successorStop = successorControl.stop()
      successorModelStarts = modelStarts
    } finally { release.resolve(); await old }
    assert.equal(hadOwner, true)
    t.diagnostic(`STOP_PROBE ${JSON.stringify({ caseId: 'approval_race', physicalStarts: innerStarts, modelStarts })}`)
    assert.equal(innerStarts, race === 'approval' ? 0 : 1)
    assert.equal(oldControl.stop()?.kind, 'superseded')
    assert.notEqual(successorControl, oldControl)
    assert.equal(engine['runControl'], successorControl)
    assert.equal(successorControl.stop(), successorStop)
    assert.equal(modelStarts, successorModelStarts)
    assert.equal(oldEvents.filter(type => ['done', 'failed', 'cancelled'].includes(type)).length, 0)
  })

  test('a rejected physical start settles only its matching unsettled admission intent', () => {
    const runtime = createParityRuntime('not-started-owner')
    parityOnUserTurn(runtime, { task: 'Synthetic settlement.', model: 'fixture', provider: 'fixture', projectRoot: process.env['BABEL_PROJECT_ROOT']! })
    const tool = { id: 'not-started-operation', name: 'run_command' }
    paritySettleProposeTools(runtime, [{ ...tool, argsDigest: 'fixture-digest' }])
    assert.equal(paritySettleToolStarted(runtime, tool), true)
    const owner = { runId: 'not-started-owner', turnId: runtime.turnId!, generation: 1 }
    const proof = { owner, kind: 'tool' as const, operationId: tool.id }
    assert.equal(paritySettleToolNotStarted(runtime, tool), false)
    assert.equal(paritySettleToolNotStarted(runtime, tool, undefined, 'stopped', { ...proof, owner: { ...owner, runId: 'foreign' } }), false)
    assert.equal(paritySettleToolNotStarted(runtime, tool, undefined, 'stopped', { ...proof, owner: { ...owner, turnId: 'foreign' } }), false)
    assert.equal(paritySettleToolNotStarted(runtime, tool, undefined, 'stopped', { ...proof, operationId: 'foreign' }), false)
    assert.equal(paritySettleToolNotStarted(runtime, tool, undefined, 'stopped', proof), true)
    const settled = runtime.sessionEvents.events.at(-1)!
    assert.equal(settled.kind, 'tool_cancelled')
    if (settled.kind === 'tool_cancelled') assert.equal(settled.recovery_state, undefined)
    assert.equal(runtime.sessionEvents.events.filter(event => event.kind === 'tool_started' && event.idempotency_key === tool.id).length, 1)
    assert.equal(paritySettleToolNotStarted(runtime, tool, undefined, 'stopped', proof), false)
    const completed = { id: 'already-completed-operation', name: 'run_command' }
    paritySettleProposeTools(runtime, [{ ...completed, argsDigest: 'fixture-digest' }])
    assert.equal(paritySettleToolStarted(runtime, completed), true)
    recordToolTerminal(runtime.sessionEvents, { turn_id: runtime.turnId!, tool_call_id: completed.id, tool_name: completed.name,
      idempotency_key: completed.id, exit_code: 0 })
    assert.equal(paritySettleToolNotStarted(runtime, completed, undefined, 'stopped', { ...proof, operationId: completed.id }), false)
  })

  for (const delivery of ['raw', 'native'] as const) test(`C07 Go ${delivery} rechecks after suspended budget reservation`, async () => {
    const savedFetch = globalThis.fetch
    const control = createRunControl({ runId: `go-stop-${delivery}`, turnId: 'fixture-turn', generation: 1 })
    let physicalStarts = 0
    let reservations = 0
    class SuspendedBudget extends OpenCodeGoBudget {
      override async reserve(): Promise<void> {
        reservations++
        await Promise.resolve()
        control.requestStop({ owner: control.owner, kind: 'cancelled', reasonCode: 'cancelled', source: 'user' })
      }
    }
    const budget = new SuspendedBudget({ statePath: join(process.env['BABEL_PROJECT_ROOT']!, `unused-go-${delivery}.json`), jobId: 'fixture-only', limitUsd: 0.01 })
    globalThis.fetch = async () => { physicalStarts++; throw new Error('Unexpected synthetic physical start') }
    try {
      const runner = new OpenCodeGoApiRunner('mimo-v2.5', { maxTokens: 128 }, { budget, credentialSource: 'explicit-test', explicitCredential: 'fixture-only' })
      const callbacks: RunnerCallbacks = { runControl: control }
      await assert.rejects(async () => {
        if (delivery === 'raw') await runner.executeRaw('Synthetic Go fixture.', callbacks)
        else for await (const _event of runner.executeWithToolsStream([{ role: 'user', content: 'Synthetic Go fixture.' }], [], undefined, undefined, undefined, callbacks)) { /* Drain. */ }
      }, error => error instanceof RunStoppedError)
      assert.equal(reservations, 1)
      assert.equal(physicalStarts, 0)
    } finally { globalThis.fetch = savedFetch }
  })

  test('C07 Anthropic compaction also fences its direct physical fetch', async () => {
    const savedFetch = globalThis.fetch
    const control = createRunControl({ runId: 'anthropic-summary-stop', turnId: 'fixture-turn', generation: 1 })
    let physicalStarts = 0
    let completion: ProviderInvocationCompleted | undefined
    globalThis.fetch = async () => { physicalStarts++; throw new Error('Unexpected synthetic physical start') }
    try {
      const summarizer = new LLMSummarizeCompaction({ keepRecentMessages: 2 })
      await assert.rejects(summarizer.compact(Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? 'assistant' as const : 'user' as const, content: 'Synthetic old conversation.' })), {
        model: 'claude-fixture', maxTokens: 128, targetTokens: 16,
        summarizationProvider: { apiKey: 'fixture-only', baseUrl: 'https://api.anthropic.com', defaultModel: 'claude-fixture' },
        callbacks: { runControl: control, onInvocationCompleted: event => { completion = event },
          onInvocationPhase: event => { if (event.phase === 'request_dispatched') control.requestStop({ owner: control.owner, kind: 'cancelled', source: 'user', reasonCode: 'cancelled' }) } },
      }), error => error instanceof RunStoppedError)
      assert.equal(physicalStarts, 0)
      assert.equal(completion?.inference_started, false)
    } finally { globalThis.fetch = savedFetch }
  })

  test('C07 stopping at the persisted dispatch intent cannot execute or roll back an unstarted mutation', async () => {
    const root = mkdtempSync(join(process.env['BABEL_PROJECT_ROOT']!, 'stop-mutation-'))
    const path = join(root, 'target.txt')
    writeFileSync(path, 'before\n')
    const control = createRunControl({ runId: 'mutation-stop', turnId: 'fixture-turn', generation: 1 })
    let physicalStarts = 0
    let intentRecorded = false
    const result = await executeActionWithPolicy({ type: 'write_file', path: 'target.txt', content: 'candidate\n' }, 'workspace_write',
      { runId: control.owner.runId, agentId: 'fixture', babelRoot: root, projectRoot: root, runControl: control }, {
        decide: () => 'allow', hostFallbackAllowed: true, isolationAvailable: false,
        onBeforeExecutorExecute: () => {
          intentRecorded = true
          writeFileSync(path, 'concurrent user edit\n')
          control.requestStop({ owner: control.owner, kind: 'cancelled', source: 'user', reasonCode: 'cancelled' })
        },
        executor: { mapAction: () => [], execute: async action => { physicalStarts++; return { action, terminal: false, results: [] } } },
      })
    assert.equal(intentRecorded, true)
    assert.equal(physicalStarts, 0)
    assert.equal(result.notStarted?.owner, control.owner)
    assert.equal(readFileSync(path, 'utf8'), 'concurrent user edit\n')
  })

  test('ordinary Chat file reads keep their raw content through the canonical executor', async () => {
    const root = mkdtempSync(join(process.env['BABEL_PROJECT_ROOT']!, 'chat-raw-read-'))
    const content = 'first source line\nsecond source line\n'
    writeFileSync(join(root, 'source.txt'), content)
    const result = await chatReadToolExecutor.execute({ type: 'read_file', path: 'source.txt' },
      { runId: 'chat-raw-read', agentId: 'fixture', babelRoot: root, projectRoot: root })
    assert.equal(result.results.length, 1)
    assert.equal(result.results[0]?.exit_code, 0)
    assert.equal(result.results[0]?.stdout, content)
  })

  for (const executorName of ['default', 'chat'] as const) test(`C06 the real ${executorName} executor rechecks after its inner JIT approval`, async () => {
    const root = mkdtempSync(join(process.env['BABEL_PROJECT_ROOT']!, 'stop-inner-jit-'))
    const path = join(root, 'target.txt')
    writeFileSync(path, 'before\n')
    const control = createRunControl({ runId: `inner-jit-stop-${executorName}`, turnId: 'fixture-turn', generation: 1 })
    const keys = ['BABEL_ASK', 'BABEL_LIVE', 'BABEL_UNIT_TEST', 'CI', 'BABEL_NON_INTERACTIVE', 'BABEL_DAEMON'] as const
    const saved = new Map(keys.map(key => [key, process.env[key]]))
    const tty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
    let prompts = 0
    const dialog = mock.method(ConfirmDialog, 'show', async () => {
      prompts++
      await Promise.resolve()
      writeFileSync(path, 'concurrent user edit\n')
      control.requestStop({ owner: control.owner, kind: 'cancelled', reasonCode: 'cancelled', source: 'user' })
      return true
    })
    try {
      for (const key of keys) delete process.env[key]
      process.env['BABEL_ASK'] = 'true'; process.env['BABEL_LIVE'] = 'true'; process.env['BABEL_UNIT_TEST'] = 'true'
      Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true })
      const result = await executeActionWithPolicy({ type: 'write_file', path: 'target.txt', content: 'candidate\n' }, 'workspace_write',
        { runId: control.owner.runId, agentId: 'fixture', babelRoot: root, projectRoot: root, runControl: control },
        { decide: () => 'allow', hostFallbackAllowed: true, isolationAvailable: false,
          ...(executorName === 'chat' ? { executor: chatReadToolExecutor } : {}) }).catch(() => undefined)
      assert.equal(prompts, 1)
      assert.equal(readFileSync(path, 'utf8'), 'concurrent user edit\n')
      assert.equal(result?.notStarted?.owner, control.owner)
    } finally {
      dialog.mock.restore()
      if (tty) Object.defineProperty(process.stdout, 'isTTY', tty)
      else delete (process.stdout as { isTTY?: boolean }).isTTY
      for (const key of keys) { const value = saved.get(key); if (value === undefined) delete process.env[key]; else process.env[key] = value }
    }
  })
}
