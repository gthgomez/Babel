/**
 * Live ChatEngine canary cell: isolated workspace + chat-headless + clean-room grade.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { BABEL_ROOT } from '../../cli/constants.js'
import {
  isOpenRouterDeepSeekLiveModelId,
  LIVE_OPENROUTER_DEEPSEEK_BACKEND_KEYS,
  LIVE_OPENROUTER_MODEL_ID,
} from '../../modelPolicy.js'
import { resolveBabelCliEntry, runBabelCli } from '../../services/liteTrustDemo.js'
import {
  inspectSessionEventLogFromDir,
  loadSessionEventLogFromDir,
  type SessionEvent,
} from '../../agent/sessionEvents.js'
import {
  buildCausalAttributionReport,
  type CausalRunWhyReport,
} from '../../services/causalAttribution.js'
import { redactSecrets, redactSecretsDeep } from '../../utils/secretRedaction.js'
import { gradeInCleanRoom, type CleanRoomFile } from '../cleanRoomGrade.js'
import type { CanaryTaskSpec } from './types.js'
import type { OpenRouterRoutingPolicy } from '../../runners/openRouterApi.js'

const LIVE_AGENT_TIMEOUT_MS = 10 * 60 * 1000

export interface LiveCellLaunch {
  model: string
  workspaceRoot: string
  evidencePath: string
}

export interface LiveCellOutcome {
  status: string | null
  claimed_complete: boolean
  honest_block: boolean
  tokens: number | null
  cost_usd: number | null
  production_files: CleanRoomFile[]
  deleted_production_paths: string[]
  production_mutated: boolean
  hidden_ok: boolean
  visible_ok: boolean | null
  stdout_tail: string
  notes: string[]
  run_dir: string | null
  baseline_sha: string | null
  harness_sha: string | null
  evidence_path: string
  causal_attribution: CausalRunWhyReport
}

function gitHead(root: string): string | null {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  })
  if (result.status !== 0) return null
  const head = result.stdout.trim()
  return head.length > 0 ? head : null
}

function safeEnvironmentSnapshot(
  root: string,
  boundary: { hostFallbackExplicit: boolean },
): Record<string, string | null> {
  return {
    platform: process.platform,
    arch: process.arch,
    node_version: process.version,
    cwd: process.cwd(),
    workspace_root: root,
    execution_profile: process.env['BABEL_EXECUTION_PROFILE'] ?? null,
    host_fallback_explicit: boundary.hostFallbackExplicit ? 'true' : 'false',
    execution_domain: boundary.hostFallbackExplicit ? 'host_explicit' : 'unknown',
    docker_disabled: process.env['BABEL_DOCKER_DISABLE'] === 'true' ? 'true' : 'false',
  }
}

function eventTime(event: SessionEvent): number | null {
  const value = Date.parse(event.ts)
  return Number.isFinite(value) ? value : null
}

function sessionTelemetry(events: readonly SessionEvent[]): Record<string, unknown> {
  const inputs = events.filter((event): event is Extract<SessionEvent, { kind: 'model_input_receipt' }> => event.kind === 'model_input_receipt')
  const results = events.filter((event): event is Extract<SessionEvent, { kind: 'model_result_delivery' }> => event.kind === 'model_result_delivery')
  const phases = events.filter((event): event is Extract<SessionEvent, { kind: 'model_invocation_phase' }> => event.kind === 'model_invocation_phase')
  const byInference = new Map<string, { input: Extract<SessionEvent, { kind: 'model_input_receipt' }> | null; result: Extract<SessionEvent, { kind: 'model_result_delivery' }> | null; phases: Extract<SessionEvent, { kind: 'model_invocation_phase' }>[] }>()
  for (const input of inputs) byInference.set(input.inference_id, { input, result: null, phases: [] })
  for (const result of results) {
    const current = byInference.get(result.inference_id) ?? { input: null, result: null, phases: [] }
    current.result = result
    byInference.set(result.inference_id, current)
  }
  for (const phase of phases) {
    const current = byInference.get(phase.inference_id) ?? { input: null, result: null, phases: [] }
    current.phases.push(phase)
    byInference.set(phase.inference_id, current)
  }
  const inferenceTelemetry = [...byInference.entries()].map(([inference_id, value]) => {
    const start = value.input ? eventTime(value.input) : null
    const end = value.result ? eventTime(value.result) : null
    const firstByte = value.phases.find((phase) => phase.phase === 'first_byte')
    return {
      inference_id,
      requested_model_id: value.input?.requested_model_id ?? null,
      sent_model_id: value.input?.sent_model_id ?? null,
      observed_model_id: value.result?.observed_model_id ?? null,
      upstream_provider:
        value.result?.upstream_provider ?? value.input?.route_receipt?.upstream_provider ?? null,
      provider: value.input?.provider ?? value.result?.provider ?? null,
      stage: value.input?.route_receipt?.execution_stage ?? null,
      status: value.result?.status ?? 'missing_result',
      delivery_status: value.result?.status ?? 'missing',
      latency_ms: start !== null && end !== null ? Math.max(0, end - start) : null,
      first_byte_ms: start !== null && firstByte ? Math.max(0, (eventTime(firstByte) ?? start) - start) : null,
      retry_count: value.result?.route_receipt?.retry_count ?? null,
      context_preservation: value.input?.context_manifest?.preservation_status ?? null,
    }
  })

  const toolEvents = events.filter((event): event is Extract<SessionEvent, { kind: 'tool_proposed' | 'tool_started' | 'tool_completed' | 'tool_failed' | 'tool_cancelled' }> => event.kind === 'tool_proposed' || event.kind === 'tool_started' || event.kind === 'tool_completed' || event.kind === 'tool_failed' || event.kind === 'tool_cancelled')
  const toolIds = [...new Set(toolEvents.map((event) => event.tool_call_id))]
  const deliveredToolIds = new Set(inputs.flatMap((input) => input.delivered_tool_call_ids ?? []))
  const proposedTools = toolEvents.filter((event): event is Extract<SessionEvent, { kind: 'tool_proposed' }> => event.kind === 'tool_proposed')
  const capabilityBindings = events.filter((event): event is Extract<SessionEvent, { kind: 'capability_binding_receipt' }> => event.kind === 'capability_binding_receipt')
  const toolLifecycle = toolIds.map((tool_call_id) => {
    const lifecycle = toolEvents.filter((event) => event.tool_call_id === tool_call_id)
    const proposed = lifecycle.some((event) => event.kind === 'tool_proposed')
    const started = lifecycle.some((event) => event.kind === 'tool_started')
    const terminal = lifecycle.find((event) => event.kind === 'tool_completed' || event.kind === 'tool_failed' || event.kind === 'tool_cancelled')
    return {
      tool_call_id,
      tool_name: lifecycle[0]?.tool_name ?? null,
      proposed,
      authorized: events.some((event) => event.kind === 'capability_binding_receipt' && event.capability === lifecycle[0]?.tool_name && event.authorized === true),
      dispatched: started,
      started,
      terminal: terminal?.kind ?? null,
      result_captured: terminal?.kind === 'tool_completed' || terminal?.kind === 'tool_failed',
      result_delivered_to_model: deliveredToolIds.has(tool_call_id),
      error_family: terminal?.kind === 'tool_failed' ? (terminal.error_preview?.match(/ENOENT|EACCES|EPERM|timeout|spawn|denied/i)?.[0] ?? 'tool_failure') : null,
    }
  })

  const verifierEvents = events.filter((event): event is Extract<SessionEvent, { kind: 'verifier_attempt' }> => event.kind === 'verifier_attempt')
  const mutations = events.filter((event): event is Extract<SessionEvent, { kind: 'mutation_batch' }> => event.kind === 'mutation_batch')
  const repeated = new Map<string, number>()
  for (const event of toolEvents.filter((candidate) => candidate.kind === 'tool_proposed')) {
    const key = `${event.tool_name}:${event.target_summary ?? ''}`
    repeated.set(key, (repeated.get(key) ?? 0) + 1)
  }
  const timestamps = events.map(eventTime).filter((value): value is number => value !== null)
  const capabilityAuthorizationKnown = proposedTools.every((proposal) => {
    const binding = capabilityBindings.find((candidate) => candidate.capability === proposal.tool_name)
    if (binding?.authorized !== null && binding?.authorized !== undefined) return true
    const lifecycle = toolEvents.filter((event) => event.tool_call_id === proposal.tool_call_id)
    return lifecycle.some((event) => event.kind === 'tool_started' ||
      (event.kind === 'tool_cancelled' && event.recovery_state === 'TOOL_NOT_STARTED'))
  })
  const toolTerminalKnown = proposedTools.every((proposal) => {
    const lifecycle = toolEvents.filter((event) => event.tool_call_id === proposal.tool_call_id)
    return lifecycle.some((event) =>
      event.kind === 'tool_completed' || event.kind === 'tool_failed' || event.kind === 'tool_cancelled',
    )
  })
  // A failed or undelivered result is still known evidence. This field means
  // the harness established the terminal delivery status, not that delivery
  // succeeded. A proposed tool without a terminal event remains unknown.
  const resultDeliveryKnown = toolLifecycle.every((tool) =>
    !tool.proposed || tool.terminal !== null,
  )
  return {
    inference_calls: inferenceTelemetry,
    tool_lifecycle: toolLifecycle,
    capability_authorization_known: capabilityAuthorizationKnown,
    tool_terminal_known: toolTerminalKnown,
    result_delivery_known: resultDeliveryKnown,
    verification_revision_known: verifierEvents.every((event) => Boolean(event.receipt?.receiptId && event.receipt?.boundRevision?.compositeTreeHash)),
    verification: verifierEvents.map((event) => ({
      verifier_id: event.receipt?.verifier_id ?? null,
      command: redactSecrets(event.command_preview),
      authoritative: event.authoritative,
      exit_code: event.exit_code ?? null,
      revision_bound: Boolean(event.receipt?.receiptId && event.receipt?.boundRevision?.compositeTreeHash),
      stale: event.receipt?.stale ?? null,
    })),
    workspace: {
      mutation_count: mutations.length,
      changed_bytes: mutations.reduce((total, event) => total + (event.changed_bytes ?? 0), 0),
      changed_paths: [...new Set(mutations.flatMap((event) => event.paths))].sort(),
      first_write_seq: mutations[0]?.seq ?? null,
    },
    harness_friction: {
      repeated_tool_signatures: [...repeated.entries()].filter(([, count]) => count > 1).map(([signature, count]) => ({ signature, count })),
      failed_tool_count: toolLifecycle.filter((tool) => tool.terminal === 'tool_failed').length,
      retry_count: events.filter((event) => event.kind === 'provider_retry_scheduled').length,
      policy_intervention_count: events.filter((event) => event.kind === 'policy_intervened').length,
      recovery_attempt_count: events.filter((event) => event.kind === 'progress_recovery' || event.kind === 'repair_attempt').length,
      compaction_count: events.filter((event) => event.kind === 'compaction_committed').length,
    },
    wall_time_ms: timestamps.length > 1 ? Math.max(0, Math.max(...timestamps) - Math.min(...timestamps)) : null,
  }
}

function sessionEvidenceSummary(
  runDir: string | null,
  cliPayload: Record<string, unknown> | null,
): Record<string, unknown> {
  const productTelemetry = {
    turn_telemetry: redactSecretsDeep(cliPayload?.['turnTelemetry'] ?? null),
    tool_calls: redactSecretsDeep(cliPayload?.['toolCalls'] ?? null),
    policy_events: redactSecretsDeep(cliPayload?.['policyEvents'] ?? null),
    turn_routing: redactSecretsDeep(cliPayload?.['turnRouting'] ?? null),
    turn_summaries: redactSecretsDeep(cliPayload?.['turnSummaries'] ?? null),
    blocked_attempts: redactSecretsDeep(cliPayload?.['blockedAttempts'] ?? null),
    blocked_attempt_counts: redactSecretsDeep(cliPayload?.['blockedAttemptCounts'] ?? null),
  }
  if (!runDir) return { status: 'missing_run_dir', product_telemetry: productTelemetry }
  const log = loadSessionEventLogFromDir(runDir)
  if (!log) {
    return {
      status: 'missing_or_invalid_session_events',
      product_telemetry: productTelemetry,
    }
  }
  const inputs = log.events.filter((event) => event.kind === 'model_input_receipt')
  const results = log.events.filter((event) => event.kind === 'model_result_delivery')
  const upstreamProviders = [...new Set(
    results
      .map((event) => event.upstream_provider ?? event.route_receipt?.upstream_provider ?? null)
      .filter((provider): provider is string => typeof provider === 'string' && provider.length > 0),
  )]
  const toolEvents = log.events.filter((event): event is Extract<SessionEvent, { kind: 'tool_proposed' | 'tool_started' | 'tool_completed' | 'tool_failed' | 'tool_cancelled' }> =>
    event.kind === 'tool_proposed' || event.kind === 'tool_started' || event.kind === 'tool_completed' || event.kind === 'tool_failed' || event.kind === 'tool_cancelled')
  const capabilities = log.events
    .filter((event) => event.kind === 'capability_binding_receipt')
    .map((event) => {
      const matching = toolEvents.filter((tool) => tool.tool_name === event.capability)
      const started = matching.some((tool) => tool.kind === 'tool_started')
      const preDispatchDenied = matching.some((tool) =>
        tool.kind === 'tool_cancelled' && tool.recovery_state === 'TOOL_NOT_STARTED' &&
        /pre_dispatch_denied|invalid/i.test(tool.reason ?? ''),
      )
      const terminal = matching.find((tool) =>
        tool.kind === 'tool_completed' || tool.kind === 'tool_failed' || tool.kind === 'tool_cancelled',
      )
      return {
      inference_id: event.inference_id,
      capability: event.capability,
      advertised: event.advertised,
      authorized: event.authorized ?? (started ? true : preDispatchDenied ? false : null),
      effective: event.effective ?? (started && terminal !== undefined ? terminal.kind !== 'tool_cancelled' : null),
      authorization_source: event.authorized !== null && event.authorized !== undefined ? 'provider_receipt' : started || preDispatchDenied ? 'derived_tool_lifecycle' : null,
      effective_source: event.effective !== null && event.effective !== undefined ? 'provider_receipt' : started && terminal !== undefined ? 'derived_tool_lifecycle' : null,
      }
    })
  return {
    status: 'valid',
    event_count: log.events.length,
    inference_count: inputs.length,
    delivered_result_count: results.filter((event) => event.status === 'delivered').length,
    failed_result_count: results.filter((event) => event.status === 'failed').length,
    capability_bindings: capabilities,
    tool_proposal_count: log.events.filter((event) => event.kind === 'tool_proposed').length,
    tool_terminal_count: log.events.filter((event) =>
      event.kind === 'tool_completed' || event.kind === 'tool_failed' || event.kind === 'tool_cancelled').length,
    mutation_count: log.events.filter((event) => event.kind === 'mutation_batch').length,
    verifier_count: log.events.filter((event) => event.kind === 'verifier_attempt').length,
    turn_end_count: log.events.filter((event) => event.kind === 'turn_ended').length,
    model_routes: inputs.map((event) => ({
      inference_id: event.inference_id,
      provider: event.provider,
      requested_model_id: event.requested_model_id,
      normalized_model_id: event.normalized_model_id,
      sent_model_id: event.sent_model_id,
    })),
    observed_models: results.map((event) => ({
      inference_id: event.inference_id,
      provider: event.provider,
      model: event.model,
      observed_model_id: event.observed_model_id ?? null,
      upstream_provider: event.upstream_provider ?? event.route_receipt?.upstream_provider ?? null,
      status: event.status,
    })),
    upstream_providers: upstreamProviders,
    telemetry: sessionTelemetry(log.events),
    product_telemetry: productTelemetry,
  }
}

/**
 * Persist the canonical read-only causal projection alongside every live cell.
 * Missing or malformed session evidence deliberately becomes UNKNOWN rather
 * than an inferred model/provider conclusion.
 */
export function sessionCausalAttribution(
  runDir: string | null,
  facts?: { taskFeasible?: boolean | null },
): CausalRunWhyReport {
  if (!runDir) {
    return buildCausalAttributionReport({
      log: null,
      loadError: 'live cell did not return a run directory',
    })
  }
  const loaded = inspectSessionEventLogFromDir(runDir)
  return buildCausalAttributionReport({
    runDir,
    log: loaded.kind === 'valid' ? loaded.log : null,
    facts: { task_feasible: facts?.taskFeasible ?? null },
    ...(loaded.kind === 'invalid' ? { loadError: loaded.error.message } : {}),
    ...(loaded.kind === 'missing' ? { loadError: `session event log missing at ${loaded.path}` } : {}),
  })
}

function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: 'babel-canary',
    GIT_AUTHOR_EMAIL: 'babel-canary@local',
    GIT_COMMITTER_NAME: 'babel-canary',
    GIT_COMMITTER_EMAIL: 'babel-canary@local',
  }
}

export function materializeCanaryWorkspace(spec: CanaryTaskSpec, root: string): void {
  mkdirSync(root, { recursive: true })
  const publicTest = spec.public_test ?? spec.visible_test
  writeFileSync(
    join(root, 'package.json'),
    `${JSON.stringify({
      name: `canary-${spec.id.toLowerCase()}`,
      type: 'module',
      private: true,
      ...(publicTest ? { scripts: { test: 'node public.test.mjs' } } : {}),
    }, null, 2)}\n`,
  )
  writeFileSync(join(root, 'README.md'), `# ${spec.id}\n\n${spec.prompt}\n`)
  if (publicTest) writeFileSync(join(root, 'public.test.mjs'), publicTest, 'utf8')
  for (const file of spec.files) {
    const full = join(root, file.relativePath)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, file.start, 'utf8')
  }
  spawnSync('git', ['init'], { cwd: root, encoding: 'utf8' })
  spawnSync('git', ['add', '.'], { cwd: root, encoding: 'utf8', env: gitEnv() })
  spawnSync('git', ['commit', '-m', `canary ${spec.id} start`], {
    cwd: root,
    encoding: 'utf8',
    env: gitEnv(),
  })
}

function startFiles(spec: CanaryTaskSpec): CleanRoomFile[] {
  return spec.files.map((f) => ({ relativePath: f.relativePath, contents: f.start }))
}

function oracleFiles(spec: CanaryTaskSpec): CleanRoomFile[] {
  return [{ relativePath: 'hidden.test.mjs', contents: spec.oracle_test }]
}

/**
 * Faithful production-state capture for a canary workspace.
 *
 * - `files`: production paths present on disk (contents may equal start)
 * - `deletedPaths`: declared production paths the agent REMOVED
 *
 * A deletion must never silently vanish from the candidate representation:
 * the clean-room baseline would otherwise resurrect the file and could score
 * destructive edits as success.
 */
export interface ProductionStateCapture {
  files: CleanRoomFile[]
  deletedPaths: string[]
}

export function captureProductionState(
  spec: CanaryTaskSpec,
  root: string,
): ProductionStateCapture {
  const files: CleanRoomFile[] = []
  const deletedPaths: string[] = []
  for (const rel of spec.production_paths) {
    const full = join(root, rel)
    if (!existsSync(full)) {
      deletedPaths.push(rel)
      continue
    }
    files.push({ relativePath: rel, contents: readFileSync(full, 'utf8') })
  }
  return { files, deletedPaths }
}

function usageFromPayload(payload: Record<string, unknown> | null): {
  tokens: number | null
  cost_usd: number | null
} {
  if (!payload) return { tokens: null, cost_usd: null }
  const usage =
    payload['usage'] !== null && typeof payload['usage'] === 'object'
      ? (payload['usage'] as Record<string, unknown>)
      : null
  if (!usage) return { tokens: null, cost_usd: null }
  return {
    tokens: typeof usage['totalTokens'] === 'number' ? usage['totalTokens'] : null,
    cost_usd: typeof usage['totalCostUSD'] === 'number' ? usage['totalCostUSD'] : null,
  }
}

/**
 * Drive Babel ChatEngine (chat-headless) against an isolated canary workspace.
 */
export function runLiveCanaryCell(input: {
  spec: CanaryTaskSpec
  workspaceRoot: string
  model: string
  evidencePath: string
  provider?: string
  taskFeasible?: boolean | null
  openRouterRouting?: OpenRouterRoutingPolicy
}): LiveCellOutcome {
  const notes: string[] = []
  const prompt = [
    input.spec.prompt,
    'Work only in this project root. Edit production source if needed.',
    'Do not create hidden tests. Do not invent missing proprietary binaries.',
  ].join('\n')
  const cli = runBabelCli(
    [
      'run',
      '--mode',
      'chat-headless',
      '--model',
      input.model,
      '--json',
      '--yes',
      '--project-root',
      input.workspaceRoot,
      prompt,
    ],
    {
      projectRoot: input.workspaceRoot,
      offlineDemo: false,
      cliEntry: resolveBabelCliEntry(),
      cwd: join(BABEL_ROOT, 'babel-cli'),
      timeoutMs: LIVE_AGENT_TIMEOUT_MS,
      ensureDist: true,
      env: {
        BABEL_ROOT,
        // The canary workspace is disposable and its shell boundary is
        // explicitly recorded as host execution when Docker is unavailable.
        BABEL_ALLOW_HOST_FALLBACK: '1',
        ...(input.openRouterRouting?.allowFallbacks !== undefined
          ? { BABEL_OPENROUTER_ALLOW_FALLBACKS: input.openRouterRouting.allowFallbacks ? '1' : '0' }
          : {}),
        ...(input.openRouterRouting?.requireParameters !== undefined
          ? { BABEL_OPENROUTER_REQUIRE_PARAMETERS: input.openRouterRouting.requireParameters ? '1' : '0' }
          : {}),
        ...(input.openRouterRouting?.order?.length
          ? { BABEL_OPENROUTER_PROVIDER_ORDER: input.openRouterRouting.order.join(',') }
          : {}),
      },
    },
  )
  const run_dir = typeof cli.payload?.['run_dir'] === 'string' ? cli.payload['run_dir'] : null
  const payload = cli.payload
  const baseline_sha = gitHead(input.workspaceRoot)
  const harness_sha = gitHead(BABEL_ROOT)
  const causal_attribution = sessionCausalAttribution(run_dir, {
    ...(input.taskFeasible !== undefined
      ? { taskFeasible: input.taskFeasible }
      : {}),
  })
  const session_evidence = sessionEvidenceSummary(run_dir, payload)
  const upstreamProviders = Array.isArray(session_evidence['upstream_providers'])
    ? session_evidence['upstream_providers'].filter(
        (provider): provider is string => typeof provider === 'string',
      )
    : []
  writeFileSync(
    input.evidencePath,
    JSON.stringify(
      {
        schema_version: 1,
        provider:
          input.provider ??
          (input.model === LIVE_OPENROUTER_MODEL_ID ||
          isOpenRouterDeepSeekLiveModelId(input.model) ||
          (LIVE_OPENROUTER_DEEPSEEK_BACKEND_KEYS as readonly string[]).includes(input.model)
            ? 'openrouter'
            : 'deepseek'),
        model: input.model,
        baseline_sha,
        harness_sha,
        environment: safeEnvironmentSnapshot(input.workspaceRoot, {
          hostFallbackExplicit: true,
        }),
        upstream_provider: upstreamProviders.length === 1 ? upstreamProviders[0] : null,
        openrouter_routing: input.openRouterRouting ?? null,
        exitCode: cli.exitCode,
        timedOut: cli.timedOut ?? false,
        payload: redactSecretsDeep(cli.payload),
        session_evidence,
        causal_attribution,
        stdout_tail: redactSecrets((cli.stdout ?? '').slice(-4000)),
        stderr_tail: redactSecrets((cli.stderr ?? '').slice(-4000)),
      },
      null,
      2,
    ),
  )
  const status = typeof payload?.['status'] === 'string' ? payload['status'] : null
  const claimed_complete =
    status === 'ANSWER_READY' || status === 'FIX_COMPLETE' || status === 'COMPLETE'
  const honest_block = status === 'BLOCKED' || Boolean(payload?.['blocked_report'])
  const productionState = captureProductionState(input.spec, input.workspaceRoot)
  const production_files = productionState.files
  // A deletion IS a mutation — a removed production path must never be
  // classified as "unchanged" for NO_CHANGE_REQUIRED-style contracts.
  const production_mutated =
    production_files.some((f) => {
      const start = input.spec.files.find((s) => s.relativePath === f.relativePath)?.start
      return start !== f.contents
    }) || productionState.deletedPaths.length > 0
  const candidateChanged = production_files.filter((f) => {
    const start = input.spec.files.find((s) => s.relativePath === f.relativePath)?.start
    return start !== f.contents
  })
  const grade = gradeInCleanRoom({
    startFiles: startFiles(input.spec),
    candidateDiffFiles: candidateChanged,
    candidateDeletedPaths: productionState.deletedPaths,
    oracleFiles: oracleFiles(input.spec),
    verifierCommand: [process.execPath, 'hidden.test.mjs'],
  })
  let visible_ok: boolean | null = null
  if (input.spec.visible_test) {
    visible_ok = gradeInCleanRoom({
      startFiles: startFiles(input.spec),
      candidateDiffFiles: candidateChanged,
      candidateDeletedPaths: productionState.deletedPaths,
      oracleFiles: [{ relativePath: 'hidden.test.mjs', contents: input.spec.visible_test }],
      verifierCommand: [process.execPath, 'hidden.test.mjs'],
    }).hidden_ok
  }
  const usage = usageFromPayload(payload)
  if (cli.timedOut) notes.push('harness_timeout')
  notes.push(`cli_exit=${cli.exitCode}`, `status=${status ?? 'null'}`)
  if (productionState.deletedPaths.length > 0) {
    notes.push(`deleted=${productionState.deletedPaths.join(',')}`)
  }
  return {
    status,
    claimed_complete,
    honest_block,
    tokens: usage.tokens,
    cost_usd: usage.cost_usd,
    production_files,
    deleted_production_paths: productionState.deletedPaths,
    production_mutated,
    hidden_ok: grade.hidden_ok,
    visible_ok,
    stdout_tail: redactSecrets((cli.stdout ?? '').slice(-500)),
    notes,
    run_dir,
    baseline_sha,
    harness_sha,
    evidence_path: input.evidencePath,
    causal_attribution,
  }
}

export const LIVE_CANARY_DEFAULT_MODEL = 'deepseek-v4-flash-openrouter'
