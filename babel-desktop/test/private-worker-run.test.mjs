import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { PrivateWorkerRun, approvalToDesktop, buildWorkerEnvironment, workerEventToDesktop } from '../native/private-worker-run.mjs'

const entry = fileURLToPath(new URL('./fixtures/fake-private-worker.mjs', import.meta.url))

/**
 * Remove a temp fixture directory. On Windows a just-killed child can hold its
 * cwd open briefly, so retry with a real budget rather than racing the OS.
 */
function removeFixtureDir(root) {
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 40, retryDelay: 250 })
  } catch (error) {
    if (process.platform !== 'win32' || error?.code !== 'EBUSY') throw error
    // A leaked handle on the runner is not a product failure; the OS will
    // reclaim the temp directory. Do not fail the assertion under test.
  }
}

function harness(root, extraEnv = {}) {
  const packets = []
  const runner = new PrivateWorkerRun({
    executable: process.execPath,
    entry,
    projectRoot: root,
    provider: 'openrouter',
    providerModelId: 'fixture/provider-model',
    model: 'fixture-model',
    env: { FAKE_WORKER_MARKER: root, OPENROUTER_API_KEY: 'synthetic-worker-canary', ...extraEnv },
    inheritEnv: false,
  })
  const start = request => new Promise((resolve, reject) => {
    runner.whenIdle(() => resolve())
    runner.start(request, packet => packets.push(packet)).catch(reject)
  })
  return { runner, packets, start }
}

const take = async (packets, predicate, timeoutMs = 15_000) => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const index = packets.findIndex(predicate)
    if (index >= 0) return packets.splice(index, 1)[0]
    if (Date.now() >= deadline) throw new Error('Timed out waiting for a Desktop worker packet')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

test('resident worker reuses one process and one thread across sequential turns', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-desktop-worker-'))
  const { runner, packets, start } = harness(root)
  try {
    void start({ runId: 'run-1', task: 'first turn', mode: 'chat', executionScope: { kind: 'project', projectRoot: root } })
    const first = await take(packets, packet => packet.event?.type === 'run_complete')
    assert.equal(first.runId, 'run-1')
    assert.match(first.event.result.session_id, /^chat-fixture-1$/)
    assert.equal(first.event.result.terminal_outcome, 'NO_CHANGE_REQUIRED')
    await take(packets, packet => packet.kind === 'exit')
    await new Promise(resolve => runner.whenIdle(resolve))

    void start({ runId: 'run-2', task: 'second turn', mode: 'chat', sessionId: 'chat-fixture-1', executionScope: { kind: 'project', projectRoot: root } })
    const second = await take(packets, packet => packet.event?.type === 'run_complete')
    assert.equal(second.event.result.session_id, 'chat-fixture-1')
    await take(packets, packet => packet.kind === 'exit')

    const spawns = readFileSync(join(root, 'spawns.txt'), 'utf8').trim().split('\n')
    assert.equal(spawns.length, 1, 'two turns must reuse the resident worker process')
  } finally {
    await runner.shutdown()
    removeFixtureDir(root)
  }
})

test('a new conversation without a session id creates a new thread', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-desktop-worker-new-'))
  const { runner, packets, start } = harness(root)
  try {
    void start({ runId: 'a1', task: 'one', mode: 'chat', executionScope: { kind: 'project', projectRoot: root } })
    const first = await take(packets, packet => packet.event?.type === 'run_complete')
    await take(packets, packet => packet.kind === 'exit')
    void start({ runId: 'a2', task: 'two', mode: 'chat', executionScope: { kind: 'project', projectRoot: root } })
    const second = await take(packets, packet => packet.event?.type === 'run_complete')
    assert.notEqual(first.event.result.session_id, second.event.result.session_id)
    assert.equal(readFileSync(join(root, 'threads.txt'), 'utf8').trim().split('\n').length, 2)
  } finally {
    await runner.shutdown()
    removeFixtureDir(root)
  }
})

test('approvals surface through the Desktop binding and deny stays deny', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-desktop-worker-approval-'))
  const { runner, packets, start } = harness(root)
  try {
    void start({ runId: 'run-approval', task: 'approval', mode: 'chat', executionScope: { kind: 'project', projectRoot: root } })
    const approval = await take(packets, packet => packet.event?.type === 'approval.required')
    assert.equal(approval.event.item.approval.run_id, 'run-approval')
    assert.equal(approval.event.item.approval.operation_digest, 'a'.repeat(64))
    assert.equal(runner.awaitingApproval, true)
    const accepted = runner.reply({ runId: 'run-approval', decision: 'deny', approval: approval.event.item.approval })
    assert.equal(accepted, true)
    const terminal = await take(packets, packet => packet.event?.type === 'run_error')
    assert.match(terminal.event.error, /denied/i)
    await take(packets, packet => packet.kind === 'exit')
  } finally {
    await runner.shutdown()
    removeFixtureDir(root)
  }
})

test('cancellation is sent to the worker and its terminal is preserved', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-desktop-worker-cancel-'))
  const { runner, packets, start } = harness(root)
  try {
    void start({ runId: 'run-cancel', task: 'cancel', mode: 'chat', executionScope: { kind: 'project', projectRoot: root } })
    await new Promise(resolve => setTimeout(resolve, 500))
    runner.cancel()
    const terminal = await take(packets, packet => packet.event?.type === 'cancelled')
    assert.equal(terminal.runId, 'run-cancel')
    await take(packets, packet => packet.kind === 'exit')
  } finally {
    await runner.shutdown()
    removeFixtureDir(root)
  }
})

test('a failed worker handshake tears down its owned process instead of leaking it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-desktop-worker-fail-'))
  const { runner, packets, start } = harness(root, { FAKE_WORKER_REJECT_CREDENTIALS: '1' })
  try {
    void start({ runId: 'run-fail', task: 'fail', mode: 'chat', executionScope: { kind: 'project', projectRoot: root } })
    const failure = await take(packets, packet => packet.event?.type === 'run_error')
    assert.match(failure.event.error, /credential rejection/i)
    await take(packets, packet => packet.kind === 'exit')
    const spawned = readFileSync(join(root, 'spawns.txt'), 'utf8').trim().split('\n')
    assert.equal(spawned.length, 1)
    const pid = Number(spawned[0])
    assert.ok(Number.isSafeInteger(pid) && pid > 0)
    const deadline = Date.now() + 10_000
    let dead = false
    while (Date.now() < deadline && !dead) {
      try { process.kill(pid, 0) } catch { dead = true; break }
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    assert.equal(dead, true, 'the rejected worker process must exit')
  } finally {
    await runner.shutdown()
    // A killed child can hold its cwd briefly on Windows after the PID is gone.
    removeFixtureDir(root)
  }
})

test('worker environment strips ambient credentials and binds only the selected provider key', () => {
  const { env, credential } = buildWorkerEnvironment({
    OPENROUTER_API_KEY: 'synthetic-selected', ANTHROPIC_API_KEY: 'synthetic-other',
    BABEL_ALLOW_HOST_FALLBACK: '1', BABEL_PROJECT_CREDENTIALS_DIR: 'C:/project', PATH: 'x',
  }, { provider: 'openrouter', projectRoot: process.cwd(), model: 'fixture-model' })
  assert.equal(env.OPENROUTER_API_KEY, undefined)
  assert.equal(env.ANTHROPIC_API_KEY, undefined)
  assert.equal(env.BABEL_ALLOW_HOST_FALLBACK, undefined)
  assert.equal(env.BABEL_PROJECT_CREDENTIALS_DIR, undefined)
  assert.equal(env.BABEL_EXECUTION_PROFILE, 'host_native')
  assert.equal(env.BABEL_DESKTOP_MODEL_ROUTE, 'fixture-model')
  assert.deepEqual(credential, { OPENROUTER_API_KEY: 'synthetic-selected' })
})

test('event and approval projections stay in the renderer contract', () => {
  const delta = workerEventToDesktop({ type: 'answer_chunk', text: 'hello' })
  assert.deepEqual(delta, { type: 'assistant_chunk', chunk: 'hello' })
  const tool = workerEventToDesktop({ type: 'tool_failed', toolCallId: 't', tool: 'run_command', target: 'x', exitCode: 2 })
  assert.equal(tool.type, 'tool.failed')
  assert.equal(tool.item.exit_code, 2)
  const done = workerEventToDesktop({ type: 'done', answer: 'ok', outcome: 'VERIFIED_COMPLETE' }, { threadId: 'chat-1', unverified: true })
  assert.equal(done.type, 'run_complete')
  assert.equal(done.result.session_id, 'chat-1')
  assert.equal(done.result.verification.status, 'unverified')
  assert.equal(approvalToDesktop({ approval_id: 'bad' }, 'run'), null)
})
