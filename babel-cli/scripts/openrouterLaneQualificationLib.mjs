/**
 * Pure helpers for OpenRouter lane 647e qualification (offline-testable).
 */
import { spawnSync } from 'node:child_process'
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
  /stream closed before \[DONE\]/i,
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
 * @param {{ provider_errors?: string[], results?: Array<{ provider_error_observed?: string | null, provider_stop_matches?: string[] }> }} report
 */
export function countAggregateProviderErrors(report) {
  const fromExceptions = Array.isArray(report.provider_errors) ? report.provider_errors.length : 0
  const fromCells = Array.isArray(report.results)
    ? report.results.filter(
        (r) =>
          (typeof r.provider_error_observed === 'string' && r.provider_error_observed.length > 0) ||
          (Array.isArray(r.provider_stop_matches) && r.provider_stop_matches.length > 0),
      ).length
    : 0
  return fromExceptions + fromCells
}

/**
 * OpenAI-compatible stream signature: (messages, tools, systemPrompt?, signal?, ...).
 *
 * @param {{ getLastInvocationMetadata?: () => unknown, executeWithToolsStream: Function }} runner
 * @param {{ signal: AbortSignal, abort?: () => void, abortAfterMs?: number, prompt?: string }} options
 */
export async function runStreamCancellationProbe(runner, options) {
  const t0 = Date.now()
  let deltas = 0
  const prompt = options.prompt ?? 'Write 20 paragraphs about graph algorithms.'
  const timer =
    options.abortAfterMs != null
      ? setTimeout(() => {
          if (typeof options.abort === 'function') options.abort()
        }, options.abortAfterMs)
      : undefined
  try {
    for await (const _ev of runner.executeWithToolsStream(
      [{ role: 'user', content: prompt }],
      [],
      undefined,
      options.signal,
    )) {
      deltas++
    }
    const meta = runner.getLastInvocationMetadata?.() ?? null
    return {
      id: 'cancellation_stream_abort',
      phase: 'paid_provider_execution',
      status: 'unexpected_complete',
      deltas,
      latency_ms: Date.now() - t0,
      signal_forwarded: true,
      usage: summarizeRunnerUsage(meta),
    }
  } catch (e) {
    const meta = runner.getLastInvocationMetadata?.() ?? null
    return {
      id: 'cancellation_stream_abort',
      phase: 'paid_provider_execution',
      status: 'aborted_or_error',
      message: String(e).slice(0, 300),
      deltas,
      latency_ms: Date.now() - t0,
      signal_forwarded: true,
      usage: summarizeRunnerUsage(meta),
    }
  } finally {
    if (timer) clearTimeout(timer)
  }
}
