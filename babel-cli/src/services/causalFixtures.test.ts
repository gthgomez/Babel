import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  DETERMINISTIC_CAUSAL_FIXTURES,
  runDeterministicCausalFixtureSuite,
} from './causalFixtures.js'

test('deterministic causal fixture suite classifies every required boundary', () => {
  const results = runDeterministicCausalFixtureSuite()
  assert.equal(results.length, DETERMINISTIC_CAUSAL_FIXTURES.length)
  assert.deepEqual(
    results.filter((result) => !result.passed).map((result) => result.id),
    [],
  )
  assert.equal(results.filter((result) => result.attribution.family === 'model').length, 3)
  assert.equal(results.filter((result) => result.attribution.model_blame_permitted).length, 3)
})
