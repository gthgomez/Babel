// License: Apache-2.0 — see LICENSE
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const tool = (id, name, input) => [
  { type: 'tool_use', id, name, input },
  { type: 'done', finishReason: 'tool_calls' },
]
const answer = (text) => [
  { type: 'text_delta', text }, { type: 'done', finishReason: 'stop' },
]

/**
 * Qualify installed ChatEngine mechanics with synthetic provider events and real tools.
 * The only execution lease is explicitly dev_local, inside a disposable fixture.
 * Actual local tests temporarily disable dry-run; no Docker fallback is implicit.
 * The caller must isolate user directories and block HTTP in this child process.
 * @param {string} packageRoot Installed package directory containing dist/.
 * @param {string} projectRoot Disposable parent directory for the fixture.
 * @returns {Promise<object>} Compact observed evidence; assertions fail closed.
 */
export async function runInstalledMechanics(packageRoot, projectRoot) {
  // macOS /var aliases /private/var; the lease must bind the same canonical
  // repository identity as runtime admission and the sandbox.
  const fixture = realpathSync(mkdtempSync(join(projectRoot, 'mechanics-')))
  const settings = {
    BABEL_RUNS_DIR: join(fixture, 'runs'),
    BABEL_BENCHMARK_AUTO_APPROVE: '1', BABEL_BENCHMARK_MODE: '1',
    BABEL_EXECUTION_PROFILE: 'dev_local', BABEL_ALLOW_HOST_FALLBACK: '1',
    BABEL_DRY_RUN: '0', BABEL_DRY_RUN_SOURCE: 'session', BABEL_COMPACTION: '0',
    BABEL_READ_ONLY: 'false',
    BABEL_AUTONOMY_LEASE: JSON.stringify({
      version: 2, leaseId: 'installed-mechanics-fixture',
      scope: { repository: fixture, objective: 'synthetic installed mechanics qualification' },
      allowedCapabilities: ['inspect_repository', 'search_repository', 'run_arbitrary_code',
        'run_local_command', 'run_tests', 'edit_task_files'],
    }),
  }
  const previous = Object.fromEntries(Object.keys(settings).map((key) => [key, process.env[key]]))
  const engines = []
  try {
    Object.assign(process.env, settings)
    const load = (path) => import(pathToFileURL(join(packageRoot, 'dist', path)).href)
    const { ChatEngine } = await load('agent/chatEngine.js')
    const { chatSessionDir } = await load('cli/runsLayout.js')
    const { inspectSessionEventLogFromDir } = await load('agent/sessionEvents.js')
    const { loadThreadEventLogFromDir } = await load('agent/threadEventLog.js')
    const { persistTranscriptToDisk } = await load('agent/chatEngineObservability.js')
    const { resumeChatSession } = await load('interactive/chatSessionResume.js')
    const buggy = 'export const add = (a, b) => a - b\n'
    const fixed = 'export const add = (a, b) => a + b\n'
    writeFileSync(join(fixture, 'parser.mjs'), buggy)
    writeFileSync(join(fixture, 'verify.mjs'),
      "import assert from 'node:assert/strict'\nimport { add } from './parser.mjs'\n" +
      'for (const [a,b] of [[1,2],[7,4],[-2,5],[0,9]]) assert.equal(add(a,b),a+b)\n')
    writeFileSync(join(fixture, 'package.json'), JSON.stringify({
      name: 'installed-mechanics-fixture', private: true, scripts: { test: 'node verify.mjs' },
    }))
    let sequence = 0
    const create = (task) => {
      const engine = new ChatEngine({ task, projectRoot: fixture,
        runId: `installed-mechanics-${++sequence}`, model: 'deepseek-v4-flash', maxTurns: 8 })
      engines.push(engine)
      return engine
    }
    // Trusted S07 provider seam only: never inject tool results, verifier receipts,
    // completion decisions or session owners. Exhausted scripts are errors.
    const drive = async (engine, task, script, onYield) => {
      let calls = 0
      const runner = {
        async *executeWithToolsStream(messages) {
          const index = calls++
          assert.ok(index < script.length, `unexpected provider round ${index}: ${JSON.stringify(messages?.slice(-2))}`)
          for (const event of script[index]) {
            yield event
            onYield?.(event, index)
          }
        },
        async execute() { throw new Error('unexpected non-stream provider execution') },
        async executeRaw() { throw new Error('unexpected raw provider execution') },
        getLastInvocationMetadata() { return null },
      }
      engine.deliberationRunner = runner
      engine.synthesisRunner = runner
      engine.shouldUseNativeTools = () => true
      const events = []
      for await (const event of engine.submitMessageStream(task)) events.push(event)
      const terminal = events.at(-1)
      assert.ok(['done', 'failed', 'cancelled'].includes(terminal?.type))
      const sessionId = engine.getParityRuntime().eventLog.thread_id
      const inspected = inspectSessionEventLogFromDir(chatSessionDir(sessionId), sessionId)
      assert.equal(inspected.kind, 'valid', 'real durable session evidence is readable')
      const decisions = inspected.log.events.filter((event) => event.kind === 'completion_decision')
      await new Promise((resolve) => setImmediate(resolve))
      const ended = loadThreadEventLogFromDir(chatSessionDir(sessionId)).events
        .filter((event) => event.kind === 'turn_ended').at(-1)
      assert.equal(ended?.status, terminal.status ?? terminal.type)
      if (terminal.outcome) {
        assert.equal(ended?.outcome, terminal.outcome)
        if (terminal.type !== 'cancelled') assert.equal(decisions.at(-1)?.final_outcome, terminal.outcome)
      }
      return { terminal, calls, events, durable: inspected.log.events }
    }
    const read = (id) => tool(id, 'read_file', { path: 'parser.mjs' })
    const replace = (id, old, next) => tool(id, 'str_replace', {
      file_path: 'parser.mjs', old_str: old, new_str: next,
    })
    const verify = (id) => tool(id, 'run_command', { command: 'npm test' })
    const inspectTask = 'Review the parser and explain its defect. Do not modify files.'
    const inspection = create(inspectTask)
    const inspected = await drive(inspection, inspectTask, [read('inspect'), answer('The parser subtracts instead of adding.')])
    assert.equal(readFileSync(join(fixture, 'parser.mjs'), 'utf8'), buggy)
    assert.equal(inspection.getWriteCount(), 0)
    assert.equal(inspected.terminal.status, 'completed')
    assert.equal(inspected.terminal.outcome, 'NO_CHANGE_REQUIRED')

    // Runtime read-only policy, rather than scripted provider obedience, owns denial.
    process.env.BABEL_READ_ONLY = 'true'
    const deniedEngine = create(inspectTask)
    const denied = await drive(deniedEngine, inspectTask, [read('deny-read'),
      replace('deny-write', 'a - b', 'a + b'), answer('The requested edit was denied; the file remains unchanged.')])
    process.env.BABEL_READ_ONLY = 'false'
    assert.equal(readFileSync(join(fixture, 'parser.mjs'), 'utf8'), buggy)
    assert.equal(deniedEngine.getWriteCount(), 0)
    assert.notEqual(denied.terminal.outcome, 'VERIFIED_COMPLETE')
    assert.ok(denied.events.some((event) => event.type === 'tool_failed' &&
      event.tool === 'str_replace' && /denied|blocked|read.only|not authorized/i.test(event.error ?? event.detail ?? '')),
      'denial must be visible, not inferred solely from unchanged bytes')

    const fixTask = 'Investigate why parser_test fails and fix it.'
    const fixing = create(fixTask)
    const repaired = await drive(fixing, fixTask, [read('fix-read'), verify('red'),
      replace('fix-write', 'a - b', 'a + b'), verify('green'), answer('Fixed the parser; npm test passed.')])
    assert.equal(readFileSync(join(fixture, 'parser.mjs'), 'utf8'), fixed)
    const verifiers = fixing.getParityRuntime().eventLog.events.filter((event) =>
      event.kind === 'tool_result' && event.tool_name === 'run_command')
    assert.deepEqual(verifiers.map((call) => call.exit_code), [1, 0], `real red then green verifier exits: ${JSON.stringify(verifiers)}`)
    assert.ok(fixing.getWriteCount() > 0)
    assert.equal(fixing.lastVerifierReceipt?.exit_code, 0)
    assert.equal(repaired.terminal.status, 'completed', JSON.stringify({ terminal: repaired.terminal,
      events: repaired.events.filter((event) => !['answer_chunk', 'tool_start', 'tool_complete', 'tool_failed', 'failed'].includes(event.type)),
      receipt: fixing.lastVerifierReceipt }))
    assert.equal(repaired.terminal.outcome, 'VERIFIED_COMPLETE')

    const cancelledEngine = create(fixTask)
    const cancelled = await drive(cancelledEngine, fixTask, [read('cancel-read'),
      replace('cancel-write', 'a + b', 'a - b'), verify('cancel-red'), read('cancel-late')],
    (event, index) => { if (index === 3 && event.type === 'tool_use') cancelledEngine.cancel() })
    assert.equal(cancelled.terminal.type, 'cancelled')
    assert.equal(cancelledEngine.lastVerifierReceipt?.exit_code, 1)
    assert.ok(cancelledEngine.getWriteCount() > 0)
    const freshTask = 'Inventory the parser file. Do not edit files.'
    const fresh = await drive(cancelledEngine, freshTask, [read('fresh-read'), answer('Parser inventory complete.')])
    assert.equal(fresh.terminal.status, 'completed')
    assert.equal(fresh.terminal.outcome, 'NO_CHANGE_REQUIRED')
    assert.equal(cancelledEngine.getWriteCount(), 0)
    assert.equal(cancelledEngine.lastVerifierReceipt, null)
    assert.equal(cancelledEngine.getTurnRuntimeSnapshot().continuedTask, false)

    // Close the producer and resume through the ordinary UI seam. Historical
    // terminal evidence stays historical; a new read-only task gains no verifier.
    const sessionId = cancelledEngine.getParityRuntime().eventLog.thread_id
    await persistTranscriptToDisk(chatSessionDir(sessionId), [...cancelledEngine.getConversation()])
    cancelledEngine.closeAdmissionStore()
    const ctx = { state: { model: 'deepseek-v4-flash' }, turns: [], turnCounter: 0,
      chatEngine: undefined, saveSessionState: () => undefined,
      resolveCurrentTarget: () => ({ targetRoot: fixture, workspaceRoot: null,
        project: null, source: 'cwd', cwd: fixture }) }
    const resumed = await resumeChatSession(ctx, sessionId)
    assert.equal(resumed.ok, true, resumed.message)
    assert.equal(resumed.degraded, undefined, 'physical repository identity survives resume')
    assert.ok(ctx.chatEngine)
    engines.push(ctx.chatEngine)
    const resumedTask = 'Explain the parser file. Do not modify files.'
    const afterResume = await drive(ctx.chatEngine, resumedTask, [read('resume-read'), answer('The parser still subtracts.')])
    assert.equal(afterResume.terminal.status, 'completed')
    assert.equal(afterResume.terminal.outcome, 'NO_CHANGE_REQUIRED')
    assert.equal(ctx.chatEngine.lastVerifierReceipt, null)
    assert.equal(readFileSync(join(fixture, 'parser.mjs'), 'utf8'), buggy)
    const evidence = (result) => ({ status: result.terminal.status ?? result.terminal.type,
      outcome: result.terminal.outcome ?? null, providerCalls: result.calls,
      durableEvents: result.durable.length })
    return { execution: 'explicit dev_local fixture lease; actual local npm test; HTTP blocked by caller',
      inspect: evidence(inspected), denied: evidence(denied), repair: evidence(repaired),
      verifierExitCodes: verifiers.map((call) => call.exit_code), cancel: evidence(cancelled),
      freshTask: evidence(fresh), resume: evidence(afterResume) }
  } finally {
    for (const engine of engines) engine.closeAdmissionStore()
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(fixture, { recursive: true, force: true })
  }
}
