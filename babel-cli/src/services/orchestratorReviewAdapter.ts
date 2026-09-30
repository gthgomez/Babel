import { spawn } from 'node:child_process'
import { terminateChildTree } from '../processTree.js'
import type {
  IndependentReviewExecutionRequest,
  IndependentReviewExecutionResult,
  IndependentReviewWorkerAdapter,
} from './independentReviewController.js'
import type { IndependentReviewRuntime } from './independentReviewEvidenceV3.js'

export interface OpenCodeSpawnRequest {
  prompt: string
  model: string
  cwd: string
  agentConfigPath: string
  agentName?: string
  timeoutMs: number
}

export interface OpenCodeSpawnResult {
  exitCode: number
  events: unknown[]
  sessionId?: string
}

export type OpenCodeSpawnFn = (req: OpenCodeSpawnRequest) => Promise<OpenCodeSpawnResult>

export interface OpenCodeReviewAdapterOptions {
  adapterId?: string
  model: string
  cwd: string
  agentConfigPath: string
  /** Read-only OpenCode agent name to select (mirrors `.opencode/agents/<name>.md`). */
  agentName?: string
  timeoutMs?: number
  /** Bounded transport retries for spawn/parse failures (1..3, default 2). Never retries a verdict. */
  maxAttempts?: number
  spawnFn?: OpenCodeSpawnFn
}

const DEFAULT_ADAPTER_ID = 'opencode-subagent-v1'
const DEFAULT_TIMEOUT_MS = 1_260_000

interface ParsedReview {
  verdict: 'APPROVE' | 'BLOCK'
  findings: string[]
  blocking_findings: string[]
  reviewed_files: string[]
  summary?: string
}

function buildReviewPrompt(request: Readonly<IndependentReviewExecutionRequest>): string {
  const candidate = request.candidate
  const context = {
    repository: candidate.repository,
    pr_number: candidate.pr_number ?? null,
    task_id: candidate.task_id,
    task_hash: candidate.task_hash,
    base_sha: candidate.base_sha,
    head_sha: candidate.head_sha,
    diff_numstat_digest: candidate.diff_numstat_digest,
    builder_id: candidate.builder_id,
    review_mode: request.review_mode,
    execution_purpose: request.purpose ?? 'FINAL_CERTIFICATION',
    scope: [...candidate.scope],
  }
  return [
    'You are an independent, read-only code reviewer certifying an exact-diff candidate.',
    'Do not modify files, do not run mutating commands, and do not alter repository, GitHub, or controller state.',
    'Review ONLY the exact paths listed in "scope" below against the candidate identity.',
    '',
    'Candidate:',
    JSON.stringify(context, null, 2),
    '',
    'Return ONLY a single JSON object (no prose, no markdown fences) with exactly this shape:',
    '{"verdict":"APPROVE"|"BLOCK","findings":string[],"blocking_findings":string[],"reviewed_files":string[],"summary":string}',
    'Use APPROVE only when blocking_findings is empty. List every reviewed path in reviewed_files.',
  ].join('\n')
}

function defaultSpawnFn(req: OpenCodeSpawnRequest): Promise<OpenCodeSpawnResult> {
  return new Promise<OpenCodeSpawnResult>((resolve, reject) => {
    // Never forward GitHub credentials to an external reviewer process.
    const env: NodeJS.ProcessEnv = { ...process.env }
    delete env['GH_TOKEN']
    delete env['GITHUB_TOKEN']
    // Rely on cwd discovery of `<cwd>/opencode.json` and `<cwd>/.opencode/agents`.
    // Setting OPENCODE_CONFIG changes OpenCode's project-root resolution and
    // makes the read allow-list fail to match, so it is deliberately not set.
    env['PWD'] = req.cwd

    const args = [
      'run',
      '--standalone',
      ...(req.agentName ? ['--agent', req.agentName] : []),
      '--model', req.model,
      '--format', 'json',
      req.prompt,
    ]
    const child = spawn('opencode', args, {
      cwd: req.cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    })

    let stdout = ''
    let timedOut = false
    let settled = false
    const timer = setTimeout(() => {
      timedOut = true
      terminateChildTree(child)
    }, req.timeoutMs)
    timer.unref?.()

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })

    child.once('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })

    child.once('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const events = parseEventLines(stdout)
      const sessionId = extractSessionId(events)
      const exitCode = timedOut ? -1 : (code ?? -1)
      resolve({ exitCode, events, ...(sessionId ? { sessionId } : {}) })
    })
  })
}

function parseEventLines(stdout: string): unknown[] {
  const events: unknown[] = []
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = JSON.parse(trimmed) as unknown
      if (Array.isArray(parsed)) {
        events.push(...parsed)
      } else {
        events.push(parsed)
      }
    } catch {
      // Partial or non-JSON line from a streaming process; ignore.
    }
  }
  return events
}

function eventType(event: unknown): string | undefined {
  if (typeof event !== 'object' || event === null) return undefined
  const type = (event as Record<string, unknown>)['type']
  return typeof type === 'string' ? type : undefined
}

function eventText(event: unknown): string | undefined {
  if (typeof event !== 'object' || event === null) return undefined
  const record = event as Record<string, unknown>
  if (typeof record['text'] === 'string') return record['text']
  const part = record['part']
  if (typeof part === 'object' && part !== null) {
    const partText = (part as Record<string, unknown>)['text']
    if (typeof partText === 'string') return partText
  }
  return undefined
}

function extractSessionId(events: unknown[]): string | undefined {
  for (const event of events) {
    if (typeof event !== 'object' || event === null) continue
    const record = event as Record<string, unknown>
    for (const key of ['sessionID', 'sessionId', 'session_id']) {
      const value = record[key]
      if (typeof value === 'string' && value.length > 0) return value
    }
  }
  return undefined
}

/**
 * A present-but-malformed array fails closed (undefined) rather than being
 * coerced to empty: `{"verdict":"APPROVE","blocking_findings":"a defect"}` must
 * never be accepted as an approve with no blockers. An absent field defaults to
 * an empty array.
 */
function asStrictStringArray(value: unknown): string[] | undefined {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) return undefined
  return value as string[]
}

function parseReviewPayload(events: unknown[]): ParsedReview | undefined {
  let raw: string | undefined
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (eventType(event) !== 'text') continue
    const text = eventText(event)
    if (text && text.trim()) {
      raw = text
      break
    }
  }
  if (!raw) return undefined

  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return undefined

  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(raw.slice(start, end + 1))
  } catch {
    return undefined
  }
  if (typeof parsedJson !== 'object' || parsedJson === null) return undefined

  const record = parsedJson as Record<string, unknown>
  const verdict = record['verdict']
  if (verdict !== 'APPROVE' && verdict !== 'BLOCK') return undefined

  const findings = asStrictStringArray(record['findings'])
  const blockingFindings = asStrictStringArray(record['blocking_findings'])
  const reviewedFiles = asStrictStringArray(record['reviewed_files'])
  if (findings === undefined || blockingFindings === undefined || reviewedFiles === undefined) {
    return undefined
  }

  const summary = typeof record['summary'] === 'string' ? record['summary'] : undefined
  return {
    verdict,
    findings,
    blocking_findings: blockingFindings,
    reviewed_files: reviewedFiles,
    ...(summary ? { summary } : {}),
  }
}

function countToolCalls(events: unknown[]): number {
  let toolCalls = 0
  for (const event of events) {
    const type = eventType(event)
    if (type === 'tool' || type === 'tool_use' || type === 'tool_call' || type === 'tool-call') {
      toolCalls++
    }
  }
  return toolCalls
}

export function createOpenCodeReviewAdapter(options: OpenCodeReviewAdapterOptions): IndependentReviewWorkerAdapter {
  const model = options.model?.trim()
  if (!model) throw new Error('OPENCODE_ADAPTER_MODEL_REQUIRED')
  const cwd = options.cwd?.trim()
  if (!cwd) throw new Error('OPENCODE_ADAPTER_CWD_REQUIRED')
  const agentConfigPath = options.agentConfigPath?.trim()
  if (!agentConfigPath) throw new Error('OPENCODE_ADAPTER_AGENT_CONFIG_REQUIRED')

  const adapterId = options.adapterId ?? DEFAULT_ADAPTER_ID
  const agentName = options.agentName?.trim() || undefined
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const requestedAttempts = options.maxAttempts ?? 2
  const maxAttempts = Number.isInteger(requestedAttempts) ? Math.min(Math.max(requestedAttempts, 1), 3) : 2
  const spawnFn = options.spawnFn ?? defaultSpawnFn

  return {
    adapter_id: adapterId,
    agent_kind: 'opencode',
    async launch(request: Readonly<IndependentReviewExecutionRequest>): Promise<IndependentReviewExecutionResult> {
      const executionPurpose = request.purpose ?? 'FINAL_CERTIFICATION'
      const prompt = buildReviewPrompt(request)

      // Bounded retries for transient transport/parse failures only. A parsed
      // verdict (APPROVE or BLOCK) is returned on the first success and is never
      // retried, so a BLOCK cannot be retried into approval.
      let spawnResult: OpenCodeSpawnResult | undefined
      let parsed: ParsedReview | undefined
      let failureReason = 'OPENCODE_SPAWN_ERROR'
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          spawnResult = await spawnFn({ prompt, model, cwd, agentConfigPath, timeoutMs, ...(agentName ? { agentName } : {}) })
        } catch {
          failureReason = 'OPENCODE_SPAWN_ERROR'
          continue
        }
        if (spawnResult.exitCode !== 0) {
          failureReason = `OPENCODE_EXIT_${spawnResult.exitCode}`
          continue
        }
        parsed = parseReviewPayload(spawnResult.events)
        if (!parsed) {
          failureReason = `OPENCODE_EXIT_${spawnResult.exitCode}`
          continue
        }
        break
      }
      if (!parsed || !spawnResult) {
        return { status: 'FAILED', failure_reason: failureReason }
      }

      // Never certify a candidate while blocking findings exist.
      const verdict: 'APPROVE' | 'BLOCK' = parsed.verdict === 'APPROVE' && parsed.blocking_findings.length > 0
        ? 'BLOCK'
        : parsed.verdict

      // Provider attribution is intentionally unavailable for external
      // adapters: we do not observe which upstream provider served the model,
      // so requested_provider/observed_provider are omitted rather than
      // fabricated. Model attribution is 'configured' because the model was
      // supplied by the controller, not observed from the process.
      const runtime: IndependentReviewRuntime = {
        agent_kind: 'opencode',
        adapter_id: adapterId,
        controller_execution_id: request.reviewer.execution_id,
        execution_purpose: executionPurpose,
        requested_model: model,
        model_attribution: 'configured',
        fresh_context: true,
        fresh_process: true,
        ...(spawnResult.sessionId ? { session_id: spawnResult.sessionId } : {}),
      }

      return {
        status: 'COMPLETED',
        verdict,
        findings: parsed.findings,
        blocking_findings: parsed.blocking_findings,
        reviewed_at: new Date().toISOString(),
        scope: [...request.candidate.scope],
        isolation: request.required_isolation,
        execution_purpose: executionPurpose,
        usage: { tool_calls: countToolCalls(spawnResult.events) },
        runtime,
      }
    },
  }
}
