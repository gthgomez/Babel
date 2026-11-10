import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const libUrl = pathToFileURL(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'openrouterLaneQualificationLib.mjs'),
).href

test('detectBillableProviderStop catches Network error and HTTP 402', async () => {
  const { detectBillableProviderStop } = await import(libUrl)
  const a = detectBillableProviderStop('[openrouter] Network error (deepseek/x): ECONNRESET')
  const b = detectBillableProviderStop('failure_class HTTP_402 remaining credits')
  const c = detectBillableProviderStop('stream closed before [DONE] while parsing SSE')
  const productionDone = detectBillableProviderStop(
    '[openrouter] stream closed before terminal [DONE] marker',
  )
  assert.equal(a.stop, true)
  assert.equal(b.stop, true)
  assert.equal(c.stop, true)
  assert.equal(productionDone.stop, true)
  assert.equal(detectBillableProviderStop('normal assistant chunk').stop, false)
})

test('countAggregateProviderErrors includes exception list and per-cell flags', async () => {
  const { countAggregateProviderErrors } = await import(libUrl)
  const n = countAggregateProviderErrors({
    provider_errors: ['one'],
    results: [
      { provider_error_observed: '[openrouter] Network error' },
      { provider_error_observed: null },
      { provider_stop_matches: ['402'] },
    ],
  })
  assert.equal(n, 3)
})

test('gradeMultiFileExportSemantics fails on unmodified broken export fixture', async () => {
  const { gradeMultiFileExportSemantics } = await import(libUrl)
  const { cpSync, mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join, dirname } = await import('node:path')
  const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
  const ws = mkdtempSync(join(tmpdir(), 'or647e-export-grade-'))
  cpSync(join(packageRoot, 'fixtures/coding-output-acceptance/workspaces/multi-file'), ws, { recursive: true })
  const grade = gradeMultiFileExportSemantics(ws, packageRoot)
  assert.equal(grade.export_semantic_pass, false)
})

test('runStreamCancellationProbe forwards AbortSignal as fourth argument', async () => {
  const { runStreamCancellationProbe } = await import(libUrl)
  let observedSignal: AbortSignal | undefined
  const runner = {
    getLastInvocationMetadata: () => null,
    async *executeWithToolsStream(
      _messages: unknown[],
      _tools: unknown[],
      _systemPrompt?: string,
      signal?: AbortSignal,
    ) {
      observedSignal = signal
      yield { type: 'text_delta', text: 'x' }
    },
  }
  const ac = new AbortController()
  ac.abort()
  await runStreamCancellationProbe(runner as never, {
    signal: ac.signal,
    abort: () => ac.abort(),
    abortAfterMs: undefined,
  })
  assert.equal(observedSignal, ac.signal)
})

test('runStreamCancellationProbe treats openrouter cancellation error event as inconclusive', async () => {
  const { runStreamCancellationProbe } = await import(libUrl)
  const runner = {
    getLastInvocationMetadata: () => null,
    async *executeWithToolsStream() {
      yield { type: 'error', message: '[openrouter] Request cancelled' }
    },
  }
  const ac = new AbortController()
  const probe = await runStreamCancellationProbe(runner as never, {
    signal: ac.signal,
    abort: () => ac.abort(),
    abortAfterMs: undefined,
  })
  assert.equal(probe.status, 'inconclusive')
  assert.equal(probe.content_deltas, 0)
  assert.equal(probe.cancellation_error_observed, true)
  assert.equal(probe.prior_status_reclassified_from, 'unexpected_complete')
})

test('buildChatQualificationArtifacts retains usage before provider stop', async () => {
  const { buildChatQualificationArtifacts } = await import(libUrl)
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join, dirname } = await import('node:path')
  const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
  const ws = mkdtempSync(join(tmpdir(), 'or647e-stop-evidence-'))
  writeFileSync(join(ws, '.gitkeep'), '')
  try {
    const cli = {
      exitCode: 1,
      stderr: '[openrouter] stream closed before terminal [DONE] marker',
      stdout: '',
      payload: {
        terminal_outcome: 'FAILED',
        status: 'failed',
        usage: { actualCostUSD: 0.0025, costComplete: true, completeCostUSD: 0.0025, totalTokens: 42 },
      },
    }
    const { row, redactedRecord, stopScan } = buildChatQualificationArtifacts(
      'vague_repair',
      ws,
      cli,
      (t: string) => t,
      packageRoot,
      Date.now(),
    )
    assert.equal(stopScan.stop, true)
    assert.equal(row.usage.actual_cost_usd, 0.0025)
    assert.equal(redactedRecord.usage.actual_cost_usd, 0.0025)
    assert.deepEqual(row.provider_stop_matches, stopScan.matches)
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
})

test('gradeOrdinaryBugHostChecks does not run multi-file export oracle', async () => {
  const { gradeOrdinaryBugHostChecks, gradeMultiFileHostChecks } = await import(libUrl)
  const { cpSync, mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join, dirname } = await import('node:path')
  const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
  const ordinary = mkdtempSync(join(tmpdir(), 'or647e-ordinary-'))
  const multi = mkdtempSync(join(tmpdir(), 'or647e-multi-'))
  cpSync(join(packageRoot, 'fixtures/coding-output-acceptance/workspaces/ordinary-bug'), ordinary, {
    recursive: true,
  })
  cpSync(join(packageRoot, 'fixtures/coding-output-acceptance/workspaces/multi-file'), multi, { recursive: true })
  try {
    const o = gradeOrdinaryBugHostChecks(ordinary, packageRoot)
    const m = gradeMultiFileHostChecks(multi, packageRoot)
    assert.equal(o.kind, 'ordinary-bug')
    assert.equal(m.kind, 'multi-file')
    assert.ok('oracle_score_exit' in o)
    assert.ok('export_semantic_pass' in m)
    assert.equal('export_semantic_pass' in o, false)
    assert.equal('oracle_score_exit' in m, false)
  } finally {
    rmSync(ordinary, { recursive: true, force: true })
    rmSync(multi, { recursive: true, force: true })
  }
})
