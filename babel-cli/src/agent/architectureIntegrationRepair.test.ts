import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'

import {
  CompactionManager,
  HeuristicTruncationStrategy,
  estimateTokens,
  type ChatMessage,
} from './chatCompaction.js'
import { runMutationAgentLoop } from './lanes/runMutationAgentLoop.js'
import {
  PreparedRequestAdmissionError,
  prepareProviderRequest,
} from '../runners/preparedProviderRequest.js'
import { OpenCodeGoApiRunner } from '../runners/openCodeGoApi.js'
import { createAgentJob, getAgentJob } from '../services/agentJobs.js'
import { runCrashRecovery } from '../daemon/recovery.js'
import {
  buildNativeProviderRequestBodyForAdmission,
  evaluateCompactionSerializedAdmission,
  resolveCompactionAdmissionContext,
} from './compactionCommit.js'
import {
  resolveCompactionSummarizationProvider,
} from './chatCompaction.js'
import { grepContent } from '../tools/repoSearch.js'
import { RipgrepAbortedError } from '../tools/ripgrep.js'
import { normalizeProviderFailureClass } from '../runners/providerFailureReceipt.js'
import { createExecutorKernel } from '../executor/kernel.js'
import {
  decideReadInjection,
  rememberReadInjection,
} from './codingLoop/readWindow.js'
import {
  createRunAllowanceReport,
  resolveChatEngineLimits,
} from '../config/chatEngineLimits.js'
import {
  createSessionEventLog,
  interruptedToolIdempotencyKeys,
  recordToolProposed,
  recordToolStarted,
} from './sessionEvents.js'
import { createThreadEventLog, recordUserMessage, startTurn } from './threadEventLog.js'
import { terminalReasonFromClassification } from './chatTerminalReason.js'
import type { ToolDefinition } from '../runners/base.js'

const stubTools: ToolDefinition[] = [{
  type: 'function',
  function: {
    name: 'read_range',
    description: 'fixture',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
}]

test('I01: default manager is eligible in the native-tool reserve band', async () => {
  const maxTokens = 128_000
  const reserve = 8_000
  const eligibilityCap = maxTokens - reserve
  const filler = 'x'.repeat(4 * (eligibilityCap + 500))
  const messages: ChatMessage[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: filler },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: 'tail' },
  ]
  const tokens = estimateTokens(messages)
  assert.ok(tokens > eligibilityCap && tokens < maxTokens)

  const manager = new CompactionManager([new HeuristicTruncationStrategy(2)])
  const withoutContext = await manager.compactWithResult(messages, {
    model: 'test-model',
    maxTokens,
  })
  assert.equal(withoutContext.changed, false, 'negative control: full cap alone is ineligible')

  const withContext = await manager.compactWithResult(messages, {
    model: 'test-model',
    maxTokens,
    requestContext: {
      reason: 'reserve_headroom',
      historyTokenEstimate: tokens,
      eligibilityTokenCap: eligibilityCap,
      maxTokens,
      compactionRequested: true,
    },
  })
  assert.equal(withContext.changed, true, 'reserve-band trigger must compact')
  assert.ok(withContext.tokensAfter < withContext.tokensBefore)
})

test('I02: OpenCode Go adapter preserves PreparedRequestAdmissionError before transport', async () => {
  const priorFetch = globalThis.fetch
  let fetchCalls = 0
  globalThis.fetch = async () => {
    fetchCalls += 1
    throw new Error('transport must not run when prepared-request admission fails')
  }
  try {
    const runner = new OpenCodeGoApiRunner('deepseek-v4-flash', {}, {
      credentialSource: 'explicit-test',
      explicitCredential: 'fixture-only',
    })
    const hugePrompt = 'x'.repeat(4_000_000)
    await assert.rejects(
      () => runner.executeRaw(hugePrompt, undefined, 'fixture system'),
      (error: unknown) => error instanceof PreparedRequestAdmissionError,
    )
    assert.equal(fetchCalls, 0)
  } finally {
    globalThis.fetch = priorFetch
  }
})

test('I03: repeated Chat preamble budget uses resident history not apiTokenCount', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-i03-map-'))
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'seed.ts'), 'export const seed = 1\n')
  const { ChatEngine } = await import('./chatEngine.js')
  const { computePreambleBudget } = await import('./preambleBudget.js')
  const engine = new ChatEngine({
    task: 'inspect seed.ts',
    projectRoot: root,
    maxEstimatedTokens: 128_000,
  })
  engine.replaceConversation([
    { role: 'user', content: 'inspect seed.ts' },
    { role: 'assistant', content: 'ok' },
  ])
  const host = engine as unknown as import('./chatEngineContracts.js').ChatEngineStreamingLoopHost & {
    repoMapCache: string | null
  }
  const tokenUsage = engine as unknown as { apiTokenCount: number }
  const mapBudgets: number[] = []
  const priorErr = console.error
  console.error = (msg: unknown, ...rest: unknown[]) => {
    const text = [msg, ...rest].map(String).join(' ')
    const marker = '[preamble-budget] '
    if (text.includes(marker)) {
      const jsonStart = text.indexOf('{', text.indexOf(marker))
      if (jsonStart >= 0) {
        const parsed = JSON.parse(text.slice(jsonStart)) as { maxMapTokens?: number }
        if (typeof parsed.maxMapTokens === 'number') mapBudgets.push(parsed.maxMapTokens)
      }
    }
    priorErr(msg, ...rest)
  }
  try {
    const mapRound1 =
      (await host.generateRepoMap()) ||
      '## Project map (fixture)\n- src/seed.ts\n'
    host.repoMapCache = mapRound1
    host.getOrBuildSystemPrompt('legacy')
    tokenUsage.apiTokenCount = 400_000
    host.repoMapCache = null
    const mapRound2 =
      (await host.generateRepoMap()) ||
      '## Project map (fixture round 2)\n- src/seed.ts\n'
    host.repoMapCache = mapRound2
    ;(engine as { clearSystemPromptCache(): void }).clearSystemPromptCache()
    host.getOrBuildSystemPrompt('legacy')
    assert.equal(mapBudgets.length, 2)
    assert.equal(mapBudgets[0], mapBudgets[1])
    assert.notEqual(
      computePreambleBudget({ historyTokens: 400_000, contextWindowTokens: 128_000 }).maxMapTokens,
      mapBudgets[0],
    )
  } finally {
    console.error = priorErr
  }
})

test('I06: apply_patch scope checks parsed targets, not staging path', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-patch-scope-'))
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'ok.ts'), 'before\n')
  const blocked = await runMutationAgentLoop({
    agentId: 'patch-scope-block',
    task: 'patch outside scope',
    writeScope: ['src'],
    projectRoot: root,
    toolContext: {
      agentId: 'patch-scope-block',
      runId: 'run',
      runDir: root,
      babelRoot: root,
    },
    executor: {
      execute: async () => ({ results: [{ exit_code: 0, stdout: '', stderr: '' }], policyBlocked: false }),
    } as never,
    actionResolver: async () => [{
      type: 'apply_patch',
      patch: [
        'diff --git a/lib/out.ts b/lib/out.ts',
        '--- a/lib/out.ts',
        '+++ b/lib/out.ts',
        '@@ -1 +1 @@',
        '+escaped',
      ].join('\n'),
    }],
  })
  assert.equal(blocked.success, false)
  assert.match(blocked.error ?? '', /outside write scope|lib\/out/)

  const allowed = await runMutationAgentLoop({
    agentId: 'patch-scope-ok',
    task: 'patch inside scope',
    writeScope: ['src'],
    projectRoot: root,
    toolContext: {
      agentId: 'patch-scope-ok',
      runId: 'run2',
      runDir: root,
      babelRoot: root,
    },
    executor: {
      execute: async () => ({ results: [{ exit_code: 0, stdout: '', stderr: '' }], policyBlocked: false }),
    } as never,
    actionResolver: async () => [{
      type: 'apply_patch',
      patch: [
        'diff --git a/src/ok.ts b/src/ok.ts',
        '--- a/src/ok.ts',
        '+++ b/src/ok.ts',
        '@@ -1 +1 @@',
        '+in scope',
      ].join('\n'),
    }, { type: 'finish', summary: 'done', verification: [] }],
  })
  assert.equal(allowed.success, true)
})

test('I08: daemon crash recovery requires explicit recovery instead of silent requeue', () => {
  const priorRegistry = process.env['BABEL_JOBS_REGISTRY_PATH']
  const priorRuns = process.env['BABEL_RUNS_DIR']
  const testRoot = mkdtempSync(join(tmpdir(), 'babel-daemon-recovery-repair-'))
  process.env['BABEL_RUNS_DIR'] = testRoot
  process.env['BABEL_JOBS_REGISTRY_PATH'] = join(testRoot, 'jobs', 'registry.json')

  const job = createAgentJob({ task: 'effectful daemon job', maxRetries: 0 })
  const stale = new Date(Date.now() - 10 * 60 * 1000).toISOString()
  const registryPath = join(testRoot, 'jobs', 'registry.json')
  const registry = JSON.parse(readFileSync(registryPath, 'utf8')) as {
    jobs: Array<{ id: string; status: string; updated_at: string }>
  }
  const entry = registry.jobs.find((row) => row.id === job.id)
  assert.ok(entry)
  entry.status = 'running'
  entry.updated_at = stale
  writeFileSync(registryPath, JSON.stringify(registry))

  const report = runCrashRecovery()
  assert.equal(report.abandonedJobsReturned, 1)
  const recovered = getAgentJob(job.id)
  assert.equal(recovered?.status, 'failed')
  assert.match(recovered?.error ?? '', /Recovery required/i)
  assert.doesNotMatch(recovered?.error ?? '', /Re-enqueued/i)

  if (priorRegistry) process.env['BABEL_JOBS_REGISTRY_PATH'] = priorRegistry
  else delete process.env['BABEL_JOBS_REGISTRY_PATH']
  if (priorRuns) process.env['BABEL_RUNS_DIR'] = priorRuns
  else delete process.env['BABEL_RUNS_DIR']
})

test('I04: OpenCode-Go-only Chat does not resolve ambient cross-provider compaction route', () => {
  const priorOr = process.env['OPENROUTER_API_KEY']
  const priorDi = process.env['DEEPINFRA_API_KEY']
  delete process.env['OPENROUTER_API_KEY']
  delete process.env['DEEPINFRA_API_KEY']
  try {
    assert.equal(
      resolveCompactionSummarizationProvider({
        chatProvider: 'opencode-go',
        compactionModel: 'mimo-v2.5',
      }),
      null,
    )
  } finally {
    if (priorOr) process.env['OPENROUTER_API_KEY'] = priorOr
    if (priorDi) process.env['DEEPINFRA_API_KEY'] = priorDi
  }
})

test('I05: native wire body with tools is over_limit when it cannot fit provider window', () => {
  const threadLog = createThreadEventLog('i05')
  const turnId = startTurn(threadLog, {
    task: 'fit probe',
    model: 'deepseek-v4-flash',
    provider: 'deepinfra',
    projectRoot: tmpdir(),
    policyPreset: 'chat',
  })
  recordUserMessage(threadLog, turnId, 'x'.repeat(4_000_000))
  const body = buildNativeProviderRequestBodyForAdmission({
    threadLog,
    systemPrompt: 'policy preamble '.repeat(200),
    modelId: 'deepseek-v4-flash',
    tools: stubTools,
    maxOutputTokens: 8192,
  })
  const admission = evaluateCompactionSerializedAdmission(body, {
    modelId: 'deepseek-v4-flash',
    providerId: 'deepinfra',
    ...resolveCompactionAdmissionContext({
      conversation: [],
      options: { task: 'fit probe' },
      limits: { maxEstimatedTokens: 80 },
      abortSignal: new AbortController().signal,
      writeCount: 0,
      turnIndex: 0,
      toolCallLog: [],
      progress: { receipts: [], consecutiveNoProgress: 0 },
      threadLog,
      sessionLog: createSessionEventLog('i05'),
      turnId,
      shouldUseTextTools: () => false,
      compactHeuristic: () => undefined,
      checkpoint: async () => undefined,
      reserveTokens: 0,
      textToolsReserve: 0,
      resolveModel: () => 'deepseek-v4-flash',
      shouldCompactByTokens: () => true,
      estimateTokens: () => 0,
    }, 'deepseek-v4-flash'),
  })
  assert.equal(admission, 'over_limit')
  const smallBody = buildNativeProviderRequestBodyForAdmission({
    threadLog: createThreadEventLog('i05-small'),
    systemPrompt: 'small',
    modelId: 'deepseek-v4-flash',
    tools: stubTools,
    maxOutputTokens: 8192,
  })
  assert.equal(
    evaluateCompactionSerializedAdmission(smallBody, {
      modelId: 'deepseek-v4-flash',
      providerId: 'deepinfra',
      contextWindowTokens: 1_000_000,
      reservedCompletionTokens: 8192,
    }),
    'qualified',
  )
})

test('I09: cancelled grep does not launch pure-JS fallback', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-grep-cancel-'))
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'a.ts'), 'needle\n')
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    () => grepContent(root, 'needle', { signal: controller.signal }),
    (error: unknown) => error instanceof RipgrepAbortedError,
  )
})

test('I11: plan kernel dispatch denies file_write at the shared boundary', async () => {
  const kernel = createExecutorKernel('plan')
  const result = await kernel.tools.execute(
    { tool: 'file_write', path: 'src/x.ts', content: 'y' },
    { agentId: 'i11', runId: 'i11', babelRoot: process.cwd() },
  )
  assert.equal(result.exit_code, 1)
  assert.match(result.stderr ?? '', /plan_read_only/i)
})

test('I16: provider failure taxonomy separates connect vs read timeouts', () => {
  assert.equal(normalizeProviderFailureClass({ httpStatus: 429 }), 'HTTP_429')
  assert.equal(
    normalizeProviderFailureClass({ message: 'connection timed out' }),
    'CONNECT_TIMEOUT',
  )
  assert.equal(
    normalizeProviderFailureClass({ message: 'read timeout while waiting for provider body' }),
    'READ_TIMEOUT',
  )
})

test('I13: read dedupe skips identical full reads within an epoch only', () => {
  const cache = new Map()
  const pathKey = 'src/a.ts'
  const request = { kind: 'full' as const }
  rememberReadInjection(cache, `${pathKey}::full::epoch=0`, 'hash-v1')
  const skip = decideReadInjection({
    pathKey,
    fileHash: 'hash-v1',
    request,
    cache,
    contextEpoch: 0,
  })
  assert.equal(skip.skip, true)
  const epochBump = decideReadInjection({
    pathKey,
    fileHash: 'hash-v1',
    request,
    cache,
    contextEpoch: 1,
  })
  assert.equal(epochBump.skip, false)
  const range = decideReadInjection({
    pathKey,
    fileHash: 'hash-v1',
    request: { kind: 'range', startLine: 1, endLine: 5 },
    cache,
    contextEpoch: 0,
  })
  assert.equal(range.skip, false)
})

test('I14: missing cost allowance stays unknown instead of zero', () => {
  const finite = resolveChatEngineLimits({ maxCostUsd: 10 })
  const unknownLimits = { ...finite, maxCostUsd: Number.NaN }
  delete unknownLimits.costBudget
  const report = createRunAllowanceReport(unknownLimits)
  assert.equal(report.costAllowance.kind, 'unknown')
})

test('I15: interrupted tool attempts stay visible until explicitly settled', () => {
  const log = createSessionEventLog('i15')
  recordToolProposed(log, {
    turn_id: 't1',
    tool_call_id: 'call_run',
    tool_name: 'run_command',
  })
  recordToolStarted(log, {
    turn_id: 't1',
    tool_call_id: 'call_run',
    tool_name: 'run_command',
  })
  assert.deepEqual(interruptedToolIdempotencyKeys(log), ['call_run'])
  assert.ok(
    !log.events.some(
      (event) => event.kind === 'tool_completed' && event.idempotency_key === 'call_run',
    ),
  )
})

test('I16: harness wall limit classifies as budget exhaustion, not success', () => {
  const wall = terminalReasonFromClassification('limit_wall')
  assert.ok(wall)
  assert.equal(wall?.code, 'budget_exhausted')
  assert.equal(wall?.cause_class, 'harness')
  assert.equal(terminalReasonFromClassification(null), undefined)
})
