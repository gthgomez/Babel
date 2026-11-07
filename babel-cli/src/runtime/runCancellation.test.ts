import assert from 'node:assert/strict'
import test from 'node:test'
import { getRunAbortSignal, throwIfRunAborted, withRunCancellation } from './runCancellation.js'

test('cancellation reaches async continuations and cannot be replaced by a fresh child signal', async () => {
  const parent = new AbortController()
  const child = new AbortController()
  await withRunCancellation(parent.signal, async () => {
    const inherited = getRunAbortSignal(child.signal)
    await Promise.resolve()
    parent.abort()
    assert.equal(inherited?.aborted, true)
    assert.throws(throwIfRunAborted, { name: 'AbortError' })
    assert.throws(() => withRunCancellation(child.signal, () => assert.fail('cancelled parent cannot admit a child')))
  })
  assert.equal(getRunAbortSignal(), undefined)
})

test('cancelling one concurrent run leaves its sibling and caller unbound', async () => {
  const first = new AbortController()
  const second = new AbortController()
  await Promise.all([
    withRunCancellation(first.signal, async () => {
      await Promise.resolve()
      first.abort()
      assert.equal(getRunAbortSignal()?.aborted, true)
    }),
    withRunCancellation(second.signal, async () => {
      await Promise.resolve()
      assert.equal(getRunAbortSignal()?.aborted, false)
      throwIfRunAborted()
    }),
  ])
  assert.equal(getRunAbortSignal(), undefined)
})
