// W11 regression coverage for the merged Desktop second-turn repair (#520).
//
// These cases exercise the resident worker lifecycle that the audit pinned:
// coalesced admission/terminal frames including a stale prior-turn event,
// owned-process restart, and cancellation before turn admission. They use a
// W11-owned fixture so the shared worker fixture and its open draft stay
// untouched.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { PrivateWorkerRun } from '../native/private-worker-run.mjs'

const entry = fileURLToPath(new URL('./fixtures/fake-worker-turn-lifecycle.mjs', import.meta.url))

function removeFixtureDir(root) {
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 40, retryDelay: 250 })
  } catch (error) {
    if (process.platform !== 'win32' || error?.code !== 'EBUSY') throw error
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
    env: { W11_WORKER_MARKER: root, ...extraEnv },
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
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for a Desktop worker packet; saw ${JSON.stringify(packets.map(packet => packet.kind ?? packet.event?.type ?? 'unknown'))}`)
    }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

const pidAlive = pid => {
  try { process.kill(pid, 0); return true } catch { return false }
}

async function waitForDeath(pid, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return true
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  return !pidAlive(pid)
}

test('coalesced second turn ignores a stale prior-turn terminal and keeps its own completion', { timeout: 30_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-w11-worker-coalesced-'))
  const { runner, packets, start } = harness(root, { W11_TURN2_COALESCE_STALE: '1' })
  try {
    void start({ runId: 'run-1', task: 'first turn', mode: 'chat', executionScope: { kind: 'project', projectRoot: root } })
    const first = await take(packets, packet => packet.runId === 'run-1' && packet.event?.type === 'run_complete', 5_000)
    assert.equal(first.event.result.answer.answer, 'answer for first turn')
    await take(packets, packet => packet.runId === 'run-1' && packet.kind === 'exit', 5_000)
    await new Promise(resolve => runner.whenIdle(resolve))

    void start({ runId: 'run-2', task: 'second turn', mode: 'chat', sessionId: first.event.result.session_id, executionScope: { kind: 'project', projectRoot: root } })
    const second = await take(packets, packet => packet.runId === 'run-2' && packet.event?.type === 'run_complete', 5_000)
    assert.equal(second.event.result.session_id, first.event.result.session_id)
    assert.equal(second.event.result.answer.answer, 'second answer', 'the stale prior-turn terminal must not answer this turn')
    await take(packets, packet => packet.runId === 'run-2' && packet.kind === 'exit', 5_000)
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(packets.some(packet => packet.runId === 'run-2' && packet.event?.type === 'run_complete'), false, 'one completion per turn')
    assert.equal(packets.some(packet => JSON.stringify(packet).includes('stale prior turn')), false)
    assert.equal(readFileSync(join(root, 'spawns.txt'), 'utf8').trim().split('\n').length, 1, 'the resident worker survives both turns')
  } finally {
    await runner.shutdown()
    removeFixtureDir(root)
  }
})

test('owned worker shutdown settles its process and a later turn starts a new resident worker', { timeout: 30_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-w11-worker-restart-'))
  const { runner, packets, start } = harness(root)
  try {
    void start({ runId: 'run-1', task: 'first turn', mode: 'chat', executionScope: { kind: 'project', projectRoot: root } })
    await take(packets, packet => packet.runId === 'run-1' && packet.event?.type === 'run_complete', 5_000)
    await take(packets, packet => packet.runId === 'run-1' && packet.kind === 'exit', 5_000)
    await new Promise(resolve => runner.whenIdle(resolve))
    const firstPid = Number(readFileSync(join(root, 'spawns.txt'), 'utf8').trim().split('\n')[0])
    assert.ok(Number.isSafeInteger(firstPid) && firstPid > 0)

    const shutdown = await runner.shutdown()
    assert.equal(shutdown.forced, false)
    assert.equal(runner.alive, false)
    assert.equal(await waitForDeath(firstPid), true, 'the owned worker process must settle on shutdown')

    void start({ runId: 'run-2', task: 'second turn', mode: 'chat', executionScope: { kind: 'project', projectRoot: root } })
    const second = await take(packets, packet => packet.runId === 'run-2' && packet.event?.type === 'run_complete', 5_000)
    assert.equal(second.event.result.answer.answer, 'answer for second turn')
    assert.match(second.event.result.session_id, /^lifecycle-thread-\d+$/)
    await take(packets, packet => packet.runId === 'run-2' && packet.kind === 'exit', 5_000)
    const spawns = readFileSync(join(root, 'spawns.txt'), 'utf8').trim().split('\n')
    assert.equal(spawns.length, 2, 'the restart owns exactly one replacement worker')
    assert.equal(readFileSync(join(root, 'exits.txt'), 'utf8').trim().split('\n').length >= 1, true, 'the retired worker recorded its exit')
  } finally {
    await runner.shutdown()
    removeFixtureDir(root)
  }
})

test('cancellation requested before admission is sent for that turn and preserves a cancelled terminal', { timeout: 30_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-w11-worker-cancel-admission-'))
  const { runner, packets, start } = harness(root, { W11_ADMISSION_DELAY: '1' })
  try {
    void start({ runId: 'run-cancel', task: 'cancel-during-admission', mode: 'chat', executionScope: { kind: 'project', projectRoot: root } })
    await new Promise(resolve => setTimeout(resolve, 50))
    runner.cancel()
    const terminal = await take(packets, packet => packet.runId === 'run-cancel' && packet.event?.type === 'cancelled', 5_000)
    assert.equal(terminal.runId, 'run-cancel')
    await take(packets, packet => packet.runId === 'run-cancel' && packet.kind === 'exit', 5_000)
    assert.equal(packets.some(packet => packet.event?.type === 'run_complete'), false, 'a cancelled turn cannot also complete')
  } finally {
    await runner.shutdown()
    removeFixtureDir(root)
  }
})
