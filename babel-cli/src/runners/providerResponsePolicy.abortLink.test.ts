import assert from 'node:assert/strict'
import test from 'node:test'
import { linkExternalAbortSignal } from './providerResponsePolicy.js'

test('linkExternalAbortSignal aborts the attempt controller when the caller signal is already aborted', () => {
  const caller = new AbortController()
  caller.abort()
  const attempt = new AbortController()
  const unlink = linkExternalAbortSignal(attempt, caller.signal)
  assert.equal(unlink, undefined)
  assert.equal(attempt.signal.aborted, true)
})

test('linkExternalAbortSignal forwards a later caller abort', () => {
  const caller = new AbortController()
  const attempt = new AbortController()
  const unlink = linkExternalAbortSignal(attempt, caller.signal)
  assert.equal(typeof unlink, 'function')
  assert.equal(attempt.signal.aborted, false)
  caller.abort()
  assert.equal(attempt.signal.aborted, true)
})
