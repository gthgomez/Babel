import assert from 'node:assert/strict'
import { setImmediate as nextTurn } from 'node:timers/promises'
import test from 'node:test'
import * as sandbox from './sandbox.js'
import { ProcessWitness } from './diagnostics/bdns/processWitness.js'

test('a settled deferred termination failure remains visible until its owner drains it', async () => {
  assert.equal(typeof sandbox.registerPendingProcessTermination, 'function')
  sandbox.registerPendingProcessTermination(Promise.reject(new Error('kill failed')), 'task-A', 'process-A')
  await nextTurn()
  await sandbox.awaitPendingProcessTerminations('task-B')
  await assert.rejects(
    sandbox.awaitPendingProcessTerminations('task-A'),
    (error: unknown) => error instanceof Error &&
      'code' in error && error.code === 'PROCESS_TERMINATION_FAILED' &&
      'ownerId' in error && error.ownerId === 'task-A',
  )
  await sandbox.awaitPendingProcessTerminations('task-A')
})

test('a successful deferred termination closes once and does not affect another owner', async () => {
  let finish!: () => void
  const termination = new Promise<void>((resolve) => { finish = resolve })
  sandbox.registerPendingProcessTermination(termination, 'task-success', 'process-success')
  await sandbox.awaitPendingProcessTerminations('task-other')
  finish()
  await sandbox.awaitPendingProcessTerminations('task-success')
  await sandbox.awaitPendingProcessTerminations('task-success')
})

test('cancel settles promptly but process exit witness waits for physical close', async () => {
  const witness = new ProcessWitness()
  let exits = 0
  const recordExit = witness.exited.bind(witness)
  witness.exited = (...args) => { exits++; recordExit(...args) }
  const controller = new AbortController()
  const result = sandbox.spawnCommandAsync(process.execPath, [
    '-e', 'setTimeout(() => {}, 10000)',
  ], {
    cwd: process.cwd(), timeoutMs: 15_000, env: process.env,
    signal: controller.signal, processWitness: witness,
    processContext: { sessionId: 'pr242-cancel-witness' },
  })
  controller.abort()
  assert.equal((await result).aborted, true)
  assert.equal(exits, 0)
  await sandbox.awaitPendingProcessTerminations('pr242-cancel-witness')
  assert.equal(exits, 1)
})
