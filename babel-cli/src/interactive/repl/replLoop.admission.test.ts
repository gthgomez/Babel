import assert from 'node:assert/strict'
import test from 'node:test'
import { clearComposerQueue, enqueueComposerMessage, getComposerQueueSnapshot } from '../../ui/composerQueue.js'
import { handleImmediateCommand, type ReplContext } from '../context.js'
import { drainQueuedTasks, executeTaskAndDrainQueue } from './replLoop.js'

test('exit aliases can close the shell before command implementations load', () => {
  let exits = 0
  const ctx = { exit: () => { exits++ } }
  for (const input of ['/exit', '/QUIT extra', '/q']) assert.equal(handleImmediateCommand(ctx, input), true)
  assert.equal(exits, 3)
  for (const input of ['/setup', '/exit-now', 'exit']) assert.equal(handleImmediateCommand(ctx, input), false)
  assert.equal(exits, 3)
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

test('first task is submitted once after connection setup succeeds', async () => {
  const calls: string[] = []
  let setups = 0
  const ctx = { state: { readinessState: 'setup_required' }, isRunning: false, preparingRun: false,
    rl: { setInputText: () => { throw new Error('must not restore a successful submission') } } } as unknown as ReplContext
  await executeTaskAndDrainQueue(ctx, {
    executeTask: async input => { calls.push(input) },
    requestSetup: async () => { setups++; ctx.state.readinessState = 'configured_unverified' },
  }, 'Explain the project')
  assert.deepEqual(calls, ['Explain the project'])
  assert.equal(setups, 1)
})

test('cancelled connection setup restores the draft and leaves queued work untouched', async () => {
  clearComposerQueue()
  let draft = ''; let calls = 0
  const ctx = { state: { readinessState: 'setup_required' }, isRunning: false, preparingRun: false,
    rl: { setInputText: (text: string) => { draft = text } } } as unknown as ReplContext
  try {
    enqueueComposerMessage('follow-up')
    await executeTaskAndDrainQueue(ctx, {
      executeTask: async () => { calls++ }, requestSetup: async () => {},
    }, 'Explain the project')
    assert.equal(draft, 'Explain the project')
    assert.equal(calls, 0)
    assert.deepEqual(getComposerQueueSnapshot(), ['follow-up'])
  } finally { clearComposerQueue() }
})
