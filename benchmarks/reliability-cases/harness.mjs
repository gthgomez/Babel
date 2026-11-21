/**
 * WP-00 independent reliability-case harness.
 *
 * Each case runs the real ChatEngine with a deterministic scripted provider in
 * a disposable project tree, then grades the final bytes with an oracle that
 * lives here - outside the tree the candidate can edit. The oracle never reads
 * the candidate's own tests, and a generic/unknown check is never promoted into
 * a behavioral pass.
 *
 * This is a protocol and logic control surface, not model-performance evidence.
 * It creates no provider client, reads no credential and makes no network
 * request.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ChatEngine } from '../../babel-cli/src/agent/chatEngine.ts'
import { chatSessionDir } from '../../babel-cli/src/cli/runsLayout.ts'
import { inspectSessionEventLogFromDir } from '../../babel-cli/src/agent/sessionEvents.ts'

const MODEL = 'deepseek-v4-flash'
const NATIVE_RESERVED = 4096

const ENV_KEYS = [
  'BABEL_RUNS_DIR',
  'BABEL_BENCHMARK_AUTO_APPROVE',
  'BABEL_BENCHMARK_MODE',
  'BABEL_AUTONOMY_LEASE',
  'BABEL_EXECUTION_PROFILE',
  'BABEL_ALLOW_HOST_FALLBACK',
  'BABEL_LIVE',
]

const SUCCESS_OUTCOMES = new Set(['VERIFIED_COMPLETE', 'NO_CHANGE_REQUIRED'])
const CERTIFYING_OUTCOMES = new Set(['VERIFIED_COMPLETE'])

async function withCaseEnvironmentAsync(runsRoot, fn) {
  const backup = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]))
  // A nested `node --test` (the fixture's own npm test) must observe its real
  // exit status. The outer test runner sets NODE_TEST_CONTEXT for its child,
  // and an inherited value changes the nested runner's reporting.
  const nestedTestContext = process.env['NODE_TEST_CONTEXT']
  delete process.env['NODE_TEST_CONTEXT']
  process.env['BABEL_RUNS_DIR'] = runsRoot
  process.env['BABEL_BENCHMARK_AUTO_APPROVE'] = '1'
  process.env['BABEL_BENCHMARK_MODE'] = '1'
  process.env['BABEL_AUTONOMY_LEASE'] = JSON.stringify({
    version: 2,
    leaseId: 'reliability-case-lease',
    scope: { repository: 'reliability-case', objective: 'independent reliability grading' },
    allowedCapabilities: [
      'inspect_repository',
      'run_local_command',
      'run_tests',
      'edit_task_files',
      'run_arbitrary_code',
    ],
  })
  process.env['BABEL_EXECUTION_PROFILE'] = 'dev_local'
  process.env['BABEL_ALLOW_HOST_FALLBACK'] = '1'
  process.env['BABEL_LIVE'] = '1'
  try {
    return await fn()
  } finally {
    for (const key of ENV_KEYS) {
      const previous = backup[key]
      if (previous === undefined) delete process.env[key]
      else process.env[key] = previous
    }
    if (nestedTestContext === undefined) delete process.env['NODE_TEST_CONTEXT']
    else process.env['NODE_TEST_CONTEXT'] = nestedTestContext
  }
}

export function installScriptedRunner(engine, script) {
  let call = 0
  const runner = {
    calls: () => call,
    async *executeWithToolsStream() {
      const index = call
      call += 1
      const events = script[index] ?? [
        { type: 'text_delta', text: 'Concluding.' },
        { type: 'done', finishReason: 'stop' },
      ]
      for (const event of events) yield event
    },
    async execute() {
      return { type: 'completion', answer: 'scripted' }
    },
    async executeRaw() {
      return 'scripted'
    },
    getLastInvocationMetadata() {
      return null
    },
    buildNativeToolsWireBody(messages, tools) {
      return JSON.stringify({
        model: MODEL,
        stream: true,
        max_tokens: NATIVE_RESERVED,
        temperature: 0,
        tools,
        messages,
      })
    },
    getNativeRequestReservedCompletionTokens() {
      return NATIVE_RESERVED
    },
  }
  const host = engine
  host.deliberationRunner = runner
  host.synthesisRunner = runner
  host.shouldUseNativeTools = () => true
  return runner
}

export function initGitFixture(root) {
  for (const args of [
    ['init', '--quiet'],
    ['config', 'core.autocrlf', 'false'],
    ['config', 'user.email', 'fixture@example.test'],
    ['config', 'user.name', 'fixture'],
    ['add', '-A'],
    ['commit', '--quiet', '-m', 'fixture baseline'],
  ]) {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  }
}

export function writeTree(root, files) {
  for (const [relative, content] of Object.entries(files)) {
    const absolute = join(root, relative)
    mkdirSync(join(absolute, '..'), { recursive: true })
    writeFileSync(absolute, content)
  }
}

export function changedPaths(root) {
  const result = spawnSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
    cwd: root,
    encoding: 'utf8',
  })
  if (result.status !== 0) return null
  return result.stdout
    .split(/\r?\n/)
    .filter(line => line.trim().length > 0)
    .map(line => line.slice(3).trim())
    .sort()
}

/**
 * Run a held-out oracle in a fresh Node process against the candidate tree.
 * The oracle source is supplied by this harness, not by the fixture.
 */
export function runOracle(root, args, timeout = 30000) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', args], {
    cwd: root,
    encoding: 'utf8',
    timeout,
    env: (() => {
      const env = { ...process.env, NODE_OPTIONS: '' }
      delete env['NODE_TEST_CONTEXT']
      return env
    })(),
  })
  return {
    exit: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    timedOut: result.error?.code === 'ETIMEDOUT',
  }
}

function terminalFromEvents(events) {
  const terminal = events.at(-1)
  if (!terminal) return { status: 'failed', outcome: undefined, answer: '', toolCalls: [] }
  if (terminal.type === 'done') {
    return {
      status: terminal.status ?? 'completed',
      outcome: terminal.outcome,
      answer: terminal.answer ?? '',
      toolCalls: terminal.toolCalls ?? [],
    }
  }
  if (terminal.type === 'failed') {
    return {
      status: terminal.status ?? 'failed',
      outcome: terminal.outcome,
      answer: terminal.error ?? '',
      toolCalls: [],
    }
  }
  return { status: 'failed', outcome: undefined, answer: '', toolCalls: [] }
}

/** Drive one case: real engine, scripted provider, disposable fixture. */
export async function runCase(spec) {
  const parent = mkdtempSync(join(tmpdir(), `babel-reliability-${spec.id.slice(0, 12)}-`))
  const root = join(parent, 'workspace')
  const runsRoot = join(parent, 'runs')
  mkdirSync(root, { recursive: true })
  mkdirSync(runsRoot, { recursive: true })
  const events = []
  let graded
  let runError = null
  try {
    writeTree(root, spec.files)
    initGitFixture(root)
    const runId = `reliability-${spec.id}-${Math.random().toString(36).slice(2, 8)}`
    const result = await withCaseEnvironmentAsync(runsRoot, async () => {
      const engine = new ChatEngine({
        task: spec.task,
        projectRoot: root,
        runId,
        model: MODEL,
        maxTurns: spec.maxTurns ?? 10,
        ...(spec.lockedFiles ? { lockedFiles: spec.lockedFiles } : {}),
      })
      installScriptedRunner(engine, spec.script)
      for await (const event of engine.submitMessageStream(spec.task)) events.push(event)
      const terminal = terminalFromEvents(events)
      // Read the durable log before BABEL_RUNS_DIR is restored: the path
      // resolver reads the environment at call time.
      const loaded = inspectSessionEventLogFromDir(chatSessionDir(runId), runId)
      const sessionEvents = loaded.kind === 'valid' ? loaded.log.events : []
      const durableDecision = [...sessionEvents].reverse().find(event => event.kind === 'completion_decision')
      return { terminal, durableDecision, sessionEventCount: sessionEvents.length }
    })
    const terminal = result.terminal
    const durableDecision = result.durableDecision
    const mutated = changedPaths(root)
    const finalFiles = {}
    for (const relative of Object.keys(spec.files)) {
      try {
        finalFiles[relative] = readFileSync(join(root, relative), 'utf8')
      } catch {
        finalFiles[relative] = null
      }
    }
    const oracle = spec.oracle ? runOracle(root, spec.oracle.code) : null
    const docs = spec.docsOracle ? runOracle(root, spec.docsOracle.code) : null
    const oracleStatus = oracle === null
      ? { status: 'ungraded' }
      : oracle.timedOut
        ? { status: 'ungraded', detail: 'oracle timed out' }
        : { status: oracle.exit === 0 ? 'pass' : 'fail', exit: oracle.exit, stdout: oracle.stdout, stderr: oracle.stderr }
    const behavior = spec.gradeBehavior
      ? spec.gradeBehavior({ oracle: oracleStatus, docs, terminal, changedPaths: mutated, finalFiles })
      : oracleStatus
    graded = {
      id: spec.id,
      exercised: true,
      terminal,
      durable_outcome: durableDecision?.final_outcome,
      durable_allowed: durableDecision?.allowed,
      durable_reason: durableDecision?.reason,
      durable_session_events: result.sessionEventCount,
      durable_decision_present: Boolean(durableDecision),
      changed_paths: mutated,
      final_files: finalFiles,
      oracle: oracleStatus,
      docs: docs === null
        ? undefined
        : {
            status: docs.exit === 0 ? 'pass' : 'fail',
            exit: docs.exit,
            stdout: docs.stdout,
            stderr: docs.stderr,
          },
      behavior,
      invariant: spec.gradeInvariant
        ? spec.gradeInvariant({ oracle: oracleStatus, finalFiles, terminal, changedPaths: mutated })
        : { status: 'not_applicable' },
    }
  } catch (error) {
    runError = error instanceof Error ? error.message : String(error)
    graded = {
      id: spec.id,
      exercised: false,
      error: runError,
      terminal: { status: 'failed', outcome: undefined, answer: '' },
      changed_paths: null,
      final_files: {},
      oracle: null,
      behavior: { status: 'ungraded' },
      invariant: { status: 'ungraded' },
    }
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }

  const outcome = graded.terminal.outcome
  const allowed = graded.durable_allowed
  const falseSuccess = graded.exercised && (
    (CERTIFYING_OUTCOMES.has(outcome) && graded.behavior.status !== 'pass') ||
    (SUCCESS_OUTCOMES.has(outcome) && allowed !== false && graded.behavior.status !== 'pass') ||
    (graded.invariant.status === 'fail' && SUCCESS_OUTCOMES.has(outcome))
  )
  return {
    ...graded,
    success_class: SUCCESS_OUTCOMES.has(outcome) ? 'success' : 'non_success',
    false_success: Boolean(falseSuccess),
    run_error: runError,
  }
}
