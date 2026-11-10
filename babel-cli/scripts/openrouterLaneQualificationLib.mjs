/**
 * Pure helpers for OpenRouter lane 647e qualification (offline-testable).
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Patterns that must stop further billable provider calls. */
const PROVIDER_STOP_PATTERNS = [
  /\[(?:openrouter|OpenRouter)\]\s*Network error\b/i,
  /\[(?:openrouter|OpenRouter)\][^\n]{0,200}\b401\b/i,
  /\[(?:openrouter|OpenRouter)\][^\n]{0,200}\b403\b/i,
  /\[(?:openrouter|OpenRouter)\][^\n]{0,200}\b402\b/i,
  /\[(?:openrouter|OpenRouter)\][^\n]{0,200}\b429\b/i,
  /\[(?:openrouter|OpenRouter)\][^\n]{0,200}\b5\d{2}\b/i,
  /\bHTTP_402\b/,
  /\bProviderError\b/,
  /\bprovider error\b/i,
  /stream closed before (?:terminal )?\[DONE\](?: marker)?/i,
  /provider_stop:/i,
]

/**
 * @param {string} blob redacted stdout+stderr or error text
 * @returns {{ stop: boolean, matches: string[] }}
 */
export function detectBillableProviderStop(blob) {
  const matches = []
  for (const pattern of PROVIDER_STOP_PATTERNS) {
    const hit = blob.match(pattern)
    if (hit) matches.push(hit[0].slice(0, 240))
  }
  return { stop: matches.length > 0, matches }
}

/**
 * @param {string[]} texts
 */
export function detectProviderStopFromTexts(texts) {
  const blob = texts.filter((t) => typeof t === 'string' && t.length > 0).join('\n')
  return detectBillableProviderStop(blob)
}

/**
 * Cancellation probe may surface provider failures only as typed stream error events.
 *
 * @param {{ message?: string, event_tally?: { error_events?: string[] } }} probe
 */
export function collectProbeProviderStopScan(probe) {
  const texts = []
  if (typeof probe.message === 'string') texts.push(probe.message)
  const errors = probe.event_tally?.error_events
  if (Array.isArray(errors)) texts.push(...errors)
  return detectProviderStopFromTexts(texts)
}

/**
 * @param {{ id?: string, provider_stop_matches?: string[], provider_error_observed?: string | null, status?: string }} resultRow
 * @param {{ stop: boolean, matches: string[] }} stopScan
 */
export function attachProviderStopToResult(resultRow, stopScan) {
  if (!stopScan.stop) return
  resultRow.provider_stop_matches = stopScan.matches
  resultRow.provider_error_observed = stopScan.matches[0] ?? null
  if (resultRow.id === 'cancellation_stream_abort') {
    resultRow.status = 'provider_stop'
  }
}

/**
 * @param {import('../src/runners/base.ts').RunnerInvocationMetadata | null | undefined} meta
 */
export function summarizeRunnerUsage(meta) {
  if (!meta) {
    return {
      actual_cost_usd: null,
      total_tokens: null,
      cost_precision: 'unknown',
    }
  }
  return {
    actual_cost_usd: meta.estimated_cost_usd ?? meta.provider_reported_total_charge_usd ?? null,
    total_tokens: meta.total_tokens ?? null,
    cost_precision: meta.cost_precision ?? 'unknown',
  }
}

/**
 * @param {{ stdout?: string, stderr?: string, exitCode?: number, payload?: Record<string, unknown> | null }} cli
 * @param {(t: string) => string} redact
 */
export function captureRedactedCliRecord(cli, redact) {
  const payload = cli.payload && typeof cli.payload === 'object' ? cli.payload : {}
  const answer =
    typeof payload.answer === 'string'
      ? payload.answer
      : typeof payload.answer === 'object' && payload.answer && typeof payload.answer.answer === 'string'
        ? payload.answer.answer
        : null
  return {
    exit_code: cli.exitCode ?? null,
    terminal_outcome: payload.terminal_outcome ?? null,
    status: payload.status ?? null,
    answer_excerpt: answer ? redact(answer).slice(0, 400) : null,
    stdout_tail_redacted: redact(String(cli.stdout ?? '')).slice(-800),
    stderr_tail_redacted: redact(String(cli.stderr ?? '')).slice(-800),
  }
}

/**
 * @param {string} ws
 */
export function captureWorkspaceDiff(ws) {
  const stat = spawnSync('git', ['diff', '--stat'], { cwd: ws, encoding: 'utf8' })
  const diff = spawnSync('git', ['diff', '--no-color'], { cwd: ws, encoding: 'utf8', maxBuffer: 512 * 1024 })
  return {
    diff_stat: (stat.stdout ?? '').trim().slice(0, 2000) || null,
    diff_excerpt: (diff.stdout ?? '').slice(0, 4000) || null,
    diff_paths: [...(diff.stdout ?? '').matchAll(/^diff --git a\/(.+?) b\//gm)].map((m) => m[1]),
  }
}

/**
 * Host-owned export semantics for multi-file fixture (invoke-greeting oracle, not npm test alone).
 *
 * @param {string} ws
 * @param {string} packageRoot babel-cli root
 */
/**
 * @param {unknown} usage engine usage payload from chat-headless JSON
 */
export function summarizeChatHeadlessUsage(usage) {
  if (!usage || typeof usage !== 'object') {
    return {
      actual_cost_usd: null,
      total_input_tokens: null,
      total_output_tokens: null,
      total_tokens: null,
      cost_complete: null,
      cost_precision: 'unknown',
    }
  }
  const u = /** @type {Record<string, unknown>} */ (usage)
  const costKnown = u.costComplete === true && Number.isFinite(u.completeCostUSD)
  return {
    actual_cost_usd: costKnown
      ? /** @type {number} */ (u.completeCostUSD)
      : (typeof u.actualCostUSD === 'number'
          ? u.actualCostUSD
          : typeof u.reportedCostUSD === 'number'
            ? u.reportedCostUSD
            : null),
    total_input_tokens: typeof u.totalInputTokens === 'number' ? u.totalInputTokens : null,
    total_output_tokens: typeof u.totalOutputTokens === 'number' ? u.totalOutputTokens : null,
    total_tokens: typeof u.totalTokens === 'number' ? u.totalTokens : null,
    cost_complete: u.costComplete === true,
    cost_precision: costKnown ? 'complete' : u.usageComplete === false ? 'partial' : 'unknown',
  }
}

/** Ordinary-bug fixture: host oracle score plus workspace npm test. */
export function gradeOrdinaryBugHostChecks(ws, packageRoot) {
  const score = spawnSync(
    process.execPath,
    [join(packageRoot, 'fixtures/coding-output-acceptance/oracle/ordinary-bug/score.mjs'), ws],
    { encoding: 'utf8' },
  )
  const test = spawnSync('npm', ['test'], { cwd: ws, encoding: 'utf8', shell: true })
  return {
    kind: 'ordinary-bug',
    oracle_score_exit: score.status,
    oracle_stdout: score.stdout.trim().slice(0, 200),
    math_js: readFileSync(join(ws, 'src/math.js'), 'utf8').trim(),
    npm_test_exit: test.status,
  }
}

export function gradeMultiFileHostChecks(ws, packageRoot) {
  const test = spawnSync('npm', ['test'], { cwd: ws, encoding: 'utf8', shell: true })
  return {
    kind: 'multi-file',
    npm_test_exit: test.status,
    ...gradeMultiFileExportSemantics(ws, packageRoot),
  }
}

/**
 * Build report row + redacted record before stop-on-provider-error discard.
 *
 * @param {string} id
 * @param {string} ws
 * @param {{ stdout?: string, stderr?: string, exitCode?: number, payload?: Record<string, unknown> | null, timedOut?: boolean, failureCapsule?: { kind?: string, failure_class_hint?: string } | null }} cli
 * @param {(t: string) => string} redact
 * @param {string} packageRoot
 * @param {number} t0
 */
export function buildChatQualificationArtifacts(id, ws, cli, redact, packageRoot, t0) {
  const blob = redact(`${cli.stderr ?? ''}\n${cli.stdout ?? ''}`)
  const stopScan = detectBillableProviderStop(blob)
  const payload = cli.payload && typeof cli.payload === 'object' ? cli.payload : {}
  const sessionId =
    typeof payload.session_id === 'string'
      ? payload.session_id
      : typeof payload.run_dir === 'string'
        ? payload.run_dir.split('/').pop()
        : null
  const row = {
    phase: 'paid_provider_execution',
    id,
    latency_ms: Date.now() - t0,
    exit_code: cli.exitCode ?? null,
    terminal_outcome: payload.terminal_outcome ?? null,
    status: payload.status ?? null,
    session_id: sessionId,
    run_dir_basename: sessionId,
    usage: summarizeChatHeadlessUsage(payload.usage ?? null),
    timed_out: cli.timedOut === true,
    failure_capsule: cli.failureCapsule
      ? { kind: cli.failureCapsule.kind, failure_class_hint: cli.failureCapsule.failure_class_hint }
      : null,
    provider_error_observed: stopScan.matches[0] ?? null,
    provider_stop_matches: stopScan.matches,
    stopped_billable_after_cell: stopScan.stop,
  }
  const redactedRecord = {
    id,
    session_id: sessionId,
    ...captureRedactedCliRecord(cli, redact),
    workspace_diff: captureWorkspaceDiff(ws),
    usage: row.usage,
    provider_stop_matches: stopScan.matches,
  }
  return { row, redactedRecord, stopScan, blob }
}

/** Non-billable runner that mirrors OpenRouter caller-cancel typed error events (offline qualification only). */
export function createOfflineOpenRouterCancellationFixtureRunner() {
  return {
    getLastInvocationMetadata: () => null,
    async *executeWithToolsStream(
      _messages,
      _tools,
      _systemPrompt,
      _signal,
    ) {
      yield { type: 'error', message: '[openrouter] Request cancelled' }
    },
  }
}

export function createOfflineOpenRouterHttp402FixtureRunner() {
  return {
    getLastInvocationMetadata: () => null,
    async *executeWithToolsStream() {
      yield { type: 'error', message: '[openrouter] HTTP 402 Payment Required' }
    },
  }
}

export function createOfflineOpenRouterTruncatedStreamFixtureRunner() {
  return {
    getLastInvocationMetadata: () => null,
    async *executeWithToolsStream() {
      yield { type: 'error', message: '[openrouter] stream closed before terminal [DONE] marker' }
    },
  }
}

export function createOfflineOpenRouterCancellationWithUsageFixtureRunner() {
  return {
    getLastInvocationMetadata: () => ({
      estimated_cost_usd: 0.004,
      total_tokens: 120,
      cost_precision: 'reported',
    }),
    async *executeWithToolsStream() {
      yield { type: 'error', message: '[openrouter] Request cancelled' }
    },
  }
}

export function isCancellationStreamErrorMessage(message) {
  return /\[([^\]]+)\]\s*Request cancelled/i.test(message) || /\bRequest cancelled\b/i.test(message)
}

export function isProviderStreamTerminationFailure(message) {
  return /stream closed before (?:terminal )?\[DONE\] marker/i.test(message)
}

/**
 * @param {{ text_deltas: number, error_events: string[], done_events: number, other_events: number }} tally
 */
export function classifyCancellationProbeStatus(tally) {
  const cancellationOnly =
    tally.error_events.length > 0 &&
    tally.error_events.every((m) => isCancellationStreamErrorMessage(m)) &&
    tally.text_deltas === 0 &&
    tally.done_events === 0
  if (cancellationOnly) {
    return {
      status: 'inconclusive',
      interpretation:
        'Adapter emitted typed error event for caller cancellation; single event does not certify truncated billing or usage.',
      prior_status_reclassified_from: 'unexpected_complete',
    }
  }
  if (tally.error_events.some((m) => isProviderStreamTerminationFailure(m))) {
    return { status: 'provider_stream_failure', interpretation: 'Stream termination before [DONE] is not successful cancellation.' }
  }
  if (tally.done_events > 0 && tally.text_deltas > 0) {
    return { status: 'unexpected_complete', interpretation: 'Stream delivered content and terminal done after abort timing.' }
  }
  if (tally.error_events.some((m) => isCancellationStreamErrorMessage(m)) && tally.text_deltas > 0) {
    return {
      status: 'inconclusive',
      interpretation: 'Partial content before cancellation error; billing outcome unknown without usage reconciliation.',
    }
  }
  return { status: 'inconclusive', interpretation: 'No typed cancellation or terminal done evidence.' }
}

export function gradeMultiFileExportSemantics(ws, packageRoot) {
  const score = spawnSync(
    process.execPath,
    [join(packageRoot, 'fixtures/coding-output-acceptance/oracle/multi-file/score.mjs'), ws],
    { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 },
  )
  let functionalSuccess = null
  const lastLine = score.stdout.trim().split('\n').pop() ?? ''
  try {
    const parsed = JSON.parse(lastLine)
    functionalSuccess = parsed.functional_success === true
  } catch {
    functionalSuccess = false
  }
  return {
    export_oracle_exit: score.status,
    export_semantic_pass: score.status === 0 && functionalSuccess === true,
    export_oracle_tail: score.stdout.trim().slice(-300),
    export_oracle_stderr: score.stderr.trim().slice(0, 200),
  }
}

/**
 * Count provider stops once per logical call id (result row id); exclude duplicate provider_stop throws.
 *
 * @param {{ provider_errors?: string[], results?: Array<{ id?: string, provider_error_observed?: string | null, provider_stop_matches?: string[] }> }} report
 */
export function countAggregateProviderErrors(report) {
  const seenCallIds = new Set()
  let count = 0
  for (const row of report.results ?? []) {
    const callId = typeof row.id === 'string' ? row.id : null
    const stopped =
      (typeof row.provider_error_observed === 'string' && row.provider_error_observed.length > 0) ||
      (Array.isArray(row.provider_stop_matches) && row.provider_stop_matches.length > 0)
    if (!stopped || !callId || seenCallIds.has(callId)) continue
    seenCallIds.add(callId)
    count += 1
  }
  for (const err of report.provider_errors ?? []) {
    const text = String(err)
    if (/provider_stop:/.test(text)) continue
    count += 1
  }
  return count
}

/**
 * OpenAI-compatible stream signature: (messages, tools, systemPrompt?, signal?, ...).
 *
 * @param {{ getLastInvocationMetadata?: () => unknown, executeWithToolsStream: Function }} runner
 * @param {{ signal: AbortSignal, abort?: () => void, abortAfterMs?: number, prompt?: string }} options
 */
export async function runStreamCancellationProbe(runner, options) {
  const t0 = Date.now()
  const tally = { text_deltas: 0, error_events: [], done_events: 0, other_events: 0 }
  const prompt = options.prompt ?? 'Write 20 paragraphs about graph algorithms.'
  const timer =
    options.abortAfterMs != null
      ? setTimeout(() => {
          if (typeof options.abort === 'function') options.abort()
        }, options.abortAfterMs)
      : undefined
  try {
    for await (const ev of runner.executeWithToolsStream(
      [{ role: 'user', content: prompt }],
      [],
      undefined,
      options.signal,
    )) {
      const type = ev && typeof ev === 'object' ? ev.type : undefined
      if (type === 'text_delta' || type === 'thought_delta') tally.text_deltas += 1
      else if (type === 'error') tally.error_events.push(String(ev.message ?? ''))
      else if (type === 'done') tally.done_events += 1
      else tally.other_events += 1
    }
    const meta = runner.getLastInvocationMetadata?.() ?? null
    const classified = classifyCancellationProbeStatus(tally)
    return {
      id: 'cancellation_stream_abort',
      phase: 'paid_provider_execution',
      status: classified.status,
      interpretation: classified.interpretation,
      ...(classified.prior_status_reclassified_from
        ? { prior_status_reclassified_from: classified.prior_status_reclassified_from }
        : {}),
      event_tally: tally,
      content_deltas: tally.text_deltas,
      cancellation_error_observed: tally.error_events.some((m) => isCancellationStreamErrorMessage(m)),
      latency_ms: Date.now() - t0,
      signal_forwarded: true,
      usage: summarizeRunnerUsage(meta),
    }
  } catch (e) {
    const meta = runner.getLastInvocationMetadata?.() ?? null
    const message = e instanceof Error ? e.message : String(e)
    return {
      id: 'cancellation_stream_abort',
      phase: 'paid_provider_execution',
      status: isCancellationStreamErrorMessage(message) ? 'inconclusive' : 'aborted_or_error',
      message: message.slice(0, 300),
      interpretation: isCancellationStreamErrorMessage(message)
        ? 'Thrown cancellation does not alone prove billing truncation.'
        : undefined,
      event_tally: tally,
      content_deltas: tally.text_deltas,
      cancellation_error_observed: isCancellationStreamErrorMessage(message),
      latency_ms: Date.now() - t0,
      signal_forwarded: true,
      usage: summarizeRunnerUsage(meta),
    }
  } finally {
    if (timer) clearTimeout(timer)
  }
}
