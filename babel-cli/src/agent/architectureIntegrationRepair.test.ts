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
import { computePreambleBudget } from './preambleBudget.js'
import { createAgentJob, getAgentJob, updateAgentJob } from '../services/agentJobs.js'
import { runCrashRecovery } from '../daemon/recovery.js'

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

test('I02: OpenCode Go preserves PreparedRequestAdmissionError identity', async () => {
  const overLimit = prepareProviderRequest({
    body: JSON.stringify({ messages: [{ role: 'user', content: 'x'.repeat(8000) }] }),
    mode: 'native',
    provider: 'opencode-go',
    requestedModelId: 'mimo-v2.5',
    contextLimitTokens: 1,
    reservedCompletionTokens: 1,
    requestId: 'req-admission',
    attemptId: 'attempt-admission',
  })
  const admission = new PreparedRequestAdmissionError(overLimit)
  const runner = new OpenCodeGoApiRunner('mimo-v2.5', {}, {
    credentialSource: 'explicit-test',
    explicitCredential: 'fixture-only',
  })
  const original = runner.executeRaw.bind(runner)
  runner.executeRaw = async () => {
    throw admission
  }
  await assert.rejects(
    () => runner.executeRaw('prompt'),
    (error: unknown) => error instanceof PreparedRequestAdmissionError,
  )
  runner.executeRaw = original
})

test('I03: cumulative usage does not shrink map budget when resident history is stable', () => {
  const window = 128_000
  const resident = 20_000
  const withLowCumulative = computePreambleBudget({
    historyTokens: resident,
    contextWindowTokens: window,
  })
  const withHighCumulative = computePreambleBudget({
    historyTokens: 200_000,
    contextWindowTokens: window,
  })
  assert.ok(
    withLowCumulative.maxMapTokens > withHighCumulative.maxMapTokens,
    'resident history must not be replaced by inflated cumulative usage when sizing the map',
  )
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
