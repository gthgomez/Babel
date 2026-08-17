import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resetOneShotSnapshot, snapshotOnce, type OneShotPolicySnapshot } from './oneShotToolPolicy.js'

test('one-shot policy is computed once across native/text/stream/retry lookups', () => {
  let computes = 0
  const slot: OneShotPolicySnapshot<{ restrict: boolean }> = { taken: false }
  const read = () =>
    snapshotOnce(slot, () => {
      computes += 1
      return { restrict: true }
    })
  assert.equal(read().restrict, true)
  assert.equal(read().restrict, true)
  assert.equal(read().restrict, true)
  assert.equal(read().restrict, true)
  assert.equal(computes, 1)
  resetOneShotSnapshot(slot)
  assert.equal(read().restrict, true)
  assert.equal(computes, 2)
})
