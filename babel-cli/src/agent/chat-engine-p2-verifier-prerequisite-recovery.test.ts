/**
 * P2 — required verifier with unchanged isolation prerequisite (production transport).
 *
 * Real ChatEngine on the qualified OpenCode Go route; production runner factory and
 * admission/budget/critic wiring. Only globalThis.fetch is mocked (bottom transport).
 *
 * Reported route (non-secret): backend key `opencode-go/deepseek-v4.1-flash`, provider
 * `opencode-go`, model `deepseek-v4.1-flash`, endpoint `https://opencode.ai/zen/go/v1/chat/completions`.
 *
 * Same-obligation native-alternative producer: explicitly deferred on base 115c0895 (no fake authority).
 *
 * Production proposal (root review only — not implemented):
 * Use existing blocked planner path + truthful candidate presentation (not synthetic turn limit).
 * At denial/suppression boundaries, record ONE task-local fact binding required verifier identity
 * (existing satisfiesVerifierRequirement) to owner/environment/prerequisite revision; if linkage
 * unknown, keep reject_continue recovery. shellBlocked+consumed alone is insufficient because
 * shell scope has no command identity and probe consumption precedes policy evaluation.
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
import { areAllRequiredVerifiersSatisfied } from './completionGatePolicy.js'
import type { ProgressController } from './progressController.js'

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..')
const ROUTE_BACKEND_KEY = 'opencode-go/deepseek-v4.1-flash'
const ROUTE_MODEL_ID = 'deepseek-v4.1-flash'
const MAIN_LOOP_URL = `${OPENCODE_GO_BASE_URL}/chat/completions`
const REQUIRED_VERIFIER_CMD = 'npm test'
const NPM_TEST_SHELL = 'npm test'
const UNRELATED_SHELL = 'node -e "void 0"'

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

function seedRepository(projectRoot: string, opts?: { failingTest?: boolean }): void {
  mkdirSync(join(projectRoot, 'src'), { recursive: true })
  writeFileSync(join(projectRoot, 'src', 'task.ts'), 'export const answer = 0;\n', 'utf8')
  git(projectRoot, ['init', '-q', '--initial-branch=main'])
  git(projectRoot, ['config', 'user.email', 'fixture@example.invalid'])
  git(projectRoot, ['config', 'user.name', 'Fixture'])
  git(projectRoot, ['add', 'src/task.ts'])
  git(projectRoot, ['commit', '-qm', 'P2 prerequisite fixture'])
  const testBody = opts?.failingTest
    ? [
      "import { readFileSync } from 'node:fs';",
      "const src = readFileSync('src/task.ts', 'utf8');",
      "if (!/answer = 42/.test(src)) { console.error('answer must be 42'); process.exit(1); }",
      '',
    ].join('\n')
    : 'process.exit(0);\n'
  writeFileSync(
    join(projectRoot, 'package.json'),
    JSON.stringify({ private: true, scripts: { test: 'node fixture.test.mjs' } }),
    'utf8',
  )
  writeFileSync(join(projectRoot, 'fixture.test.mjs'), testBody, 'utf8')
  git(projectRoot, ['add', 'package.json', 'fixture.test.mjs'])
  git(projectRoot, ['commit', '-qm', 'add required verifier script'])
}

function installSyntheticGoCredential(runtimeRoot: string): void {
  const helper = join(runtimeRoot, 'auth-helper.cjs')
  writeFileSync(helper, "process.stdout.write('synthetic-in-memory-test-credential')\n", 'utf8')
  process.env['BABEL_OPENCODE_GO_HELPER'] = helper
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
  installSyntheticGoCredential(runsRoot)
  refreshDryRunState()
}

function applyDevLocalRunnable(runsRoot: string): void {
  for (const key of MANAGED_ENV) delete process.env[key]
  process.env['BABEL_EXECUTION_PROFILE'] = 'dev_local'
  process.env['BABEL_ALLOW_HOST_FALLBACK'] = '1'
  process.env['BABEL_AUTONOMY_LEASE'] = SYNTHETIC_LEASE
  process.env['BABEL_DRY_RUN'] = '0'
  process.env['BABEL_DRY_RUN_SOURCE'] = 'session'
  process.env['BABEL_RUNS_DIR'] = runsRoot
  installSyntheticGoCredential(runsRoot)
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

function makeCriticAllowResponse(): Response {
  return Response.json({
    model: ROUTE_MODEL_ID,
    choices: [{
      message: {
        content: JSON.stringify({ verdict: 'allow', confidence: 1, reasons: ['fixture allow'] }),
      },
      finish_reason: 'stop',
    }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  })
}

function installFetchHarness(
  mainScript: MainTurnSpec[],
  opts?: { spillCompletionText?: string },
): {
  counts: { mainLoop: number; auxiliary: number }
  restore: () => void
} {
  let mainIdx = 0
  const counts = { mainLoop: 0, auxiliary: 0 }
  globalThis.fetch = (async (input, init) => {
    const url = String(input)
    if (url !== MAIN_LOOP_URL) {
      throw new Error(`unexpected network fetch url=${url}`)
    }
    const body = JSON.parse(String(init?.body ?? '{}')) as { stream?: boolean }
    if (body.stream !== true) {
      counts.auxiliary += 1
      return makeCriticAllowResponse()
    }
    counts.mainLoop += 1
    const turn = mainScript[mainIdx] ?? (
      opts?.spillCompletionText
        ? { kind: 'text' as const, text: opts.spillCompletionText }
        : undefined
    )
    mainIdx += 1
    if (!turn) {
      throw new Error(`unexpected main-loop provider fetch (script exhausted at ${mainIdx})`)
    }
    if (turn.kind === 'text') return makeTextCompletionSse(turn.text)
    if (turn.toolCalls.length === 1) {
      const only = turn.toolCalls[0]!
      return makeToolCallSse(only.name, only.args, only.id)
    }
    return makeMultiToolSse(turn.toolCalls)
  }) as typeof fetch
  return {
    counts,
    restore: () => {
      globalThis.fetch = originalFetch
    },
  }
}

async function collectStream(stream: AsyncGenerator<ChatEvent, unknown, undefined>): Promise<ChatEvent[]> {
  const events: ChatEvent[] = []
  for await (const event of stream) events.push(event)
  return events
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
    conversation: Array<{ role: string; content: string; name?: string }>
  }
}

function authoritativeExecutedCommands(log: ShellLogEntry[]): string[] {
  return log
    .filter(entry => entry.detail !== 'prerequisite_suppressed' && entry.error !== 'blocked')
    .map(entry => (entry.target ?? '').trim())
    .filter(Boolean)
}

function terminalSnapshot(events: ChatEvent[]): {
  type: 'done' | 'failed'
  outcome: TerminalOutcome | undefined
} {
  const terminals = events.filter(event => event.type === 'done' || event.type === 'failed')
  assert.equal(terminals.length, 1, `expected one terminal, saw ${terminals.map(e => e.type).join(',')}`)
  const terminal = terminals[0]!
  assert.ok(terminal.type === 'done' || terminal.type === 'failed')
  const outcome = terminal.type === 'done' ? terminal.outcome : terminal.outcome
  return { type: terminal.type, outcome }
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
    maxCostUsd: 2,
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
  ])
  t.after(() => fetchHarness.restore())

  const engine = createProductionEngine({
    projectRoot,
    runId: `p2-red-${randomUUID()}`,
    task: 'Fix src/task.ts and run the required npm test verifier. No alternate verifier exists.',
    requiredVerifierCommands: [REQUIRED_VERIFIER_CMD],
  })

  const events = await collectStream(engine.submitMessageStream(
    'Fix src/task.ts and run the required npm test verifier. No alternate verifier exists.',
  ))

  const shells = shellLog(engine)
  const evaluated = shells.filter(entry => entry.detail !== 'prerequisite_suppressed')
  const suppressed = shells.filter(entry => entry.detail === 'prerequisite_suppressed')

  assert.equal(evaluated.length, 1)
  assert.equal(suppressed.length, 1)
  assert.equal(evaluated[0]?.target, NPM_TEST_SHELL)
  assert.equal(suppressed[0]?.target, NPM_TEST_SHELL)
  assert.match(
    `${evaluated[0]?.stderr ?? ''} ${evaluated[0]?.error ?? ''} ${evaluated[0]?.detail ?? ''}`,
    /CAPABILITY_DENIED:isolation_unavailable|isolation_unavailable/,
  )

  const host = engineHost(engine)
  const scope = bindIsolationPrerequisiteScope(host)
  const revisionAtEnd = isolationPrerequisiteRevisionKey(host.isolationBrokerFlags())
  assert.equal(scope.revisionKey, revisionAtEnd)
  assert.equal(host.progressController.hasConsumedPrerequisiteDenialProbe(scope), true)

  const edit = (engine as unknown as { toolCallLog: ShellLogEntry[] }).toolCallLog
    .filter(entry => entry.tool === 'str_replace')
  assert.ok(edit.length >= 1)
  assert.equal(edit.every(entry => entry.exit_code === 0), true)
  assert.match(readFileSync(join(projectRoot, 'src', 'task.ts'), 'utf8'), /answer = 42/)

  const executed = authoritativeExecutedCommands(shells)
  assert.equal(
    areAllRequiredVerifiersSatisfied([REQUIRED_VERIFIER_CMD], executed),
    false,
    'required npm test must remain unsatisfied',
  )
  const receipt = host.lastVerifierReceipt
  assert.ok(!receipt || receipt.exit_code !== 0 || receipt.stale === true, 'no satisfying authoritative receipt')

  const gateStrikes = (engine as unknown as { gateStrikes: number }).gateStrikes
  const policyEvents = (engine as unknown as {
    policyEventLog: { toJSON: () => Array<{ kind: string; detail: string }> }
  }).policyEventLog.toJSON()
  const dishonestProse = host.conversation.some(
    message => message.role === 'assistant' && /VERIFIED_COMPLETE/i.test(message.content),
  )
  assert.equal(dishonestProse, true, 'dishonest completion prose must be admitted to the thread')
  const gateRejectionEvidence =
    gateStrikes >= 1 ||
    host.conversation.some(
      message =>
        message.name === 'harness_feedback' ||
        (message.role === 'user' && /verifier|before completing|gate/i.test(message.content)),
    ) ||
    policyEvents.some(event => /verifier|gate/i.test(event.detail))
  assert.ok(gateRejectionEvidence, 'verifier-related gate rejection must be recorded')

  const terminal = terminalSnapshot(events)
  assert.notEqual(terminal.outcome, 'VERIFIED_COMPLETE')
  const allowed: TerminalOutcome[] = [
    'UNVERIFIED_PATCH',
    'NEEDS_HUMAN_DECISION',
    'BLOCKED_POLICY',
    'AGENT_FAILURE',
    'BUDGET_EXHAUSTED',
    'INFRA_FAILURE',
    'BLOCKED_EXTERNAL',
  ]
  assert.ok(terminal.outcome && allowed.includes(terminal.outcome), `nonverified terminal (got ${terminal.outcome})`)

  const redBundle = {
    mainLoopFetchCount: fetchHarness.counts.mainLoop,
    auxiliaryFetchCount: fetchHarness.counts.auxiliary,
    terminalType: terminal.type,
    terminalOutcome: terminal.outcome,
    routeBackendKey: ROUTE_BACKEND_KEY,
    routeModelId: ROUTE_MODEL_ID,
    endpoint: MAIN_LOOP_URL,
  }

  assert.equal(
    redBundle.mainLoopFetchCount,
    3,
    `unnecessary main-loop provider recovery fetch (bundle=${JSON.stringify(redBundle)})`,
  )
})

test('P2 control: same required verifier runnable on dev_local with host fallback', async t => {
  const prior = Object.fromEntries(MANAGED_ENV.map(key => [key, process.env[key]]))
  const runsRoot = mkdtempSync(join(tmpdir(), 'babel-p2-runs-'))
  const projectRoot = mkdtempSync(join(tmpdir(), 'babel-p2-repo-'))
  t.after(() => {
    restoreEnv(prior)
    rmSync(runsRoot, { recursive: true, force: true })
    rmSync(projectRoot, { recursive: true, force: true })
  })

  applyDevLocalRunnable(runsRoot)
  seedRepository(projectRoot)

  const fetchHarness = installFetchHarness([
    {
      kind: 'tools',
      toolCalls: [
        {
          id: 'edit-task',
          name: 'str_replace',
          args: {
            file_path: 'src/task.ts',
            old_str: 'export const answer = 0;',
            new_str: 'export const answer = 42;',
          },
        },
        { id: 'ver-ok', name: 'run_command', args: { command: NPM_TEST_SHELL } },
      ],
    },
    { kind: 'text', text: 'Updated and verified with npm test.' },
  ], { spillCompletionText: 'Updated and verified with npm test.' })
  t.after(() => fetchHarness.restore())

  const engine = createProductionEngine({
    projectRoot,
    runId: `p2-run-${randomUUID()}`,
    task: 'Fix src/task.ts and run npm test.',
    requiredVerifierCommands: [REQUIRED_VERIFIER_CMD],
  })

  await collectStream(engine.submitMessageStream('Fix src/task.ts and run npm test.'))
  const shells = shellLog(engine)
  assert.ok(shells.some(entry => entry.detail !== 'prerequisite_suppressed' && entry.target === NPM_TEST_SHELL && entry.exit_code === 0))
  assert.equal(shells.some(entry => entry.detail === 'prerequisite_suppressed'), false)
  assert.ok(fetchHarness.counts.mainLoop >= 1)
})

test('P2 control: same verifier fails then repair then passes', async t => {
  const prior = Object.fromEntries(MANAGED_ENV.map(key => [key, process.env[key]]))
  const runsRoot = mkdtempSync(join(tmpdir(), 'babel-p2-runs-'))
  const projectRoot = mkdtempSync(join(tmpdir(), 'babel-p2-repo-'))
  t.after(() => {
    restoreEnv(prior)
    rmSync(runsRoot, { recursive: true, force: true })
    rmSync(projectRoot, { recursive: true, force: true })
  })

  applyDevLocalRunnable(runsRoot)
  seedRepository(projectRoot, { failingTest: true })
  assert.notEqual(
    spawnSync('npm', ['test'], { cwd: projectRoot, encoding: 'utf-8', shell: true, windowsHide: true }).status,
    0,
    'fixture npm test must fail before repair',
  )

  const fetchHarness = installFetchHarness([
    {
      kind: 'tools',
      toolCalls: [
        {
          id: 'edit-task',
          name: 'str_replace',
          args: {
            file_path: 'src/task.ts',
            old_str: 'export const answer = 0;',
            new_str: 'export const answer = 42;',
          },
        },
        { id: 'ver-pass', name: 'run_command', args: { command: NPM_TEST_SHELL } },
      ],
    },
    { kind: 'text', text: 'Tests pass after repair.' },
  ], { spillCompletionText: 'Tests pass after repair.' })
  t.after(() => fetchHarness.restore())

  const engine = createProductionEngine({
    projectRoot,
    runId: `p2-repair-${randomUUID()}`,
    task: 'Fix src/task.ts until npm test passes.',
    requiredVerifierCommands: [REQUIRED_VERIFIER_CMD],
  })

  await collectStream(engine.submitMessageStream('Fix src/task.ts until npm test passes.'))
  const shells = shellLog(engine).filter(entry => entry.target === NPM_TEST_SHELL && entry.detail !== 'prerequisite_suppressed')
  assert.ok(shells.some(entry => entry.exit_code === 0), 'governed npm test must pass after repair')
  assert.match(readFileSync(join(projectRoot, 'src', 'task.ts'), 'utf8'), /answer = 42/)
})

test('P2 control: prerequisite revision re-admits shell after host fallback change', async t => {
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

  const blockedHarness = installFetchHarness([
    { kind: 'tools', toolCalls: [{ id: 'ver-blocked', name: 'run_command', args: { command: NPM_TEST_SHELL } }] },
    { kind: 'text', text: 'Shell blocked.' },
  ], { spillCompletionText: 'Shell blocked.' })
  const engine = createProductionEngine({
    projectRoot,
    runId: `p2-rev-${randomUUID()}`,
    task: 'Run npm test.',
    requiredVerifierCommands: [REQUIRED_VERIFIER_CMD],
  })
  await collectStream(engine.submitMessageStream('Run npm test once.'))
  blockedHarness.restore()

  const blockedShells = shellLog(engine).filter(entry => entry.target === NPM_TEST_SHELL)
  assert.equal(blockedShells.filter(entry => entry.detail !== 'prerequisite_suppressed').length, 1)

  process.env['BABEL_ALLOW_HOST_FALLBACK'] = '1'
  refreshDryRunState()

  const revisedHarness = installFetchHarness([
    { kind: 'tools', toolCalls: [{ id: 'ver-open', name: 'run_command', args: { command: NPM_TEST_SHELL } }] },
    { kind: 'text', text: 'npm test ran after revision.' },
  ], { spillCompletionText: 'npm test ran after revision.' })
  t.after(() => revisedHarness.restore())

  await collectStream(engine.submitMessageStream('Run npm test again after isolation revision.'))
  const after = shellLog(engine).filter(entry => entry.target === NPM_TEST_SHELL && entry.detail !== 'prerequisite_suppressed')
  assert.ok(after.some(entry => entry.exit_code === 0), 'revised prerequisite must allow a fresh governed evaluation')
})

test('P2 control: unrelated shell probe consumption does not satisfy required verifier obligation', async t => {
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
    { kind: 'tools', toolCalls: [{ id: 'unrelated', name: 'run_command', args: { command: UNRELATED_SHELL } }] },
    { kind: 'tools', toolCalls: [{ id: 'ver-1', name: 'run_command', args: { command: NPM_TEST_SHELL } }] },
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
    { kind: 'text', text: 'Done without verifier authority.' },
  ])
  t.after(() => fetchHarness.restore())

  const engine = createProductionEngine({
    projectRoot,
    runId: `p2-unrelated-${randomUUID()}`,
    task: 'Fix src/task.ts; required verifier is npm test.',
    requiredVerifierCommands: [REQUIRED_VERIFIER_CMD],
  })

  const events = await collectStream(engine.submitMessageStream(
    'Fix src/task.ts; required verifier is npm test.',
  ))

  const shells = shellLog(engine)
  const unrelated = shells.filter(entry => (entry.target ?? '').includes('node -e'))
  assert.equal(unrelated.length, 1)
  assert.match(
    `${unrelated[0]?.stderr ?? ''} ${unrelated[0]?.error ?? ''}`,
    /CAPABILITY_DENIED:isolation_unavailable|isolation_unavailable/,
  )
  assert.equal(
    areAllRequiredVerifiersSatisfied([REQUIRED_VERIFIER_CMD], authoritativeExecutedCommands(shells)),
    false,
  )
  const terminal = terminalSnapshot(events)
  assert.notEqual(terminal.outcome, 'VERIFIED_COMPLETE')
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
  ], { spillCompletionText: 'File updated without shell verifier.' })
  t.after(() => fetchHarness.restore())

  const engine = createProductionEngine({
    projectRoot,
    runId: `p2-native-fallback-${randomUUID()}`,
    task: 'File edit only; shell verifier not required.',
  })

  const events = await collectStream(engine.submitMessageStream('Set answer to 42 without running tests.'))
  const terminal = terminalSnapshot(events)
  assert.notEqual(terminal.outcome, 'VERIFIED_COMPLETE')
  assert.ok(
    terminal.outcome === 'UNVERIFIED_PATCH' ||
    terminal.outcome === 'NO_CHANGE_REQUIRED' ||
    terminal.outcome === 'AGENT_FAILURE' ||
    terminal.outcome === 'BUDGET_EXHAUSTED' ||
    terminal.outcome === 'NEEDS_HUMAN_DECISION' ||
    terminal.outcome === 'BLOCKED_POLICY' ||
    terminal.outcome === 'INFRA_FAILURE',
    `conservative nonverified terminal (got ${terminal.outcome})`,
  )
  assert.match(readFileSync(join(projectRoot, 'src', 'task.ts'), 'utf8'), /answer = 42/)
})
