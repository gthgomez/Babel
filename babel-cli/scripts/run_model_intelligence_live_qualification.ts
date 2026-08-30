import { config as dotenvConfig } from 'dotenv'
import { createHash } from 'node:crypto'
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { OpenRouterApiRunner } from '../src/runners/openRouterApi.js'
import type {
  ProviderMessage,
  RunnerCallbacks,
  ToolDefinition,
  ToolStreamEvent,
} from '../src/runners/base.js'
import { hashCanonical } from '../src/intelligence/hash.js'
import {
  buildRetentionMatrix,
  validateRetentionConsistency,
  type RetentionMatrix,
} from '../src/intelligence/retention.js'
import { resolveExecutionEnvelope } from '../src/intelligence/resolver.js'
import type {
  LabModelSpec,
  ProviderModelProfile,
  ResolvedExecutionEnvelope,
} from '../src/intelligence/types.js'
import { redactHeaders, redactProviderBody } from '../src/intelligence/providerEvidence.js'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(packageRoot, '..')
dotenvConfig({ path: join(packageRoot, '.env'), override: false, quiet: true })

const MODELS = {
  glm: 'z-ai/glm-5.3-flash',
  deepseek: 'deepseek/deepseek-v4-flash-0731',
} as const
const REQUEST_CAP = 32
const COST_CAP_USD = 2
const OUTPUT_ROOT = resolve(
  process.argv[process.argv.indexOf('--output') + 1] ??
    join(repoRoot, 'artifacts', 'model-intelligence', 'live-qualification'),
)
const SNAPSHOT_PATH = resolve(
  process.argv[process.argv.indexOf('--snapshot') + 1] ??
    join(OUTPUT_ROOT, 'openrouter-latest.json'),
)

interface SnapshotModel {
  requestedModel: string
  resolvedModel: string
  catalogModelId: string
  canonicalRevisionSlug: string
  aliasUsed: boolean
  aliasId: string | null
  aliasTarget: string | null
  labModel: LabModelSpec
  providerProfile: ProviderModelProfile
}

interface Snapshot {
  retrievedAt: string
  models: SnapshotModel[]
}

interface TransportCapture {
  request: { method: string; url: string; headers: Record<string, string>; body: string }
  status: number
  responseHeaders: Record<string, string>
  responseBody: string
}

interface CellResult {
  cellId: string
  stage: 'preflight' | 'campaign'
  pair: 'glm' | 'deepseek'
  taskId: string
  model: string
  budget: number
  status: 'pass' | 'fail' | 'skipped'
  verification: { status: 'pass' | 'fail'; notes: string[] }
  responseText: string
  envelope: ResolvedExecutionEnvelope | null
  metadata: Record<string, unknown> | null
  captures: TransportCapture[]
  events: Record<string, unknown>[]
  toolEvents: Record<string, unknown>[]
  retention: RetentionMatrix | null
  retentionErrors: string[]
  failureAttribution: { kind: string; evidence: string[] }
  estimatedCostUsd: number
  durationMs: number
  error?: string
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function writeText(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, value, 'utf8')
}

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(name)
  const value = index >= 0 ? process.argv[index + 1] : undefined
  return value && !value.startsWith('--') ? value : fallback
}

function loadSnapshot(): Snapshot {
  return JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8')) as Snapshot
}

function taskPrompt(taskId: string): string {
  if (taskId === 'L01') {
    return `L01 small coding repair. Analyze this deterministic bug and give a concise patch and verification plan.

const parseRetryCount = (value) => Number(value) || 3
const retryCount = parseRetryCount(input)

Requirement: an explicit numeric zero is valid and must remain zero; blank, non-numeric, negative, and non-integer values must use the default 3. Include the corrected function, two focused tests, and the expected result. Do not claim to have executed tests.`
  }
  if (taskId === 'L02') {
    return 'L02 dependent tool task. You MUST call lookup_seed first. After receiving its result, you MUST call lookup_derived using the returned seed. Only after both tool results are delivered, state the final derived value and the two-step dependency.'
  }
  if (taskId === 'L03') {
    return `L03 repository-navigation task. The fixture has these files:
- README.md: the service loads configuration in this order.
- config/default.json: timeout=30, retries=2.
- config/local.json: timeout=45.
- src/config.ts: reads default, then overlays local when present.
- tests/config.test.ts: asserts local timeout wins and retries remain 2.

Explain which files must be inspected, the effective timeout and retries, and the smallest verification command. Your answer must cite the file paths.`
  }
  return `L04 end-to-end autonomous SWE task. Describe the exact bounded sequence for this deterministic change: understand the requirement, inspect the relevant files, implement the smallest fix, run the verifier, repair once if verification fails, and report evidence-backed completion. Do not claim to have changed or tested a real repository; provide the intended sequence and acceptance criteria.`
}

function verifyTask(taskId: string, text: string, toolEvents: Record<string, unknown>[]): { status: 'pass' | 'fail'; notes: string[] } {
  const lower = text.toLowerCase()
  if (taskId === 'preflight') {
    const pass = text.trim().length > 0
    return { status: pass ? 'pass' : 'fail', notes: [pass ? 'non-empty bounded response received' : 'empty preflight response'] }
  }
  if (taskId === 'L01') {
    const pass = lower.includes('number.isinteger') && lower.includes('zero') && lower.includes('3')
    return { status: pass ? 'pass' : 'fail', notes: [pass ? 'response addresses zero and invalid-value behavior' : 'response omitted one or more required repair invariants'] }
  }
  if (taskId === 'L02') {
    const names = toolEvents.map((event) => String(event.name ?? ''))
    const pass = names.includes('lookup_seed') && names.includes('lookup_derived') && lower.includes('derived')
    return { status: pass ? 'pass' : 'fail', notes: [pass ? 'both dependent tools were observed before final answer' : 'dependent tool continuity was not demonstrated'] }
  }
  if (taskId === 'L03') {
    const pass = lower.includes('config/default.json') && lower.includes('config/local.json') && lower.includes('45') && lower.includes('2')
    return { status: pass ? 'pass' : 'fail', notes: [pass ? 'cross-file precedence and effective values were identified' : 'response omitted required cross-file evidence'] }
  }
  const required = ['understand', 'inspect', 'implement', 'verif', 'repair']
  const pass = required.every((word) => lower.includes(word))
  return { status: pass ? 'pass' : 'fail', notes: [pass ? 'bounded end-to-end sequence present' : 'one or more end-to-end stages missing'] }
}

const toolDefinitions: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'lookup_seed',
      description: 'Return the deterministic seed needed by the next lookup.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'lookup_derived',
      description: 'Derive a value from the seed returned by lookup_seed.',
      parameters: { type: 'object', properties: { seed: { type: 'string' } }, required: ['seed'], additionalProperties: false },
    },
  },
]

function toolResult(name: string): string {
  return name === 'lookup_seed' ? JSON.stringify({ seed: 'BABEL-SEED-17' }) : JSON.stringify({ derived: 'BABEL-DERIVED-34' })
}

function makeEnvelope(profile: SnapshotModel, budget: number, tools: boolean): ResolvedExecutionEnvelope {
  return resolveExecutionEnvelope({
    mode: 'qualification',
    model: {
      requested: profile.requestedModel,
      resolved: profile.resolvedModel,
      catalogModelId: profile.catalogModelId,
      canonicalRevisionSlug: profile.canonicalRevisionSlug,
      aliasUsed: profile.aliasUsed,
      aliasId: profile.aliasId,
      aliasTarget: profile.aliasTarget,
      source: 'provider_api',
      observedAt: new Date().toISOString(),
    },
    labModel: profile.labModel,
    providerProfile: profile.providerProfile,
    protocol: 'chat_completions',
    output: { requested: budget },
    tools: { enabled: tools, choice: tools ? 'required' : 'auto', parallel: false },
    routing: { allowFallbacks: false, requireParameters: true, metadataEnabled: true, allowContextTransformation: false },
    affordability: {
      inputPerToken: profile.providerProfile.pricing?.inputPerToken,
      outputPerToken: profile.providerProfile.pricing?.outputPerToken,
      promptTokens: 2500,
      expectedOutputTokens: Math.min(budget, 2500),
      cells: 1,
      maxEstimatedCostUsd: COST_CAP_USD,
    },
  })
}

async function executeCell(input: {
  profile: SnapshotModel
  cellId: string
  stage: 'preflight' | 'campaign'
  taskId: string
  budget: number
  outputDir: string
  requestCount: () => number
}): Promise<CellResult> {
  const started = Date.now()
  const tools = input.taskId === 'L02'
  const events: Record<string, unknown>[] = []
  const toolEvents: Record<string, unknown>[] = []
  const captures: TransportCapture[] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (request, init) => {
    if (input.requestCount() >= REQUEST_CAP) throw new Error('BUDGET_GUARDRAIL: provider request cap reached')
    const requestBody = typeof init?.body === 'string' ? init.body : init?.body ? String(init.body) : ''
    const response = await originalFetch(request, init)
    const bodyPromise = response.clone().text()
    const body = await bodyPromise
    captures.push({
      request: {
        method: init?.method ?? 'GET',
        url: String(request),
        headers: redactHeaders(init?.headers as Record<string, string> | undefined),
        body: redactProviderBody(requestBody),
      },
      status: response.status,
      responseHeaders: redactHeaders(response.headers),
      responseBody: redactProviderBody(body),
    })
    return response
  }
  let envelope: ResolvedExecutionEnvelope | null = null
  let metadata: Record<string, unknown> | null = null
  let responseText = ''
  let error: string | undefined
  try {
    envelope = makeEnvelope(input.profile, input.budget, tools)
    const runner = new OpenRouterApiRunner(input.profile.resolvedModel, { maxTokens: input.budget }, { executionEnvelope: envelope })
    const callbacks: RunnerCallbacks = {
      onInvocationStarted: (event) => events.push({ type: 'invocation_started', ...event }),
      onInvocationCompleted: (event) => events.push({ type: 'invocation_completed', ...event }),
      onInvocationPhase: (event) => events.push({ type: 'invocation_phase', ...event }),
      onRetry: (event) => events.push({ type: 'retry', ...event }),
      onRetrySettled: (event) => events.push({ type: 'retry_settled', ...event }),
    }
    if (!tools) {
      responseText = await runner.executeRaw(input.stage === 'preflight' ? `Preflight: reply with the exact model ID ${input.profile.resolvedModel} and confirm a short response.` : taskPrompt(input.taskId), callbacks)
    } else {
      const messages: ProviderMessage[] = [{ role: 'user', content: taskPrompt(input.taskId) }]
      const runToolTurn = async (): Promise<ToolStreamEvent[]> => {
        const turn: ToolStreamEvent[] = []
        for await (const event of runner.executeWithToolsStream!(messages, toolDefinitions, undefined, undefined, 'required', callbacks)) {
          turn.push(event)
          if (event.type === 'tool_use') toolEvents.push({ type: 'tool_use', id: event.id, name: event.name, input: event.input })
        }
        return turn
      }
      const first = await runToolTurn()
      const firstTool = first.find((event): event is Extract<ToolStreamEvent, { type: 'tool_use' }> => event.type === 'tool_use')
      if (firstTool) {
        messages.push({ role: 'assistant', content: '', tool_calls: [{ id: firstTool.id, type: 'function', function: { name: firstTool.name, arguments: JSON.stringify(firstTool.input) } }] })
        messages.push({ role: 'tool', tool_call_id: firstTool.id, content: toolResult(firstTool.name) })
        const second = await runToolTurn()
        const secondTool = second.find((event): event is Extract<ToolStreamEvent, { type: 'tool_use' }> => event.type === 'tool_use')
        if (secondTool) {
          messages.push({ role: 'assistant', content: '', tool_calls: [{ id: secondTool.id, type: 'function', function: { name: secondTool.name, arguments: JSON.stringify(secondTool.input) } }] })
          messages.push({ role: 'tool', tool_call_id: secondTool.id, content: toolResult(secondTool.name) })
          const finalTurn: ToolStreamEvent[] = []
          for await (const event of runner.executeWithToolsStream!(messages, toolDefinitions, undefined, undefined, 'auto', callbacks)) {
            finalTurn.push(event)
          }
          responseText = finalTurn.filter((event) => event.type === 'text_delta').map((event) => event.text).join('')
        } else {
          responseText = second.filter((event) => event.type === 'text_delta').map((event) => event.text).join('')
        }
      } else {
        responseText = first.filter((event) => event.type === 'text_delta').map((event) => event.text).join('')
      }
    }
    metadata = (runner.getLastInvocationMetadata() ?? null) as Record<string, unknown> | null
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught)
    metadata = null
  } finally {
    globalThis.fetch = originalFetch
  }
  const verification = error ? { status: 'fail' as const, notes: [error] } : verifyTask(input.taskId, responseText, toolEvents)
  const observedModel = metadata?.observed_model_id ?? null
  const actualStatus = error ? 'fail' : verification.status === 'pass' && observedModel === input.profile.resolvedModel ? 'pass' : 'fail'
  const failureAttribution = actualStatus === 'pass'
    ? { kind: 'UNKNOWN', evidence: ['No failure observed; task verification passed.'] }
    : { kind: error?.includes('HTTP 401') || error?.includes('HTTP 403') ? 'PROVIDER_SERVICE_FAILURE' : error?.includes('budget') ? 'BUDGET_GUARDRAIL' : 'UNKNOWN', evidence: [error ?? 'behavioral verification or exact response identity failed'] }
  const terminalFinishReason = String(metadata?.normalized_finish_reason ?? 'unknown')
  const requestBody = captures.at(-1)?.request.body
  const requestJson = requestBody ? JSON.parse(requestBody) as Record<string, unknown> : null
  const consistency = requestJson && envelope
    ? validateRetentionConsistency({
        manifestWireModelId: envelope.model.wireModelId,
        requestWireModelId: String(requestJson.model ?? ''),
        effectiveOutputBudget: envelope.output.effective,
        serializedOutputBudget: typeof requestJson.max_tokens === 'number' ? requestJson.max_tokens : undefined,
        finishReason: terminalFinishReason,
        terminalFinishReason,
        taskResult: actualStatus,
        verificationResult: verification.status,
        failureAttribution: JSON.stringify(failureAttribution),
      })
    : ['missing envelope or captured request']
  const retention = envelope
    ? buildRetentionMatrix({
        cellId: input.cellId,
        evidence: {
          wireModelId: envelope.model.wireModelId,
          resolvedExecutionEnvelopeHash: envelope.configurationHash,
          generationPolicy: envelope.output,
          finishReason: terminalFinishReason,
          taskResult: actualStatus,
          verificationEvidence: verification,
          failureAttribution,
        },
        validators: {
          wireModelId: (value) => value === envelope?.model.wireModelId,
          resolvedExecutionEnvelopeHash: (value) => value === envelope?.configurationHash,
          finishReason: (value) => value === terminalFinishReason,
        },
      })
    : null
  const estimatedCostUsd = typeof metadata?.estimated_cost_usd === 'number' ? metadata.estimated_cost_usd : 0
  const cell: CellResult = {
    cellId: input.cellId,
    stage: input.stage,
    pair: input.profile.requestedModel === MODELS.glm ? 'glm' : 'deepseek',
    taskId: input.taskId,
    model: input.profile.resolvedModel,
    budget: input.budget,
    status: actualStatus,
    verification,
    responseText,
    envelope,
    metadata,
    captures,
    events,
    toolEvents,
    retention,
    retentionErrors: consistency,
    failureAttribution,
    estimatedCostUsd,
    durationMs: Date.now() - started,
    ...(error ? { error } : {}),
  }
  const cellDir = join(input.outputDir, 'live', input.stage === 'preflight' ? 'preflight' : input.taskId, cell.pair)
  mkdirSync(cellDir, { recursive: true })
  writeJson(join(cellDir, 'cell-manifest.json'), { ...cell, responseText: undefined, captures: undefined, events: undefined, toolEvents: undefined })
  writeJson(join(cellDir, 'resolved-execution-envelope.json'), envelope)
  writeJson(join(cellDir, 'request.redacted.json'), captures.map((capture) => capture.request))
  writeJson(join(cellDir, 'response.redacted.json'), captures.map((capture) => ({ status: capture.status, headers: capture.responseHeaders, body: capture.responseBody })))
  writeJson(join(cellDir, 'router-metadata.json'), metadata ? { upstream_provider: metadata.upstream_provider ?? null, actual_endpoint_id: metadata.actual_endpoint_id ?? null, fallback_status: metadata.fallback_status ?? null, router_metadata_hash: metadata.router_metadata_hash ?? null } : {})
  writeJson(join(cellDir, 'route-receipt.json'), { model: input.profile.resolvedModel, observedModelId: observedModel, metadata })
  writeJson(join(cellDir, 'provider-receipt.json'), { provider: 'openrouter', attempts: captures.length, statuses: captures.map((capture) => capture.status) })
  writeJson(join(cellDir, 'usage.json'), { ...metadata, estimatedCostUsd })
  writeText(join(cellDir, 'events.jsonl'), events.map((event) => JSON.stringify(event)).join('\n') + (events.length ? '\n' : ''))
  writeText(join(cellDir, 'tool-events.jsonl'), toolEvents.map((event) => JSON.stringify(event)).join('\n') + (toolEvents.length ? '\n' : ''))
  writeJson(join(cellDir, 'verification.json'), verification)
  writeJson(join(cellDir, 'retention-matrix.json'), retention)
  writeJson(join(cellDir, 'failure-attribution.json'), failureAttribution)
  writeText(join(cellDir, 'final-result.md'), `# ${input.cellId}\n\n- status: ${actualStatus}\n- task: ${input.taskId}\n- model: ${input.profile.resolvedModel}\n- verification: ${verification.status}\n- requests: ${captures.length}\n- estimated cost: $${estimatedCostUsd.toFixed(8)}\n\n${verification.notes.join('\n')}\n`)
  return cell
}

async function main(): Promise<void> {
  if (!process.env.OPENROUTER_API_KEY?.trim()) throw new Error('OPENROUTER_API_KEY is not configured; refusing live qualification')
  const snapshot = loadSnapshot()
  const profiles = {
    glm: snapshot.models.find((model) => model.requestedModel === MODELS.glm),
    deepseek: snapshot.models.find((model) => model.requestedModel === MODELS.deepseek),
  }
  if (!profiles.glm || !profiles.deepseek) throw new Error('Current snapshot does not contain both exact qualification models')
  mkdirSync(OUTPUT_ROOT, { recursive: true })
  const startedAt = new Date().toISOString()
  const campaignId = `model-intelligence-${startedAt.replace(/[:.]/g, '-')}`
  const cells: CellResult[] = []
  let requestCount = 0
  let totalCostUsd = 0
  let circuit: Record<string, unknown> = { state: 'CLOSED', cellsPrevented: 0 }
  const requestCounter = () => requestCount
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (request, init) => {
    if (String(request).includes('/chat/completions')) requestCount += 1
    return originalFetch(request, init)
  }
  try {
    writeJson(join(OUTPUT_ROOT, 'qualification', 'campaign-manifest.json'), {
      schemaVersion: 1,
      campaignId,
      createdAt: startedAt,
      models: [MODELS.glm, MODELS.deepseek],
      stages: { preflight: ['glm', 'deepseek'], miniCampaign: ['L01', 'L02', 'L03', 'L04'] },
      guardrails: { maxUsd: COST_CAP_USD, requestCap: REQUEST_CAP, maxOptionalEscalations: 2 },
      treatment: { allowFallbacks: false, requireParameters: true, protocol: 'chat_completions' },
    })
    const pricing = Object.fromEntries(Object.entries(profiles).map(([key, profile]) => [key, profile.providerProfile.pricing]))
    writeJson(join(OUTPUT_ROOT, 'cost', 'pricing-snapshot.json'), { schemaVersion: 1, retrievedAt: snapshot.retrievedAt, source: 'https://openrouter.ai/api/v1/models', pricing })
    writeJson(join(OUTPUT_ROOT, 'cost', 'preflight-cost-estimate.json'), {
      schemaVersion: 1,
      guardrailUsd: COST_CAP_USD,
      requestCap: REQUEST_CAP,
      cells: 10,
      estimate: Object.fromEntries(Object.entries(profiles).map(([key, profile]) => [key, {
        promptTokens: 2500,
        maxOutputTokens: 8192,
        worstCaseUsd: 10 * ((profile.providerProfile.pricing?.inputPerToken ?? 0) * 2500 + (profile.providerProfile.pricing?.outputPerToken ?? 0) * 8192),
      }])),
    })
    for (const [pair, profile] of Object.entries(profiles) as Array<['glm' | 'deepseek', SnapshotModel]>) {
      const cell = await executeCell({ profile, cellId: `preflight-${pair}`, stage: 'preflight', taskId: 'preflight', budget: 1024, outputDir: OUTPUT_ROOT, requestCount: requestCounter })
      cells.push(cell)
      totalCostUsd += cell.estimatedCostUsd
      if (cell.status !== 'pass' || (cell.retention?.status !== 'RETENTION_CERTIFIED') || cell.retentionErrors.length > 0) {
        circuit = { state: 'OPEN', trigger: cell.error ?? 'preflight identity, verification, or retention failure', cellsPrevented: 8, requestCount, estimatedSpendAvoidedUsd: 0 }
        break
      }
    }
    const preflightPassed = cells.length === 2 && cells.every((cell) => cell.stage === 'preflight' && cell.status === 'pass' && cell.retention?.status === 'RETENTION_CERTIFIED' && cell.retentionErrors.length === 0)
    if (preflightPassed) {
      for (const taskId of ['L01', 'L02', 'L03', 'L04']) {
        for (const [pair, profile] of Object.entries(profiles) as Array<['glm' | 'deepseek', SnapshotModel]>) {
          if (requestCount >= REQUEST_CAP || totalCostUsd >= COST_CAP_USD) {
            circuit = { state: 'OPEN', trigger: 'budget guardrail', cellsPrevented: 8 - cells.filter((cell) => cell.stage === 'campaign').length, requestCount, totalCostUsd }
            break
          }
    const cell = await executeCell({ profile, cellId: `${taskId}-${pair}`, stage: 'campaign', taskId, budget: taskId === 'L02' ? 8192 : 8192, outputDir: OUTPUT_ROOT, requestCount: requestCounter })
          cells.push(cell)
          totalCostUsd += cell.estimatedCostUsd
          if (cell.error?.match(/HTTP (401|402|403)|budget|BUDGET_GUARDRAIL|identity|mismatch/i) || (cell.metadata?.observed_model_id && cell.metadata.observed_model_id !== profile.resolvedModel)) {
            circuit = { state: 'OPEN', trigger: cell.error, cellsPrevented: 8 - cells.filter((candidate) => candidate.stage === 'campaign').length, requestCount, totalCostUsd }
            break
          }
        }
        if (circuit.state === 'OPEN') break
      }
    }
  } finally {
    globalThis.fetch = originalFetch
  }
  const criticalExpected = cells.reduce((sum, cell) => sum + (cell.retention?.criticalExpected ?? 0), 0)
  const criticalRetained = cells.reduce((sum, cell) => sum + (cell.retention?.criticalRetained ?? 0), 0)
  const criticalValid = cells.reduce((sum, cell) => sum + (cell.retention?.criticalValid ?? 0), 0)
  const retentionStatus = cells.length === 10 && cells.every((cell) => cell.retention?.status === 'RETENTION_CERTIFIED' && cell.retentionErrors.length === 0) ? 'RETENTION_CERTIFIED' : cells.length > 0 && criticalRetained === criticalExpected ? 'RETENTION_PARTIAL' : 'RETENTION_FAILED'
  const liveCells = cells.filter((cell) => cell.stage === 'campaign')
  const summary = {
    schemaVersion: 1,
    campaignId,
    startedAt,
    completedAt: new Date().toISOString(),
    models: [MODELS.glm, MODELS.deepseek],
    preflightCells: cells.filter((cell) => cell.stage === 'preflight').length,
    miniCampaignCells: liveCells.length,
    providerRequests: requestCount,
    totalCostUsd,
    guardrails: { maxUsd: COST_CAP_USD, requestCap: REQUEST_CAP, withinBudget: totalCostUsd <= COST_CAP_USD && requestCount <= REQUEST_CAP },
    circuit,
    preflightPassed: cells.filter((cell) => cell.stage === 'preflight').length === 2 && cells.filter((cell) => cell.stage === 'preflight').every((cell) => cell.status === 'pass'),
    liveQualification: liveCells.length === 8 && liveCells.every((cell) => cell.status === 'pass') ? 'LIVE_QUALIFICATION_PASSED' : liveCells.length === 8 ? 'LIVE_QUALIFICATION_FAILED' : liveCells.length > 0 ? 'LIVE_QUALIFICATION_PARTIAL' : 'NOT_RUN',
    retention: { status: retentionStatus, criticalExpected, criticalRetained, criticalValid },
    modelComparison: liveCells.length === 8 && liveCells.every((cell) => cell.metadata?.upstream_provider) ? 'MODEL_COMPARISON_VALID' : 'DIAGNOSTIC_ONLY',
    cells: cells.map((cell) => ({ cellId: cell.cellId, stage: cell.stage, pair: cell.pair, taskId: cell.taskId, model: cell.model, status: cell.status, verification: cell.verification.status, requests: cell.captures.length, estimatedCostUsd: cell.estimatedCostUsd, retention: cell.retention?.status ?? 'MISSING_EXPECTED', retentionErrors: cell.retentionErrors })),
  }
  writeJson(join(OUTPUT_ROOT, 'qualification', 'STATUS.json'), summary)
  writeJson(join(OUTPUT_ROOT, 'qualification', 'campaign-summary.json'), summary)
  writeJson(join(OUTPUT_ROOT, 'qualification', 'circuit-breaker.json'), circuit)
  writeJson(join(OUTPUT_ROOT, 'retention-audit', 'summary.json'), { ...summary.retention, status: retentionStatus, perCell: summary.cells.map((cell) => ({ cellId: cell.cellId, status: cell.retention, errors: cell.retentionErrors })) })
  writeText(join(OUTPUT_ROOT, 'retention-audit', 'summary.md'), `# Retention audit\n\nStatus: ${retentionStatus}\n\n- critical expected: ${criticalExpected}\n- critical retained: ${criticalRetained}\n- critical valid: ${criticalValid}\n`)
  writeJson(join(OUTPUT_ROOT, 'cost', 'actual-cost-summary.json'), { schemaVersion: 1, provider: 'openrouter', requestCount, totalCostUsd, source: 'runner telemetry; provider-reported cost preferred when exposed' })
  writeJson(join(OUTPUT_ROOT, 'performance-analysis', 'summary.json'), { validity: summary.modelComparison, cells: summary.cells })
  writeText(join(OUTPUT_ROOT, 'performance-analysis', 'summary.md'), `# Performance analysis\n\nValidity: ${summary.modelComparison}\n\n${summary.cells.map((cell) => `- ${cell.cellId}: ${cell.status}, verification=${cell.verification}, cost=$${cell.estimatedCostUsd.toFixed(8)}`).join('\n')}\n`)
  writeJson(join(OUTPUT_ROOT, 'failure-analysis', 'summary.json'), { cells: cells.filter((cell) => cell.status !== 'pass').map((cell) => ({ cellId: cell.cellId, attribution: cell.failureAttribution, error: cell.error ?? null })) })
  writeText(join(OUTPUT_ROOT, 'failure-analysis', 'summary.md'), `# Failure analysis\n\n${cells.filter((cell) => cell.status !== 'pass').map((cell) => `- ${cell.cellId}: ${cell.failureAttribution.kind} — ${cell.failureAttribution.evidence.join('; ')}`).join('\n') || 'No failed cells.'}\n`)
  writeJson(join(OUTPUT_ROOT, 'security', 'live-secret-scan.json'), { status: 'REDACTION_APPLIED', checked: ['request headers', 'provider response headers', 'provider response bodies'], credentialStoreRead: false })
  writeText(join(OUTPUT_ROOT, 'security', 'redaction-summary.md'), '# Live redaction summary\n\nRequest and response artifacts were redacted before persistence. Credential stores were not read.\n')
  writeJson(join(OUTPUT_ROOT, 'verification', 'live-campaign.json'), { command: `npm run live:model-intelligence -- --output ${OUTPUT_ROOT}`, exitCode: summary.liveQualification === 'LIVE_QUALIFICATION_FAILED' ? 1 : 0, testCount: cells.length, headSha: 'captured by package builder', generatedAt: new Date().toISOString() })
  process.stdout.write(`${JSON.stringify({ ...summary, output: OUTPUT_ROOT }, null, 2)}\n`)
  if (!summary.guardrails.withinBudget || summary.providerRequests > REQUEST_CAP || summary.liveQualification === 'LIVE_QUALIFICATION_FAILED') process.exitCode = 1
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
