import assert from 'node:assert/strict'
import test from 'node:test'
import { clearComposerQueue, enqueueComposerMessage, getComposerQueueSnapshot } from '../../ui/composerQueue.js'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InputCoordinator } from '../../ui/inputCoordinator.js'
import { unregisterInterruptHost } from '../../ui/interruptHost.js'
import type { ReplContext } from '../context.js'
import { drainQueuedTasks, executeTaskAndDrainQueue, runReplLoop } from './replLoop.js'

test('hosted provider status presents and repaints without replacing stdout', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-hosted-status-'))
  const previousState = process.env['BABEL_STATE_DIR']
  process.env['BABEL_STATE_DIR'] = join(root, 'state')
  const originalWrite = process.stdout.write
  const writesWereOriginal: boolean[] = []
  const invalidations: string[] = []
  let held = false
  let prompts = 0
  let resolveDone!: () => void
  const done = new Promise<void>(resolve => { resolveDone = resolve })
  const rl = Object.assign(new EventEmitter(), { history: [] as string[], setPrompt: () => {}, prompt: () => { if (++prompts === 2) resolveDone() } })
  const ctx = { rl, state: { mode: 'chat' }, isRunning: false,
    resolveCurrentTarget: () => ({ targetRoot: root }),
    shellRuntime: { appendNotice: () => { writesWereOriginal.push(process.stdout.write === originalWrite) } },
    shellHost: { holdRepaint: () => { held = true }, releaseRepaintHold: () => { const wasHeld = held; held = false; return wasHeld }, invalidate: (reason: string) => invalidations.push(reason) },
  } as unknown as ReplContext
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await runReplLoop(ctx, { executeTask: async () => {} })
    rl.emit('line', '/provider status')
    await Promise.race([done, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('hosted command did not finish')), 20_000) })])
    assert.ok(writesWereOriginal.length > 0)
    assert.ok(writesWereOriginal.every(Boolean), 'hosted command must not replace the global stdout writer')
    assert.ok(invalidations.includes('command-output'))
  } finally {
    if (timer) clearTimeout(timer)
    unregisterInterruptHost()
    InputCoordinator.getInstance().release('repl')
    if (previousState === undefined) delete process.env['BABEL_STATE_DIR']; else process.env['BABEL_STATE_DIR'] = previousState
    rmSync(root, { recursive: true, force: true })
  }
})

test('queued input remains queued while a task is preparing', async () => {
  clearComposerQueue()
  const ctx = { isRunning: false, preparingRun: true } as unknown as ReplContext
  const calls: string[] = []
  try {
    enqueueComposerMessage('queued follow-up')
    await executeTaskAndDrainQueue(ctx, { executeTask: async input => { calls.push(input) } }, 'initial')
    assert.deepEqual(calls, ['initial'])
    assert.deepEqual(getComposerQueueSnapshot(), ['queued follow-up'])
  } finally { clearComposerQueue() }
})

test('queued input drains after the owner has settled', async () => {
  clearComposerQueue()
  const ctx = { isRunning: false, preparingRun: false } as unknown as ReplContext
  const calls: string[] = []
  try {
    enqueueComposerMessage('queued follow-up')
    await executeTaskAndDrainQueue(ctx, { executeTask: async input => { calls.push(input) } }, 'initial')
    assert.deepEqual(calls, ['initial', 'queued follow-up'])
    assert.deepEqual(getComposerQueueSnapshot(), [])
  } finally { clearComposerQueue() }
})

test('standalone command completion drains queued input only after preparation settles', async () => {
  clearComposerQueue()
  const ctx = { isRunning: false, preparingRun: true } as unknown as ReplContext
  const calls: string[] = []; const deps = { executeTask: async (input: string) => { calls.push(input) } }
  try {
    enqueueComposerMessage('queued follow-up')
    await drainQueuedTasks(ctx, deps)
    assert.deepEqual(calls, []); assert.deepEqual(getComposerQueueSnapshot(), ['queued follow-up'])
    ctx.preparingRun = false
    await drainQueuedTasks(ctx, deps)
    assert.deepEqual(calls, ['queued follow-up']); assert.deepEqual(getComposerQueueSnapshot(), [])
  } finally { clearComposerQueue() }
})
