import assert from 'node:assert/strict'
import test from 'node:test'

import { formatSessionCostHud } from './usageCost.js'

test('formatSessionCostHud surfaces usage estimate when known subtotal is zero', () => {
  const label = formatSessionCostHud({
    totalCostUSD: 0.0027,
    knownCostUSD: 0,
    estimatedCostUSD: 0.0027,
    costComplete: false,
    completeCostUSD: null,
    unknownChargeCount: 0,
  })
  assert.match(label, /0\.0027 usage est\./)
  assert.doesNotMatch(label, /^\$0\.0000$/)
})

test('formatSessionCostHud labels reported billing complete', () => {
  const label = formatSessionCostHud({
    totalCostUSD: 0.02,
    knownCostUSD: 0.02,
    reportedCostUSD: 0.02,
    costComplete: true,
    completeCostUSD: 0.02,
    unknownChargeCount: 0,
  })
  assert.equal(label, '$0.0200 reported')
})
