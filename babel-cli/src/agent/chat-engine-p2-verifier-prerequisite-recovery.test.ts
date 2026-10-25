/**
 * P2 — required verifier prerequisite unchanged/unavailable: prove provider turn budget.
 *
 * Drives the real ChatEngine native loop with ONLY `providerRunner` mocked
 * (`executeWithToolsStream`). Tool dispatch, isolation policy, prerequisite
 * probes (`bindIsolationPrerequisiteScope` / `admitPrerequisiteDenialProbe`),
 * and completion gate run for real.
 *
 * ## Offline RED (base 115c0895…, commit ed211b33…)
 *
 * Focused TAP: `node --import tsx --test src/agent/chat-engine-p2-verifier-prerequisite-recovery.test.ts`
 * Expected exit **1**: RED asserts `providerTurnCount() === 3`, observed **4** (extra batch after
 * completion-gate `reject_continue` on dishonest VERIFIED_COMPLETE prose).
 *
 * Prerequisite seam evidence in RED: exactly one evaluated shell + one `prerequisite_suppressed`;
 * `progress_recovery` events **0** (ProgressController does not escalate; provider loop still continues).
 *
 * ## Smallest conditional wiring proposal (root review — not implemented here)
 *
 * In `settleStreamingCompletion` when `plan.kind === 'reject_continue'`:
 *
 * 1. Keep using explicit `host.options.requiredVerifierCommands` (non-empty array only; never infer
 *    from empty manifest / tool log alone).
 * 2. If `areAllRequiredVerifiersSatisfied(required, authoritativeExecutedCommands)` is already false
 *    **and** `shellBlockedByIsolation(host.isolationBrokerFlags())` **and**
 *    `host.progressController.hasConsumedPrerequisiteDenialProbe(bindIsolationPrerequisiteScope(host))`,
 *    then do **not** `return 'continue'`.
 * 3. Instead terminate via existing nonverified preservation: `captureGateRejectedCompletionAttempt`
 *    (already called), then `resolvePreservedUnverifiedAtTurnLimit` / `formatPreservedUnverifiedTerminalAnswer`
 *    when retainable, else `streamDone` / `streamFailed` with gate rejection + blocked verifier report —
 *    same authority as turn-limit path in `chatEngineStreamingFinalizer.ts`, without `VERIFIED_COMPLETE`.
 *
 * Must not fire when: host fallback allows runnable shell (`dev_local` control), prerequisite
 * `revisionKey` changes (`bindIsolationPrerequisiteScope` + `admitPrerequisiteDenialProbe` control),
 * `admitCapabilityRecoveryProbe` temporary failure path, or native edit with no required verifier.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { ChatEngine } from './chatEngine.js'
import type { ChatEvent } from './chatEngine.js'
import type { TerminalOutcome } from '../schemas/agentContracts.js'
import type { ResolvedModelPolicy } from '../modelPolicy.js'
import type { ToolStreamEvent } from '../runners/base.js'
import { refreshDryRunState } from '../localTools.js'
import { bindIsolationPrerequisiteScope } from './capabilityRecoveryScope.js'
import { ProgressController } from './progressController.js'

const FIXTURE_POLICY: ResolvedModelPolicy = {
  policyPath: 'p2-prerequisite-fixture',
  family: 'p2-prerequisite-fixture',
  selectedTier: 'cheap',
  resolvedBackendKey: 'p2-prerequisite-fixture',
  provider: 'deepinfra',
  providerModelId: 'p2-prerequisite-fixture-model',
  expensive: false,
  enabled: true,
  experimental: true,
  blockedWithoutExplicitOptIn: false,
  approximateInputTokens: 0,
  approximateOutputTokens: 0,
  warnings: [],
  waterfall: [],
  stagePolicies: [],
  contextWindow: 128_000,
  contextLimit: 128_000,
  maxOutputTokens: 4_096,
  nativeToolUse: true,
}

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
  'BABEL_DIFF_CRITIC',
  'BABEL_COMPACTION',
  'BABEL_DIRTY_TREE',
  'BABEL_CHAT_MAX_COST',
] as const

const REQUIRED_VERIFIER_CMD = 'npm test'
const NPM_TEST_SHELL = 'npm test'

function git(projectRoot: string, args: string[]): void {
  const result = spawnSync('git', args, {
    cwd: projectRoot,
    encoding: 'utf-8',
    windowsHide: true,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(projectRoot, 'no-global-gitconfig') },
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
  writeFileSync(
    join(projectRoot, 'package.json'),
    JSON.stringify({ private: true, scripts: { test: 'node --test fixture.test.mjs' } }),
    'utf8',
  )
  writeFileSync(join(projectRoot, 'fixture.test.mjs'), 'import test from "node:test"; test("x", () => {});\n', 'utf8')
  git(projectRoot, ['add', 'package.json', 'fixture.test.mjs'])
  git(projectRoot, ['commit', '-qm', 'add required verifier script'])
}

async function collectStream(stream: AsyncGenerator<ChatEvent, unknown, undefined>): Promise<ChatEvent[]> {
  const events: ChatEvent[] = []
  for await (const event of stream) events.push(event)
  return events
}

function buildCountedRunner(plan: ToolStreamEvent[][]): {
  runner: {
    executeWithToolsStream: () => AsyncGenerator<ToolStreamEvent>
    execute: () => Promise<{ type: 'completion'; answer: string }>
    executeRaw: () => Promise<string>
    getLastInvocationMetadata: () => null
    buildNativeToolsWireBody: () => string
    getNativeRequestReservedCompletionTokens: () => number
  }
  providerTurnCount: () => number
} {
  let turn = 0
  return {
    providerTurnCount: () => turn,
    runner: {
      async *executeWithToolsStream() {
        const batch = plan[Math.min(turn, plan.length - 1)] ?? []
        turn += 1
        for (const event of batch) yield event
      },
      async execute() {
        return { type: 'completion', answer: 'fixture completion' }
      },
      async executeRaw() {
        return 'fixture completion'
      },
      getLastInvocationMetadata() {
        return null
      },
      buildNativeToolsWireBody() {
        return '{}'
      },
      getNativeRequestReservedCompletionTokens() {
        return 4_096
      },
    },
  }
}

function applyIsolationBlockedEnv(leaseId: string): void {
  for (const key of MANAGED_ENV) delete process.env[key]
  process.env['BABEL_EXECUTION_PROFILE'] = 'safe_repo'
  process.env['BABEL_ALLOW_HOST_FALLBACK'] = '0'
  process.env['BABEL_DOCKER_DISABLE'] = 'false'
  delete process.env['BABEL_BENCHMARK_DOCKER_IMAGE']
  process.env['BABEL_BENCHMARK_MODE'] = '1'
  process.env['BABEL_BENCHMARK_AUTO_APPROVE'] = '1'
  process.env['BABEL_DRY_RUN'] = '0'
  process.env['BABEL_DRY_RUN_SOURCE'] = 'session'
  process.env['BABEL_DIFF_CRITIC'] = '0'
  process.env['BABEL_COMPACTION'] = 'off'
  process.env['BABEL_DIRTY_TREE'] = '0'
  process.env['BABEL_CHAT_MAX_COST'] = 'unlimited'
  process.env['BABEL_AUTONOMY_LEASE'] = JSON.stringify({
    version: 2,
    leaseId,
    scope: { repository: 'p2-prerequisite-fixture', objective: 'required verifier with isolation prerequisite' },
    allowedCapabilities: ['edit_task_files', 'inspect_repository', 'run_local_command', 'run_tests'],
  })
  refreshDryRunState()
}

function restoreEnv(prior: Record<string, string | undefined>): void {
  for (const key of MANAGED_ENV) {
    if (prior[key] === undefined) delete process.env[key]
    else process.env[key] = prior[key]
  }
  refreshDryRunState()
}

function shellVerifierLog(engine: ChatEngine): Array<{ detail?: string; error?: string; exit_code?: number }> {
  const log = (engine as unknown as {
    toolCallLog: Array<{ tool: string; detail?: string; error?: string; exit_code?: number }>
  }).toolCallLog
  return log.filter(entry => entry.tool === 'run_command' || entry.tool === 'test_run')
}

test('P2 RED: unchanged required verifier prerequisite must not trigger extra provider recovery turn', async t => {
  const prior = Object.fromEntries(MANAGED_ENV.map(key => [key, process.env[key]]))
  const projectRoot = mkdtempSync(join(tmpdir(), 'babel-p2-prereq-red-'))
  t.after(() => {
    restoreEnv(prior)
    rmSync(projectRoot, { recursive: true, force: true })
  })

  applyIsolationBlockedEnv(`p2-prereq-red-${randomUUID()}`)
  seedRepository(projectRoot)

  const { runner, providerTurnCount } = buildCountedRunner([
    [{ type: 'tool_use', id: 'ver-1', name: 'run_command', input: { command: NPM_TEST_SHELL } }, { type: 'done', finishReason: 'tool_calls' }],
    [
      { type: 'tool_use', id: 'ver-2', name: 'run_command', input: { command: NPM_TEST_SHELL } },
      {
        type: 'tool_use',
        id: 'edit-task',
        name: 'str_replace',
        input: { file_path: 'src/task.ts', old_str: 'export const answer = 0;', new_str: 'export const answer = 42;' },
      },
      { type: 'done', finishReason: 'tool_calls' },
    ],
    [
      {
        type: 'text_delta',
        text: 'VERIFIED_COMPLETE: npm test passed and the required verifier succeeded.',
      },
      { type: 'done', finishReason: 'stop' },
    ],
  ])

  const engine = new ChatEngine({
    task: 'Fix src/task.ts and run the required npm test verifier. No alternate verifier exists.',
    projectRoot,
    runId: `p2-prereq-red-${randomUUID()}`,
    operation: 'CHANGE',
    model: 'deepseek-v4-flash',
    maxTurns: 8,
    requiredVerifierCommands: [REQUIRED_VERIFIER_CMD],
    providerRunner: runner as never,
    providerPolicy: FIXTURE_POLICY,
  })

  const events = await collectStream(engine.submitMessageStream(
    'Fix src/task.ts and run the required npm test verifier. No alternate verifier exists.',
  ))

  const shells = shellVerifierLog(engine)
  assert.equal(shells.filter(entry => entry.detail !== 'prerequisite_suppressed').length, 1)
  assert.equal(shells.filter(entry => entry.detail === 'prerequisite_suppressed').length, 1)

  const recoveryTurns = events.filter(event => event.type === 'progress_recovery')
  assert.equal(recoveryTurns.length, 0, 'no progress_recovery provider-steer after consumed prerequisite denial')

  // RED target: once prerequisite denial is consumed and required verifier cannot run,
  // completion-gate rejection must not schedule another provider batch.
  assert.equal(
    providerTurnCount(),
    3,
    `unnecessary provider recovery turn requested (got ${providerTurnCount()} provider batches)`,
  )

  const terminals = events.filter(event => event.type === 'done' || event.type === 'failed')
  assert.equal(terminals.length, 1)
  const terminal = terminals[0]
  assert.ok(terminal?.type === 'done' || terminal?.type === 'failed')
  const outcome = terminal.type === 'done' ? terminal.outcome : terminal.outcome
  const allowed: TerminalOutcome[] = ['UNVERIFIED_PATCH', 'NEEDS_HUMAN_DECISION', 'BLOCKED_POLICY', 'AGENT_FAILURE']
  assert.ok(outcome && allowed.includes(outcome), `nonverified terminal without VERIFIED_COMPLETE promotion: ${outcome}`)
  assert.notEqual(outcome, 'VERIFIED_COMPLETE')
})

test('P2 control: runnable required verifier still dispatches when isolation allows host fallback', async t => {
  const prior = Object.fromEntries(MANAGED_ENV.map(key => [key, process.env[key]]))
  const projectRoot = mkdtempSync(join(tmpdir(), 'babel-p2-prereq-run-'))
  t.after(() => {
    restoreEnv(prior)
    rmSync(projectRoot, { recursive: true, force: true })
  })

  applyIsolationBlockedEnv(`p2-prereq-run-${randomUUID()}`)
  process.env['BABEL_EXECUTION_PROFILE'] = 'dev_local'
  process.env['BABEL_ALLOW_HOST_FALLBACK'] = '1'
  seedRepository(projectRoot)

  const { runner, providerTurnCount } = buildCountedRunner([
    [
      {
        type: 'tool_use',
        id: 'edit-task',
        name: 'str_replace',
        input: { file_path: 'src/task.ts', old_str: 'export const answer = 0;', new_str: 'export const answer = 42;' },
      },
      { type: 'tool_use', id: 'ver-ok', name: 'run_command', input: { command: NPM_TEST_SHELL } },
      { type: 'done', finishReason: 'tool_calls' },
    ],
    [{ type: 'text_delta', text: 'Updated and verified.' }, { type: 'done', finishReason: 'stop' }],
  ])

  const engine = new ChatEngine({
    task: 'Fix src/task.ts and run npm test.',
    projectRoot,
    runId: `p2-prereq-run-${randomUUID()}`,
    operation: 'CHANGE',
    model: 'deepseek-v4-flash',
    maxTurns: 6,
    requiredVerifierCommands: [REQUIRED_VERIFIER_CMD],
    providerRunner: runner as never,
    providerPolicy: FIXTURE_POLICY,
  })

  await collectStream(engine.submitMessageStream('Fix src/task.ts and run npm test.'))
  const shells = shellVerifierLog(engine)
  assert.ok(shells.some(entry => entry.detail !== 'prerequisite_suppressed' && entry.exit_code === 0))
  assert.equal(shells.some(entry => entry.detail === 'prerequisite_suppressed'), false)
  assert.ok(providerTurnCount() >= 1)
})

test('P2 control: prerequisite revision re-admits one evaluation (trusted scope evidence)', () => {
  const pc = new ProgressController()
  const host = {
    progressController: pc,
    engineRunId: 'engine-rev',
    executionProfile: 'safe_repo',
    taskAllowance: { taskOwnerId: 'task-rev' },
    options: { projectRoot: '/tmp/p2', model: 'fixture' },
    isolationBrokerFlags: () => ({
      isolationRequired: true,
      isolationAvailable: false,
      hostFallbackAllowed: false,
      dirtyTree: false,
    }),
  }
  const blocked = bindIsolationPrerequisiteScope(host)
  assert.equal(pc.admitPrerequisiteDenialProbe(blocked), true)
  assert.equal(pc.admitPrerequisiteDenialProbe(blocked), false)
  host.isolationBrokerFlags = () => ({
    isolationRequired: true,
    isolationAvailable: false,
    hostFallbackAllowed: true,
    dirtyTree: false,
  })
  const revised = bindIsolationPrerequisiteScope(host)
  assert.equal(pc.admitPrerequisiteDenialProbe(revised), true)
})

test('P2 control: temporary capability failure still allows one bounded recovery probe', () => {
  const pc = new ProgressController()
  pc.setTrustedEnvironmentIdentity('env-temp')
  const scope = { capability: 'shell.recursive_enumeration', taskId: 'task-temp', environmentIdentity: 'env-temp' }
  pc.recordFailure({ tool: 'run_command', commandSnippet: 'ls -R', exitCode: 1, capabilityFailure: true })
  pc.recordFailure({ tool: 'run_command', commandSnippet: 'ls -R', exitCode: 1, capabilityFailure: true })
  assert.equal(pc.admitCapabilityRecoveryProbe(scope), true)
  assert.equal(pc.admitCapabilityRecoveryProbe(scope), false)
})

test('P2 control: authorized native file edit without required verifier stays nonverified not blocked', async t => {
  const prior = Object.fromEntries(MANAGED_ENV.map(key => [key, process.env[key]]))
  const projectRoot = mkdtempSync(join(tmpdir(), 'babel-p2-prereq-native-'))
  t.after(() => {
    restoreEnv(prior)
    rmSync(projectRoot, { recursive: true, force: true })
  })

  applyIsolationBlockedEnv(`p2-prereq-native-${randomUUID()}`)
  seedRepository(projectRoot)

  const { runner } = buildCountedRunner([
    [
      {
        type: 'tool_use',
        id: 'edit-task',
        name: 'str_replace',
        input: { file_path: 'src/task.ts', old_str: 'export const answer = 0;', new_str: 'export const answer = 42;' },
      },
      { type: 'done', finishReason: 'tool_calls' },
    ],
    [{ type: 'text_delta', text: 'File updated without shell verifier.' }, { type: 'done', finishReason: 'stop' }],
  ])

  const engine = new ChatEngine({
    task: 'File edit only; shell verifier not required.',
    projectRoot,
    runId: `p2-prereq-native-${randomUUID()}`,
    operation: 'CHANGE',
    model: 'deepseek-v4-flash',
    maxTurns: 4,
    providerRunner: runner as never,
    providerPolicy: FIXTURE_POLICY,
  })

  const events = await collectStream(engine.submitMessageStream('Set answer to 42 without running tests.'))
  const terminal = events.find(event => event.type === 'done' || event.type === 'failed')
  assert.ok(terminal)
  const outcome = terminal.type === 'done' ? terminal.outcome : terminal.outcome
  assert.notEqual(outcome, 'VERIFIED_COMPLETE')
  assert.ok(
    outcome === 'UNVERIFIED_PATCH' ||
    outcome === 'NO_CHANGE_REQUIRED' ||
    outcome === 'AGENT_FAILURE' ||
    outcome === 'BUDGET_EXHAUSTED',
  )
  assert.match(readFileSync(join(projectRoot, 'src', 'task.ts'), 'utf8'), /answer = 42/)
})
