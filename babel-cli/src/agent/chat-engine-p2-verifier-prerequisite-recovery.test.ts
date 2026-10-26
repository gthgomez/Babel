/**
 * P2 — required verifier with unchanged isolation prerequisite (production transport).
 *
 * Faithful **negative** real-runner regression only (`safe_repo`, no custom runtime overrides).
 * Only `globalThis.fetch` is mocked (bottom transport).
 *
 * Reported route (non-secret): backend key `opencode-go/deepseek-v4.1-flash`, provider
 * `opencode-go`, model `deepseek-v4.1-flash`, endpoint `https://opencode.ai/zen/go/v1/chat/completions`.
 *
 * Regression layers (unchanged files — not re-proven here):
 * - `s07OrdinaryLoop.test.ts` — ordinary repair / verification loop (fail→repair→pass).
 * - `verifierReceiptLoop.test.ts` — dev_local write + required verifier under its fixture env.
 * - `chatCapabilityRecovery.integration.test.ts` — dispatcher, probe reservation, continueTask / rearm.
 * - `capabilityRecoveryScope.test.ts` — scope owner + revision keys.
 * - `prerequisiteDenialFacts.test.ts` — predicate / lifecycle unit witnesses.
 *
 * Quarantined full-loop WIP (incl. rejected `BABEL_CHAT_MAX_COST=unlimited`): see
 * `_quarantine/p2-full-loop-wip-20261025.ts`. Production hook plan:
 * `_quarantine/P2-PRODUCTION-FILE-FUNCTION-PROPOSAL.md`.
 *
 * dev_local OpenCode Go budget-before-transport is a separate fixture question; not a guard bypass.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { ChatEngine, type ChatEvent } from './chatEngine.js'
import type { TerminalOutcome } from '../schemas/agentContracts.js'
import { refreshDryRunState } from '../localTools.js'
import { resolveChatModelPolicy } from './chatModelPolicy.js'
import {
  OPENCODE_GO_BASE_URL,
  OPENCODE_GO_MODELS,
} from '../runners/openCodeGoApi.js'
import {
  bindIsolationPrerequisiteScope,
  isolationPrerequisiteRevisionKey,
} from './capabilityRecoveryScope.js'
import { evaluateExecuteCompletionHonesty } from './completionGatePolicy.js'
import { prepareKernelVerifierInput } from './chatEngineVerifierAdapter.js'
import { DIFF_CRITIC_SYSTEM_PROMPT, parseDiffCriticVerdict } from './diffCritic.js'
import type { ProgressController } from './progressController.js'

const SUBMISSION_START_HARNESS_FEEDBACK = 'Verification evidence at submission start:'
const SYNTHETIC_OPENCODE_GO_API_KEY = 'synthetic-in-memory-opencode-go-test-credential-p2'
const DIFF_CRITIC_SYSTEM_MARKER = 'reject-biased code-review critic'
const ISOLATION_DENIED_BROKER_MARKER = '[CAPABILITY_DENIED:isolation_unavailable]'

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..')
const ROUTE_BACKEND_KEY = 'opencode-go/deepseek-v4.1-flash'
const ROUTE_MODEL_ID = 'deepseek-v4.1-flash'
const MAIN_LOOP_URL = `${OPENCODE_GO_BASE_URL}/chat/completions`
const REQUIRED_VERIFIER_CMD = 'npm test'
const NPM_TEST_SHELL = 'npm test'

/** Narrow synthetic autonomy lease (chatCapabilityRecovery.integration.test.ts pattern). */
const SYNTHETIC_LEASE = JSON.stringify({
  version: 2,
  leaseId: 'synthetic-fixture-lease-p2',
  scope: { repository: 'gthgomez/Babel', remote: 'origin', worktree: 'current' },
  allowedCapabilities: [
    'inspect_repository',
    'search_repository',
    'run_local_command',
    'run_tests',
    'run_build',
    'run_lint',
    'run_typecheck',
    'edit_task_files',
    'create_task_branch',
  ],
  branchPrefixes: ['feat/', 'fix/', 'test/'],
  constraints: {
    protectedBranches: ['main'],
    forcePush: false,
    remoteRefDelete: false,
    releasePublish: false,
    productionDeploy: false,
    repositoryAdmin: false,
    secretsAccess: false,
    billing: false,
    destructiveDb: false,
    scopeExpansion: false,
  },
  budgets: { ciProductRepairRounds: 3, ciTransientReruns: 1, prRecreateRounds: 1, parallelAgents: 8 },
  gates: [
    'merge',
    'pr_mark_ready',
    'release',
    'production_deploy',
    'repo_admin',
    'security_policy_change',
    'credential_access',
    'destructive_data_delete',
    'shared_history_rewrite',
    'force_push',
    'scope_expansion',
    'run_arbitrary_code',
  ],
  forbidden: ['expose_credentials'],
})

const MANAGED_ENV = [
  'BABEL_EXECUTION_PROFILE',
  'BABEL_ALLOW_HOST_FALLBACK',
  'BABEL_DOCKER_DISABLE',
  'BABEL_BENCHMARK_DOCKER_IMAGE',
  'BABEL_BENCHMARK_MODE',
  'BABEL_BENCHMARK_AUTO_APPROVE',
  'BABEL_AUTONOMY_LEASE',
  'BABEL_DRY_RUN',
  'BABEL_DRY_RUN_SOURCE',
  'BABEL_RUNS_DIR',
  'BABEL_OPENCODE_GO_HELPER',
  'BABEL_OPENCODE_GO_API_KEY',
  'BABEL_OFFLINE',
  'BABEL_CHAT_MAX_COST',
] as const

const originalFetch = globalThis.fetch

test.afterEach(() => {
  globalThis.fetch = originalFetch
})

function git(projectRoot: string, args: string[]): void {
  const result = spawnSync('git', args, {
    cwd: projectRoot,
    encoding: 'utf-8',
    windowsHide: true,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: join(projectRoot, 'no-global-gitconfig'),
    },
  })
  assert.equal(result.status, 0, result.stderr?.toString() ?? 'git failed')
}

function seedRepository(projectRoot: string): void {
  mkdirSync(join(projectRoot, 'src'), { recursive: true })
  writeFileSync(join(projectRoot, 'src', 'task.ts'), 'export const answer = 0;\n', 'utf8')
  git(projectRoot, ['init', '-q', '--initial-branch=main'])
  git(projectRoot, ['config', 'user.email', 'fixture@example.invalid'])
  git(projectRoot, ['config', 'user.name', 'Fixture'])
  git(projectRoot, ['add', 'src/task.ts'])
  git(projectRoot, ['commit', '-qm', 'P2 prerequisite fixture'])
  const testBody = [
    "import { readFileSync } from 'node:fs';",
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "test('task answer must be 42', () => {",
    "  const src = readFileSync('src/task.ts', 'utf8');",
    "  const match = /answer\\s*=\\s*(\\d+)/.exec(src);",
    "  assert.ok(match);",
    "  assert.equal(Number(match[1]), 42);",
    "});",
    '',
  ].join('\n')
  writeFileSync(
    join(projectRoot, 'package.json'),
    JSON.stringify({ private: true, scripts: { test: 'node --test fixture.test.mjs' } }),
    'utf8',
  )
  writeFileSync(join(projectRoot, 'fixture.test.mjs'), testBody, 'utf8')
  git(projectRoot, ['add', 'package.json', 'fixture.test.mjs'])
  git(projectRoot, ['commit', '-qm', 'add required verifier script'])
}

function applySyntheticGoApiKey(): void {
  delete process.env['BABEL_OPENCODE_GO_HELPER']
  process.env['BABEL_OPENCODE_GO_API_KEY'] = SYNTHETIC_OPENCODE_GO_API_KEY
}

function applySafeRepoIsolation(runsRoot: string): void {
  for (const key of MANAGED_ENV) delete process.env[key]
  process.env['BABEL_EXECUTION_PROFILE'] = 'safe_repo'
  process.env['BABEL_ALLOW_HOST_FALLBACK'] = '0'
  process.env['BABEL_DOCKER_DISABLE'] = 'false'
  delete process.env['BABEL_BENCHMARK_DOCKER_IMAGE']
  process.env['BABEL_DRY_RUN'] = '0'
  process.env['BABEL_DRY_RUN_SOURCE'] = 'session'
  process.env['BABEL_AUTONOMY_LEASE'] = SYNTHETIC_LEASE
  process.env['BABEL_RUNS_DIR'] = runsRoot
  applySyntheticGoApiKey()
  refreshDryRunState()
}

function restoreEnv(prior: Record<string, string | undefined>): void {
  for (const key of MANAGED_ENV) {
    if (prior[key] === undefined) delete process.env[key]
    else process.env[key] = prior[key]
  }
  refreshDryRunState()
}

function assertProductionRoute(): void {
  assert.ok((OPENCODE_GO_MODELS as readonly string[]).includes(ROUTE_MODEL_ID))
  const { policy } = resolveChatModelPolicy({ model: ROUTE_BACKEND_KEY, babelRoot: REPO_ROOT })
  assert.equal(policy.provider, 'opencode-go')
  assert.equal(policy.providerModelId, ROUTE_MODEL_ID)
  assert.equal(policy.resolvedBackendKey, ROUTE_BACKEND_KEY)
}

interface ToolCallSpec {
  id: string
  name: string
  args: Record<string, unknown>
}

type MainTurnSpec =
  | { kind: 'tools'; toolCalls: ToolCallSpec[] }
  | { kind: 'text'; text: string }

/** SSE tool-call stream (chatEngineJ08PreservedUnverified.test.ts shape). */
function makeToolCallSse(name: string, args: Record<string, unknown>, callId: string): Response {
  const argsJson = JSON.stringify(args)
  const lines = [
    `data: ${JSON.stringify({
      model: ROUTE_MODEL_ID,
      choices: [{
        delta: {
          role: 'assistant',
          tool_calls: [{ index: 0, id: callId, type: 'function', function: { name, arguments: '' } }],
        },
        finish_reason: null,
      }],
    })}`,
    `data: ${JSON.stringify({
      model: ROUTE_MODEL_ID,
      choices: [{
        delta: { tool_calls: [{ index: 0, function: { arguments: argsJson } }] },
        finish_reason: null,
      }],
    })}`,
    `data: ${JSON.stringify({
      model: ROUTE_MODEL_ID,
      choices: [{ delta: {}, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
    })}`,
    'data: [DONE]',
  ]
  return new Response(`${lines.join('\n\n')}\n\n`, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

function makeMultiToolSse(toolCalls: ToolCallSpec[]): Response {
  const lines: string[] = []
  for (let index = 0; index < toolCalls.length; index += 1) {
    const tc = toolCalls[index]!
    const argsJson = JSON.stringify(tc.args)
    lines.push(
      `data: ${JSON.stringify({
        model: ROUTE_MODEL_ID,
        choices: [{
          delta: {
            role: 'assistant',
            tool_calls: [{
              index,
              id: tc.id,
              type: 'function',
              function: { name: tc.name, arguments: '' },
            }],
          },
          finish_reason: null,
        }],
      })}`,
      `data: ${JSON.stringify({
        model: ROUTE_MODEL_ID,
        choices: [{
          delta: { tool_calls: [{ index, function: { arguments: argsJson } }] },
          finish_reason: null,
        }],
      })}`,
    )
  }
  lines.push(
    `data: ${JSON.stringify({
      model: ROUTE_MODEL_ID,
      choices: [{ delta: {}, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
    })}`,
    'data: [DONE]',
  )
  return new Response(`${lines.join('\n\n')}\n\n`, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

function makeTextCompletionSse(text: string): Response {
  const lines = [
    `data: ${JSON.stringify({
      model: ROUTE_MODEL_ID,
      choices: [{ delta: { content: text }, finish_reason: null }],
    })}`,
    `data: ${JSON.stringify({
      model: ROUTE_MODEL_ID,
      choices: [{ delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 12, completion_tokens: 16, total_tokens: 28 },
    })}`,
    'data: [DONE]',
  ]
  return new Response(`${lines.join('\n\n')}\n\n`, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

function makeCriticPassResponse(): Response {
  const content = JSON.stringify({
    verdict: 'pass',
    confidence: 0.95,
    reasons: ['fixture structural review'],
  })
  const parsed = parseDiffCriticVerdict(content, { model: ROUTE_MODEL_ID })
  assert.equal(parsed.verdict, 'pass', 'critic fixture must match schema pass verdict')
  assert.equal(DIFF_CRITIC_SYSTEM_PROMPT.includes(DIFF_CRITIC_SYSTEM_MARKER), true)
  return Response.json({
    model: ROUTE_MODEL_ID,
    choices: [{
      message: { content },
      finish_reason: 'stop',
    }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  })
}

type OpenCodeGoWireBody = {
  stream?: boolean
  tools?: unknown[]
  messages?: Array<{ role?: string; content?: string }>
}

function requestWireBlob(body: OpenCodeGoWireBody): string {
  return JSON.stringify(body.messages ?? [])
}

function isMainLoopToolsRequest(body: OpenCodeGoWireBody): boolean {
  return Array.isArray(body.tools) && body.tools.length > 0
}

function isDiffCriticRequest(body: OpenCodeGoWireBody): boolean {
  if (Array.isArray(body.tools) && body.tools.length > 0) return false
  const blob = requestWireBlob(body)
  if (blob.includes(DIFF_CRITIC_SYSTEM_MARKER)) return true
  return body.messages?.some(
    message =>
      message.role === 'system' &&
      typeof message.content === 'string' &&
      message.content.includes(DIFF_CRITIC_SYSTEM_MARKER),
  ) ?? false
}

const DEFAULT_LATE_STREAMING_COMPLETION =
  'Acknowledged. I will not claim verification without required authoritative shell evidence.'

function installFetchHarness(
  mainScript: MainTurnSpec[],
  opts?: { lateStreamingCompletion?: string },
): {
  counts: { mainLoopTools: number; diffCritic: number }
  signals: { receivedVerifiedCompleteProse: boolean }
  restore: () => void
} {
  let mainIdx = 0
  const lateText = opts?.lateStreamingCompletion ?? DEFAULT_LATE_STREAMING_COMPLETION
  const counts = { mainLoopTools: 0, diffCritic: 0 }
  const signals = { receivedVerifiedCompleteProse: false }
  globalThis.fetch = (async (input, init) => {
    const url = String(input)
    if (url !== MAIN_LOOP_URL) {
      throw new Error(`unexpected network fetch url=${url}`)
    }
    const body = JSON.parse(String(init?.body ?? '{}')) as OpenCodeGoWireBody
    if (isMainLoopToolsRequest(body)) {
      counts.mainLoopTools += 1
    } else if (isDiffCriticRequest(body)) {
      counts.diffCritic += 1
      return makeCriticPassResponse()
    } else {
      throw new Error(
        `unexpected OpenCode Go wire shape (stream=${String(body.stream)} tools=${Array.isArray(body.tools) ? body.tools.length : 'none'})`,
      )
    }
    const turn =
      mainIdx < mainScript.length
        ? mainScript[mainIdx]
        : { kind: 'text' as const, text: lateText }
    mainIdx += 1
    if (turn.kind === 'text') {
      if (/VERIFIED_COMPLETE/i.test(turn.text)) signals.receivedVerifiedCompleteProse = true
      return makeTextCompletionSse(turn.text)
    }
    if (turn.toolCalls.length === 1) {
      const only = turn.toolCalls[0]!
      return makeToolCallSse(only.name, only.args, only.id)
    }
    return makeMultiToolSse(turn.toolCalls)
  }) as typeof fetch
  return {
    counts,
    signals,
    restore: () => {
      globalThis.fetch = originalFetch
    },
  }
}

function assertNoFixtureProviderFailure(events: ChatEvent[]): void {
  const terminal = events.find(event => event.type === 'done' || event.type === 'failed')
  assert.ok(terminal, 'expected terminal event')
  if (terminal.type === 'failed') {
    assert.notEqual(terminal.reason_code, 'provider_failure', terminal.error)
    assert.notEqual(terminal.outcome, 'INFRA_FAILURE', terminal.error)
  }
  if (terminal.type === 'done') {
    assert.notEqual(terminal.outcome, 'INFRA_FAILURE')
    assert.notEqual(terminal.reason_code, 'provider_failure')
  }
}

function assertDiffCriticReceiptWhenInvoked(
  engine: ChatEngine,
  diffCriticFetchCount: number,
): void {
  if (diffCriticFetchCount === 0) return
  const receipt = (engine as unknown as { lastCriticReceipt: { verdict: string } | null }).lastCriticReceipt
  assert.ok(receipt, 'diff critic auxiliary fetch must produce a critic receipt on the engine')
  assert.equal(
    receipt.verdict,
    'pass',
    `diff critic auxiliary fetch must produce schema-correct pass receipt (got ${receipt.verdict})`,
  )
}

async function collectStream(stream: AsyncGenerator<ChatEvent, unknown, undefined>): Promise<ChatEvent[]> {
  const events: ChatEvent[] = []
  for await (const event of stream) events.push(event)
  return events
}

type PrerequisiteScopeSnapshot = ReturnType<typeof bindIsolationPrerequisiteScope>

type PrerequisitePhaseSnapshots = Partial<
  Record<'beforeDenial' | 'atDenial' | 'atSuppression' | 'beforeCompletion', PrerequisiteScopeSnapshot>
>

async function collectStreamWithPrerequisitePhases(
  engine: ChatEngine,
  stream: AsyncGenerator<ChatEvent, unknown, undefined>,
  shellTarget: string,
): Promise<{ events: ChatEvent[]; phases: PrerequisitePhaseSnapshots }> {
  const events: ChatEvent[] = []
  const phases: PrerequisitePhaseSnapshots = {}
  for await (const event of stream) {
    events.push(event)
    const host = engineHost(engine)
    if (
      !phases.beforeDenial &&
      event.type === 'tool_start' &&
      (event.tool === 'run_command' || event.tool === 'test_run') &&
      event.target === shellTarget
    ) {
      phases.beforeDenial = bindIsolationPrerequisiteScope(host)
    }
    const shells = shellLog(engine)
    const evaluated = shells.filter(
      entry => entry.target === shellTarget && entry.detail !== 'prerequisite_suppressed',
    )
    if (!phases.atDenial && evaluated.length >= 1) {
      phases.atDenial = bindIsolationPrerequisiteScope(host)
    }
    if (
      !phases.atSuppression &&
      shells.some(entry => entry.target === shellTarget && entry.detail === 'prerequisite_suppressed')
    ) {
      phases.atSuppression = bindIsolationPrerequisiteScope(host)
    }
    if (!phases.beforeCompletion) {
      const completionTransport = event.type === 'answer_chunk'
      const completionController = controllerGateFeedback(host).length >= 1
      if (completionTransport || completionController) {
        phases.beforeCompletion = bindIsolationPrerequisiteScope(host)
      }
    }
  }
  return { events, phases }
}

function assertStablePrerequisiteScope(phases: PrerequisitePhaseSnapshots): PrerequisiteScopeSnapshot {
  const keys = ['beforeDenial', 'atDenial', 'atSuppression', 'beforeCompletion'] as const
  for (const key of keys) {
    assert.ok(phases[key], `missing prerequisite scope snapshot at phase ${key}`)
  }
  const baseline = phases.atDenial!
  for (const key of ['atSuppression', 'beforeCompletion'] as const) {
    const snap = phases[key]!
    assert.equal(snap.prerequisiteKey, baseline.prerequisiteKey)
    assert.equal(snap.environmentIdentity, baseline.environmentIdentity)
    assert.equal(snap.revisionKey, baseline.revisionKey)
    assert.equal(snap.taskId, baseline.taskId, `taskId must stay stable through ${key}`)
  }
  assert.equal(phases.beforeDenial!.revisionKey, baseline.revisionKey)
  assert.equal(phases.beforeDenial!.environmentIdentity, baseline.environmentIdentity)
  assert.equal(phases.beforeDenial!.taskId, baseline.taskId, 'taskId at first shell dispatch must match denial phase')
  return baseline
}

function canonicalVerifierInput(engine: ChatEngine) {
  const host = engine as unknown as {
    lastVerifierReceipt: ReturnType<typeof prepareKernelVerifierInput>['lastVerifierReceipt']
    executedVerifierLedger: ReturnType<typeof prepareKernelVerifierInput>['executedVerifierLedger']
    getResolvedRequiredVerifiers: () => string[]
  }
  return {
    ...prepareKernelVerifierInput(host.lastVerifierReceipt, host.executedVerifierLedger ?? []),
    requiredVerifierCommands: host.getResolvedRequiredVerifiers(),
  }
}

function assertRequiredVerifierMissingViaCanonicalGuard(
  engine: ChatEngine,
  expectedRequired: readonly string[] = [REQUIRED_VERIFIER_CMD],
): void {
  const input = canonicalVerifierInput(engine)
  assert.deepEqual(
    input.requiredVerifierCommands,
    expectedRequired,
    'canonical guard must evaluate the exact required verifier list',
  )
  assert.equal(
    input.verifierEvidenceErrors?.length ?? 0,
    0,
    `canonical guard must not see evidence-adaptation errors (${JSON.stringify(input.verifierEvidenceErrors)})`,
  )
  const honesty = evaluateExecuteCompletionHonesty({
    hasWrite: true,
    policy: 'strict',
    lastVerifierReceipt: input.lastVerifierReceipt,
    executedVerifierLedger: input.executedVerifierLedger,
    verifierEvidenceErrors: input.verifierEvidenceErrors,
    requiredVerifierCommands: input.requiredVerifierCommands,
    toolCallLog: [],
  })
  assert.equal(honesty.allow, false, 'required verifier obligation must remain unsatisfied')
  assert.equal(honesty.reason, 'verifier_missing', `canonical guard reason must be verifier_missing (got ${honesty.reason})`)
}

function assertAuthoritativeVerifierGateRejection(
  host: ReturnType<typeof engineHost>,
  terminal: ReturnType<typeof terminalAuthority>,
): void {
  const controllerFeedback = controllerGateFeedback(host)
  const conversationBlob = host.conversation.map(message => message.content).join('\n')
  const fromController =
    controllerFeedback.length >= 1 &&
    /verif|authoritative test|before completing|gate|completion|COMPLETION_GATE_REJECTED/i.test(
      controllerFeedback.map(message => message.content).join('\n'),
    )
  const fromCanonicalTerminal =
    terminal.outcome === 'BLOCKED_POLICY' ||
    terminal.reason_code === 'recovery_exhausted' ||
    terminal.cause_class === 'harness' ||
    terminal.status === 'blocked'
  const fromConversation = /COMPLETION_GATE_REJECTED:\s*verifier_missing/i.test(conversationBlob)
  assert.ok(
    fromController || fromCanonicalTerminal || fromConversation,
    'authoritative verifier gate rejection must surface via controller feedback or canonical blocked terminal/gate reason (early block may omit reject_continue side effects)',
  )
}

function controllerGateFeedback(
  host: ReturnType<typeof engineHost>,
): Array<{ role: string; content: string; name?: string; provenance?: string }> {
  return host.conversation.filter(
    message =>
      message.name === 'harness_feedback' &&
      message.provenance === 'controller' &&
      !message.content.startsWith(SUBMISSION_START_HARNESS_FEEDBACK),
  )
}

type ShellLogEntry = {
  tool: string
  target?: string
  detail?: string
  error?: string
  exit_code?: number
  stdout?: string
  stderr?: string
}

function shellLog(engine: ChatEngine): ShellLogEntry[] {
  const log = (engine as unknown as { toolCallLog: ShellLogEntry[] }).toolCallLog
  return log.filter(entry => entry.tool === 'run_command' || entry.tool === 'test_run')
}

function engineHost(engine: ChatEngine) {
  return engine as unknown as {
    progressController: ProgressController
    engineRunId: string
    executionProfile: string
    taskAllowance: { taskOwnerId: string } | null
    options: { projectRoot?: string; model?: string }
    isolationBrokerFlags: () => {
      isolationRequired: boolean
      isolationAvailable: boolean
      hostFallbackAllowed: boolean
      dirtyTree: boolean
    }
    lastVerifierReceipt: { exit_code?: number; stale?: boolean } | null
    gateStrikes: number
    conversation: Array<{ role: string; content: string; name?: string; provenance?: string }>
    getResolvedRequiredVerifiers: () => string[]
  }
}

function terminalAuthority(events: ChatEvent[]): {
  type: 'done' | 'failed'
  outcome: TerminalOutcome | undefined
  reason_code: string | undefined
  cause_class: string | null | undefined
  status: string | undefined
  error: string | undefined
} {
  const terminals = events.filter(event => event.type === 'done' || event.type === 'failed')
  assert.equal(terminals.length, 1, `expected one terminal, saw ${terminals.map(e => e.type).join(',')}`)
  const terminal = terminals[0]!
  assert.ok(terminal.type === 'done' || terminal.type === 'failed')
  const outcome = terminal.outcome
  return {
    type: terminal.type,
    outcome,
    reason_code: terminal.reason_code,
    cause_class: terminal.cause_class,
    status: terminal.status,
    error: terminal.type === 'failed' ? terminal.error : undefined,
  }
}

function createProductionEngine(input: {
  projectRoot: string
  runId: string
  task: string
  requiredVerifierCommands?: readonly string[]
}): ChatEngine {
  assertProductionRoute()
  return new ChatEngine({
    task: input.task,
    projectRoot: input.projectRoot,
    runId: input.runId,
    operation: 'CHANGE',
    model: ROUTE_BACKEND_KEY,
    requiredVerifierCommands: input.requiredVerifierCommands,
  })
}

test('P2 RED: unchanged prerequisite must not schedule extra main-loop fetch after gate reject', async t => {
  const prior = Object.fromEntries(MANAGED_ENV.map(key => [key, process.env[key]]))
  const runsRoot = mkdtempSync(join(tmpdir(), 'babel-p2-runs-'))
  const projectRoot = mkdtempSync(join(tmpdir(), 'babel-p2-repo-'))
  t.after(() => {
    restoreEnv(prior)
    rmSync(runsRoot, { recursive: true, force: true })
    rmSync(projectRoot, { recursive: true, force: true })
  })

  applySafeRepoIsolation(runsRoot)
  seedRepository(projectRoot)

  const fetchHarness = installFetchHarness([
    { kind: 'tools', toolCalls: [{ id: 'ver-1', name: 'run_command', args: { command: NPM_TEST_SHELL } }] },
    {
      kind: 'tools',
      toolCalls: [
        { id: 'ver-2', name: 'run_command', args: { command: NPM_TEST_SHELL } },
        {
          id: 'edit-task',
          name: 'str_replace',
          args: {
            file_path: 'src/task.ts',
            old_str: 'export const answer = 0;',
            new_str: 'export const answer = 42;',
          },
        },
      ],
    },
    {
      kind: 'text',
      text: 'VERIFIED_COMPLETE: npm test passed and the required verifier succeeded.',
    },
  ], {
    lateStreamingCompletion:
      'Understood. I cannot claim completion without the required npm test verifier.',
  })
  t.after(() => fetchHarness.restore())

  const engine = createProductionEngine({
    projectRoot,
    runId: `p2-red-${randomUUID()}`,
    task: 'Fix src/task.ts and run the required npm test verifier. No alternate verifier exists.',
    requiredVerifierCommands: [REQUIRED_VERIFIER_CMD],
  })

  const { events, phases } = await collectStreamWithPrerequisitePhases(
    engine,
    engine.submitMessageStream(
      'Fix src/task.ts and run the required npm test verifier. No alternate verifier exists.',
    ),
    NPM_TEST_SHELL,
  )
  const scope = assertStablePrerequisiteScope(phases)
  const host = engineHost(engine)
  assert.equal(scope.taskId, host.taskAllowance?.taskOwnerId, 'prerequisite scope taskId must match durable task owner')

  const shells = shellLog(engine)
  const evaluated = shells.filter(entry => entry.detail !== 'prerequisite_suppressed')
  const suppressed = shells.filter(entry => entry.detail === 'prerequisite_suppressed')

  assert.equal(evaluated.length, 1)
  assert.equal(suppressed.length, 1)
  assert.equal(evaluated[0]?.target, NPM_TEST_SHELL)
  assert.equal(suppressed[0]?.target, NPM_TEST_SHELL)
  assert.equal(evaluated[0]?.error, 'blocked', 'first governed denial must be broker-blocked')
  const denialMarker = `${evaluated[0]?.stderr ?? ''} ${evaluated[0]?.detail ?? ''}`
  assert.ok(denialMarker.includes(ISOLATION_DENIED_BROKER_MARKER), 'first denial must carry exact broker marker')

  const revisionAtEnd = isolationPrerequisiteRevisionKey(host.isolationBrokerFlags())
  assert.equal(scope.revisionKey, revisionAtEnd)
  assert.equal(scope.prerequisiteKey, 'isolation_unavailable:shell')
  assert.equal(host.progressController.hasConsumedPrerequisiteDenialProbe(scope), true)

  const edit = (engine as unknown as { toolCallLog: ShellLogEntry[] }).toolCallLog
    .filter(entry => entry.tool === 'str_replace')
  assert.ok(edit.length >= 1)
  assert.equal(edit.every(entry => entry.exit_code === 0), true)
  assert.match(readFileSync(join(projectRoot, 'src', 'task.ts'), 'utf8'), /answer = 42/)

  assertRequiredVerifierMissingViaCanonicalGuard(engine)

  assert.equal(
    fetchHarness.signals.receivedVerifiedCompleteProse,
    true,
    'provider must deliver the dishonest completion attempt before gate rejection',
  )
  assertNoFixtureProviderFailure(events)
  assertDiffCriticReceiptWhenInvoked(engine, fetchHarness.counts.diffCritic)

  const terminal = terminalAuthority(events)
  assertAuthoritativeVerifierGateRejection(host, terminal)
  assert.notEqual(terminal.outcome, 'VERIFIED_COMPLETE')
  const naturalOutcomes: TerminalOutcome[] = [
    'UNVERIFIED_PATCH',
    'NEEDS_HUMAN_DECISION',
    'BLOCKED_POLICY',
    'AGENT_FAILURE',
    'BUDGET_EXHAUSTED',
    'BLOCKED_EXTERNAL',
  ]
  assert.ok(
    terminal.outcome && naturalOutcomes.includes(terminal.outcome),
    `natural production terminal (got outcome=${terminal.outcome} reason=${terminal.reason_code} cause=${terminal.cause_class})`,
  )
  assert.notEqual(terminal.outcome, 'INFRA_FAILURE', 'must not terminate via transport script exhaustion')
  assert.notEqual(terminal.reason_code, 'provider_failure', 'must not classify mock exhaustion as provider_failure')

  const redBundle = {
    mainLoopToolsFetchCount: fetchHarness.counts.mainLoopTools,
    diffCriticFetchCount: fetchHarness.counts.diffCritic,
    receivedVerifiedCompleteProse: fetchHarness.signals.receivedVerifiedCompleteProse,
    terminalType: terminal.type,
    terminalOutcome: terminal.outcome,
    terminalReasonCode: terminal.reason_code,
    terminalCauseClass: terminal.cause_class,
    terminalStatus: terminal.status,
    prerequisiteRevisionKey: scope.revisionKey,
    prerequisiteScopePhases: {
      beforeDenial: phases.beforeDenial,
      atDenial: phases.atDenial,
      atSuppression: phases.atSuppression,
      beforeCompletion: phases.beforeCompletion,
    },
    taskOwnerId: host.taskAllowance?.taskOwnerId,
    routeBackendKey: ROUTE_BACKEND_KEY,
    routeModelId: ROUTE_MODEL_ID,
    endpoint: MAIN_LOOP_URL,
  }

  assert.equal(
    redBundle.mainLoopToolsFetchCount,
    3,
    `unnecessary main-loop provider recovery fetch (bundle=${JSON.stringify(redBundle)})`,
  )
})


test('P2 conservative fallback: no explicit required verifier (not same-obligation native-alternative proof)', async t => {
  const prior = Object.fromEntries(MANAGED_ENV.map(key => [key, process.env[key]]))
  const runsRoot = mkdtempSync(join(tmpdir(), 'babel-p2-runs-'))
  const projectRoot = mkdtempSync(join(tmpdir(), 'babel-p2-repo-'))
  t.after(() => {
    restoreEnv(prior)
    rmSync(runsRoot, { recursive: true, force: true })
    rmSync(projectRoot, { recursive: true, force: true })
  })

  applySafeRepoIsolation(runsRoot)
  seedRepository(projectRoot)

  const fetchHarness = installFetchHarness([
    {
      kind: 'tools',
      toolCalls: [{
        id: 'edit-task',
        name: 'str_replace',
        args: {
          file_path: 'src/task.ts',
          old_str: 'export const answer = 0;',
          new_str: 'export const answer = 42;',
        },
      }],
    },
    { kind: 'text', text: 'File updated without shell verifier.' },
  ], { lateStreamingCompletion: 'File updated without shell verifier.' })
  t.after(() => fetchHarness.restore())

  const engine = createProductionEngine({
    projectRoot,
    runId: `p2-native-fallback-${randomUUID()}`,
    task: 'File edit only; shell verifier not required.',
  })

  const events = await collectStream(engine.submitMessageStream('Set answer to 42 without running tests.'))
  const terminal = terminalAuthority(events)
  assert.notEqual(terminal.outcome, 'VERIFIED_COMPLETE')
  assert.notEqual(terminal.outcome, 'INFRA_FAILURE', 'no-required-obligation smoke must not accept fixture INFRA_FAILURE as success')
  assert.ok(
    terminal.outcome === 'UNVERIFIED_PATCH' ||
    terminal.outcome === 'NO_CHANGE_REQUIRED' ||
    terminal.outcome === 'AGENT_FAILURE' ||
    terminal.outcome === 'BUDGET_EXHAUSTED' ||
    terminal.outcome === 'NEEDS_HUMAN_DECISION' ||
    terminal.outcome === 'BLOCKED_POLICY',
    `conservative nonverified terminal (got ${terminal.outcome})`,
  )
  assert.match(readFileSync(join(projectRoot, 'src', 'task.ts'), 'utf8'), /answer = 42/)
})
