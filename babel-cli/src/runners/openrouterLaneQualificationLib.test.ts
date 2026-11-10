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
  assert.equal(a.stop, true)
  assert.equal(b.stop, true)
  assert.equal(c.stop, true)
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
      yield { type: 'text_delta', delta: 'x' }
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
