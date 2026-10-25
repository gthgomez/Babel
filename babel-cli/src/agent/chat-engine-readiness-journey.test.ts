/**
 * P02 — actual ChatEngine readiness/recovery (native entry points).
 * Scripted provider + real tool dispatch/policy; authoritative terminal outcomes only.
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
import type { ResolvedModelPolicy } from '../modelPolicy.js'
import type { ToolStreamEvent } from '../runners/base.js'
import { refreshDryRunState } from '../localTools.js'

const FIXTURE_POLICY: ResolvedModelPolicy = {
  policyPath: 'p02-readiness-fixture',
  family: 'p02-readiness-fixture',
  selectedTier: 'cheap',
  resolvedBackendKey: 'p02-readiness-fixture',
  provider: 'deepinfra',
  providerModelId: 'p02-readiness-fixture-model',
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
] as const

const USER_NOTES = 'user-owned notes must remain\n'
const SHELL_PROBE = 'node -e "void 0"'

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
  writeFileSync(join(projectRoot, 'user-notes.md'), USER_NOTES, 'utf8')
  git(projectRoot, ['init', '-q', '--initial-branch=main'])
  git(projectRoot, ['config', 'user.email', 'fixture@example.invalid'])
  git(projectRoot, ['config', 'user.name', 'Fixture'])
  git(projectRoot, ['add', 'src/task.ts', 'user-notes.md'])
  git(projectRoot, ['commit', '-qm', 'P02 readiness fixture'])
}

async function collectStream(stream: AsyncGenerator<ChatEvent, unknown, undefined>): Promise<ChatEvent[]> {
  const events: ChatEvent[] = []
  for await (const event of stream) events.push(event)
  return events
}

function buildRunner(plan: ToolStreamEvent[][]): {
  runner: {
    executeWithToolsStream: () => AsyncGenerator<ToolStreamEvent>
    execute: () => Promise<{ type: 'completion'; answer: string }>
    executeRaw: () => Promise<string>
    getLastInvocationMetadata: () => null
    buildNativeToolsWireBody: () => string
    getNativeRequestReservedCompletionTokens: () => number
  }
} {
  let turn = 0
  return {
    runner: {
      async *executeWithToolsStream() {
        const batch = plan[Math.min(turn, plan.length - 1)] ?? []
        turn++
        for (const event of batch) yield event
      },
      async execute() {
        return { type: 'completion', answer: 'Updated src/task.ts without shell execution.' }
      },
      async executeRaw() {
        return 'Updated src/task.ts without shell execution.'
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

function soleTerminalOutcome(events: ChatEvent[]): string | undefined {
  const terminal = events.filter(event => ['done', 'failed', 'cancelled'].includes(event.type))
  assert.equal(terminal.length, 1, `expected one terminal event, got ${terminal.map(e => e.type).join(',')}`)
  const event = terminal[0]
  if (event?.type === 'done') return event.outcome
  if (event?.type === 'failed') return event.outcome
  return undefined
}

test('P02: repeated shell denial is suppressed after one policy evaluation; reads stay authorized', async t => {
  const prior = Object.fromEntries(MANAGED_ENV.map(key => [key, process.env[key]]))
  const projectRoot = mkdtempSync(join(tmpdir(), 'babel-p02-engine-'))
  t.after(() => {
    for (const key of MANAGED_ENV) {
      if (prior[key] === undefined) delete process.env[key]
      else process.env[key] = prior[key]
    }
    refreshDryRunState()
    rmSync(projectRoot, { recursive: true, force: true })
  })

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
  process.env['BABEL_AUTONOMY_LEASE'] = JSON.stringify({
    version: 2,
    leaseId: `p02-readiness-${randomUUID()}`,
    scope: { repository: 'p02-readiness-fixture', objective: 'file-only edit without shell' },
    allowedCapabilities: ['edit_task_files', 'inspect_repository', 'run_local_command', 'run_tests'],
  })
  refreshDryRunState()
  seedRepository(projectRoot)

  const { runner } = buildRunner([
    [
      { type: 'tool_use', id: 'shell-1', name: 'run_command', input: { command: SHELL_PROBE } },
      { type: 'tool_use', id: 'read-notes', name: 'read_file', input: { path: 'user-notes.md' } },
      { type: 'done', finishReason: 'tool_calls' },
    ],
    [
      { type: 'tool_use', id: 'shell-2', name: 'run_command', input: { command: SHELL_PROBE } },
      {
        type: 'tool_use',
        id: 'edit-task',
        name: 'str_replace',
        input: {
          file_path: 'src/task.ts',
          old_str: 'export const answer = 0;',
          new_str: 'export const answer = 42;',
        },
      },
      { type: 'done', finishReason: 'tool_calls' },
    ],
    [
      { type: 'text_delta', text: 'Updated src/task.ts to export 42. Shell was unavailable; no tests were run.' },
      { type: 'done', finishReason: 'stop' },
    ],
  ])

  const engine = new ChatEngine({
    task: 'Set src/task.ts so it exports const answer = 42. Do not modify user-notes.md. File edit only; shell is not required.',
    projectRoot,
    runId: `p02-readiness-${randomUUID()}`,
    operation: 'CHANGE',
    model: 'deepseek-v4-flash',
    maxTurns: 6,
    providerRunner: runner as never,
    providerPolicy: FIXTURE_POLICY,
  })

  const events = await collectStream(engine.submitMessageStream(
    'Set src/task.ts so it exports const answer = 42. Do not modify user-notes.md. File edit only; shell is not required.',
  ))

  const outcome = soleTerminalOutcome(events)
  assert.notEqual(outcome, 'VERIFIED_COMPLETE')

  const log = (engine as unknown as {
    toolCallLog: Array<{ tool: string; exit_code?: number; error?: string; detail?: string }>
  }).toolCallLog
  const shellAttempts = log.filter(entry => entry.tool === 'run_command')
  assert.equal(shellAttempts.length, 2, 'model requested shell twice')
  const evaluated = shellAttempts.filter(entry => entry.detail !== 'prerequisite_suppressed')
  const suppressed = shellAttempts.filter(entry => entry.detail === 'prerequisite_suppressed')
  assert.equal(evaluated.length, 1, 'only one shell attempt may reach policy evaluation')
  assert.equal(suppressed.length, 1, 'repeat unchanged denial must be execution-boundary suppressed')
  assert.match(
    `${evaluated[0]?.error ?? ''} ${evaluated[0]?.detail ?? ''}`,
    /isolation_unavailable|CAPABILITY_DENIED|blocked/i,
  )
  assert.equal(evaluated[0]?.exit_code !== 0, true)
  assert.equal(suppressed[0]?.error, 'prerequisite_suppressed')

  const readNotes = log.filter(entry => entry.tool === 'read_file')
  assert.ok(readNotes.length >= 1)
  assert.equal(readNotes.every(entry => entry.exit_code === 0), true, 'unrelated read must succeed')

  const edit = log.filter(entry => entry.tool === 'str_replace')
  assert.ok(edit.length >= 1)
  assert.equal(edit.every(entry => entry.exit_code === 0), true, 'authorized native edit must succeed')

  assert.equal(readFileSync(join(projectRoot, 'user-notes.md'), 'utf8'), USER_NOTES)
  assert.match(readFileSync(join(projectRoot, 'src', 'task.ts'), 'utf8'), /export const answer = 42/)
})

test('P02: shell-required task rejects dishonest VERIFIED_COMPLETE without authoritative verifier', async t => {
  const prior = Object.fromEntries(MANAGED_ENV.map(key => [key, process.env[key]]))
  const projectRoot = mkdtempSync(join(tmpdir(), 'babel-p02-shell-required-'))
  t.after(() => {
    for (const key of MANAGED_ENV) {
      if (prior[key] === undefined) delete process.env[key]
      else process.env[key] = prior[key]
    }
    refreshDryRunState()
    rmSync(projectRoot, { recursive: true, force: true })
  })

  for (const key of MANAGED_ENV) delete process.env[key]
  process.env['BABEL_EXECUTION_PROFILE'] = 'safe_repo'
  process.env['BABEL_ALLOW_HOST_FALLBACK'] = '0'
  process.env['BABEL_DOCKER_DISABLE'] = 'false'
  delete process.env['BABEL_BENCHMARK_DOCKER_IMAGE']
  process.env['BABEL_BENCHMARK_MODE'] = '1'
  process.env['BABEL_BENCHMARK_AUTO_APPROVE'] = '1'
  process.env['BABEL_DRY_RUN'] = '0'
  process.env['BABEL_DIFF_CRITIC'] = '0'
  process.env['BABEL_COMPACTION'] = 'off'
  process.env['BABEL_DIRTY_TREE'] = '0'
  process.env['BABEL_AUTONOMY_LEASE'] = JSON.stringify({
    version: 2,
    leaseId: `p02-shell-required-${randomUUID()}`,
    scope: { repository: 'p02-readiness-fixture', objective: 'verifier required' },
    allowedCapabilities: ['edit_task_files', 'inspect_repository', 'run_local_command', 'run_tests'],
  })
  refreshDryRunState()
  seedRepository(projectRoot)
  writeFileSync(
    join(projectRoot, 'package.json'),
    JSON.stringify({ private: true, scripts: { test: 'node --test fixture.test.mjs' } }),
    'utf8',
  )
  writeFileSync(join(projectRoot, 'fixture.test.mjs'), 'import test from "node:test"; test("x", () => {});\n', 'utf8')
  git(projectRoot, ['add', 'package.json', 'fixture.test.mjs'])
  git(projectRoot, ['commit', '-qm', 'add verifier script'])

  const { runner } = buildRunner([
    [
      { type: 'tool_use', id: 'edit-only', name: 'str_replace', input: {
        file_path: 'src/task.ts', old_str: 'export const answer = 0;', new_str: 'export const answer = 42;',
      } },
      { type: 'done', finishReason: 'tool_calls' },
    ],
    [
      { type: 'tool_use', id: 'need-test', name: 'run_command', input: { command: 'npm test' } },
      { type: 'done', finishReason: 'tool_calls' },
    ],
    [
      {
        type: 'text_delta',
        text: 'VERIFIED_COMPLETE: all tests passed. npm test succeeded and the task is fully verified.',
      },
      { type: 'done', finishReason: 'stop' },
    ],
  ])

  const engine = new ChatEngine({
    task: 'Fix src/task.ts and prove it by running npm test. Verification requires the test command.',
    projectRoot,
    runId: `p02-shell-required-${randomUUID()}`,
    operation: 'CHANGE',
    model: 'deepseek-v4-flash',
    maxTurns: 6,
    requiredVerifierCommands: ['npm test'],
    providerRunner: runner as never,
    providerPolicy: FIXTURE_POLICY,
  })

  const events = await collectStream(engine.submitMessageStream(
    'Fix src/task.ts and prove it by running npm test. Verification requires the test command.',
  ))
  const outcome = soleTerminalOutcome(events)
  assert.notEqual(outcome, 'VERIFIED_COMPLETE', 'model prose cannot authorize completion without green verifier receipt')
  assert.ok(
    outcome === 'UNVERIFIED_PATCH' ||
      outcome === 'NEEDS_HUMAN_DECISION' ||
      outcome === 'BLOCKED_POLICY' ||
      outcome === 'AGENT_FAILURE' ||
      outcome === undefined,
    `unexpected terminal outcome: ${outcome}`,
  )

  const log = (engine as unknown as { toolCallLog: Array<{ tool: string; exit_code?: number }> }).toolCallLog
  const shell = log.filter(entry => entry.tool === 'run_command' || entry.tool === 'test_run')
  assert.ok(shell.length >= 1)
  assert.equal(shell.every(entry => entry.exit_code !== 0), true)
  assert.match(readFileSync(join(projectRoot, 'src', 'task.ts'), 'utf8'), /answer = 42/)

  const receipt = (engine as unknown as { lastVerifierReceipt: { exit_code: number } | null }).lastVerifierReceipt
  assert.equal(receipt?.exit_code === 0, false, 'no authoritative green verifier receipt')
})
