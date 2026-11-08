import assert from 'node:assert/strict'
import test from 'node:test'
import { clearComposerQueue, enqueueComposerMessage, getComposerQueueSnapshot } from '../../ui/composerQueue.js'
import type { ReplContext } from '../context.js'
import { drainQueuedTasks, executeTaskAndDrainQueue } from './replLoop.js'

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
