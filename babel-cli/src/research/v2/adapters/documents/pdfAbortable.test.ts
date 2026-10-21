import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  awaitBoundedDestroy,
  destroyLoadingTask,
  destroyPdfResources,
  mergeAbortSignals,
} from './pdfAbortable.js'
import { PDF_DESTROY_BOUND_MS } from './pdfExtractionLimits.js'

test('mergeAbortSignals.dispose: removes user listener so later abort does not forward', () => {
  const user = new AbortController()
  const { signal, dispose } = mergeAbortSignals(user.signal)
  dispose()
  user.abort()
  assert.equal(signal.aborted, false)
})

test('destroyLoadingTask: consumes rejected destroy promise', async () => {
  let destroyCalls = 0
  const task = {
    promise: Promise.resolve({}),
    destroy: () => {
      destroyCalls++
      return Promise.reject(new Error('destroy failed'))
    },
  }
  await destroyLoadingTask(task)
  assert.equal(destroyCalls, 1)
})

test('awaitBoundedDestroy: does not hang when destroy never settles', async () => {
  const started = Date.now()
  await awaitBoundedDestroy(() => new Promise<void>(() => {}), 40)
  assert.ok(Date.now() - started < PDF_DESTROY_BOUND_MS)
})

test('destroyPdfResources: bounded doc destroy with late rejection consumed', async () => {
  const doc = {
    destroy: () =>
      new Promise<void>((_resolve, reject) => {
        setTimeout(() => reject(new Error('late doc destroy failure')), 10)
      }),
  }
  const started = Date.now()
  await destroyPdfResources(doc, null)
  assert.ok(Date.now() - started < PDF_DESTROY_BOUND_MS + 200)
})
