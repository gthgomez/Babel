import assert from 'node:assert/strict'
import test from 'node:test'

import { runnerTokenHistoryCostUsd } from './chatEngineProviderAccounting.js'

test('runnerTokenHistoryCostUsd skips unresolved zero-delta settlement', () => {
  assert.equal(runnerTokenHistoryCostUsd(undefined, { kind: 'inserted', knownCostDelta: 0 }), undefined)
  assert.equal(runnerTokenHistoryCostUsd(null, { kind: 'refined', knownCostDelta: 0 }), undefined)
})

test('runnerTokenHistoryCostUsd records priced delta and explicit reported zero', () => {
  assert.equal(runnerTokenHistoryCostUsd(undefined, { kind: 'refined', knownCostDelta: 0.01 }), 0.01)
  assert.equal(runnerTokenHistoryCostUsd(0, { kind: 'inserted', knownCostDelta: 0 }), 0)
})

test('runnerTokenHistoryCostUsd ignores metadata estimate fallback', () => {
  assert.equal(
    runnerTokenHistoryCostUsd(undefined, { kind: 'duplicate', knownCostDelta: 0 }),
    undefined,
  )
})
