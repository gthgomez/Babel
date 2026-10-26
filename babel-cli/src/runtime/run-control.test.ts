import assert from 'node:assert/strict'
import test from 'node:test'
import { createRunControl, type RunIdentity, type StopRequest } from './run-control.js'

const owner: RunIdentity = { runId: 'run', turnId: 'turn', generation: 1 }
const stop = (overrides: Partial<StopRequest> = {}): StopRequest => ({ owner, kind: 'blocked', reasonCode: 'fixture', source: 'executor', ...overrides })

test('first owner-scoped terminal request wins, aborts once and cannot reset', () => {
  const control = createRunControl(owner)
  let aborts = 0
  control.signal.addEventListener('abort', () => { aborts++ })
  assert.equal(control.requestStop(stop()), true)
  assert.equal(control.requestStop(stop({ kind: 'completed', source: 'completion' })), false)
  assert.equal(control.stop()?.kind, 'blocked')
  assert.equal(control.signal.aborted, true)
  assert.equal(control.signal.reason, control.stop())
  assert.equal(aborts, 1)
  assert.equal('reset' in control, false)
})

test('foreign stop and dispatch cannot terminate or use the current owner', async () => {
  const control = createRunControl(owner)
  const foreign = { ...owner, generation: 2 }
  assert.equal(control.requestStop(stop({ owner: foreign })), false)
  let starts = 0
  const rejected = await control.dispatchIfRunning({ owner: foreign, operationId: 'foreign', kind: 'tool' }, async () => ++starts)
  assert.equal(rejected.kind, 'not_started')
  assert.equal(starts, 0)
  assert.equal(control.stop(), null)
  assert.equal(control.signal.aborted, false)
  const admitted = await control.dispatchIfRunning({ owner, operationId: 'owned', kind: 'model' }, async () => ++starts)
  assert.deepEqual(admitted, { kind: 'started', value: 1 })
})

test('final admission invokes start synchronously without an await gap', async () => {
  const control = createRunControl(owner)
  const order: string[] = []
  queueMicrotask(() => { order.push('stop'); control.requestStop(stop()) })
  const result = control.dispatchIfRunning({ owner, operationId: 'atomic', kind: 'tool' }, async () => {
    order.push('start')
    return 7
  })
  assert.deepEqual(order, ['start'])
  assert.deepEqual(await result, { kind: 'started', value: 7 })
  assert.deepEqual(order, ['start', 'stop'])
  let forbiddenStarts = 0
  assert.equal((await control.dispatchIfRunning({ owner, operationId: 'later', kind: 'model' }, async () => ++forbiddenStarts)).kind, 'not_started')
  assert.equal(forbiddenStarts, 0)
})

test('late success settles admitted work without reopening its stopped owner', async () => {
  const control = createRunControl(owner)
  let settle!: (value: number) => void
  const pending = control.dispatchIfRunning({ owner, operationId: 'pending', kind: 'tool' }, () => new Promise<number>(resolve => { settle = resolve }))
  control.requestStop(stop({ kind: 'cancelled', source: 'user' }))
  const winning = control.stop()
  settle(42)
  assert.deepEqual(await pending, { kind: 'started', value: 42 })
  assert.equal(control.stop(), winning)
  assert.equal(control.signal.aborted, true)
  const successor = createRunControl({ ...owner, generation: 2 })
  assert.equal(successor.stop(), null)
  assert.equal(successor.signal.aborted, false)
  assert.equal(control.signal.aborted, true)
})

test('caller mutation cannot change the captured owner or winning stop', () => {
  const mutable = { ...owner }
  const control = createRunControl(mutable)
  mutable.generation = 99
  const request = stop()
  assert.equal(control.requestStop(request), true)
  assert.notEqual(control.owner, mutable)
  assert.notEqual(control.stop(), request)
  assert.ok(Object.isFrozen(control.owner))
  assert.ok(Object.isFrozen(control.stop()))
  assert.ok(Object.isFrozen(control.stop()!.owner))
  assert.equal(control.owner.generation, 1)
})

test('an executor rejection preserves an existing terminal decision', async () => {
  const control = createRunControl(owner)
  const failure = Error('fixture execution failed')
  const pending = control.dispatchIfRunning({ owner, operationId: 'reject', kind: 'tool' }, async () => {
    control.requestStop(stop({ kind: 'failed', source: 'runtime' }))
    throw failure
  })
  await assert.rejects(pending, error => error === failure)
  assert.equal(control.stop()?.kind, 'failed')
  assert.equal(control.signal.aborted, true)
})
