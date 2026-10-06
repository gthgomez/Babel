import assert from 'node:assert/strict'
import test from 'node:test'
import { computeRequestBudget } from './context-budget.js'

test('infeasible_budget_is_not_positive', () => {
  const budget = computeRequestBudget({
    contextWindow: 1_024,
    requestedOutputTokens: 2_048,
    maxOutputTokens: 2_048,
    toolSchemaReserve: 4_096,
    safetyMargin: 1_024,
  })
  assert.equal(budget.status, 'over_limit')
  assert.equal(budget.capacityTokens, 0)
  assert.ok(budget.capacityTokens >= 0)
  assert.equal(budget.selectedOutputReserve, 2_048)
  assert.equal(budget.overByTokens, 6_144)

  // Omitting the requested output falls back to the catalog maximum, never to a
  // fabricated positive capacity.
  const fromMaximum = computeRequestBudget({
    contextWindow: 1_024,
    maxOutputTokens: 2_048,
    toolSchemaReserve: 4_096,
    safetyMargin: 1_024,
  })
  assert.equal(fromMaximum.status, 'over_limit')
  assert.equal(fromMaximum.capacityTokens, 0)
})

test('requested_output_not_catalog_max', () => {
  const budget = computeRequestBudget({
    contextWindow: 100_000,
    requestedOutputTokens: 2_048,
    maxOutputTokens: 32_768,
    toolSchemaReserve: 4_096,
    safetyMargin: 1_024,
  })
  assert.equal(budget.status, 'fit')
  assert.equal(budget.selectedOutputReserve, 2_048)
  assert.equal(budget.capacityTokens, 100_000 - 2_048 - 4_096 - 1_024)
})

test('unknown_limit_is_not_qualified', () => {
  const absent = computeRequestBudget({ contextWindow: null, requestedOutputTokens: 1_024 })
  assert.equal(absent.status, 'unknown')
  assert.equal(absent.capacityTokens, 0)
  assert.notEqual(absent.status, 'fit')

  const nonPositive = computeRequestBudget({ contextWindow: 0, requestedOutputTokens: 1_024 })
  assert.equal(nonPositive.status, 'unknown')
  assert.equal(nonPositive.capacityTokens, 0)
})

test('requested_output_above_maximum_is_invalid', () => {
  const budget = computeRequestBudget({
    contextWindow: 100_000,
    requestedOutputTokens: 65_536,
    maxOutputTokens: 32_768,
  })
  assert.equal(budget.status, 'invalid')
  assert.equal(budget.capacityTokens, 0)
})

test('reasoning_overhead_counted_once', () => {
  const budget = computeRequestBudget({
    contextWindow: 100_000,
    requestedOutputTokens: 1_024,
    toolSchemaReserve: 4_096,
    safetyMargin: 1_024,
    reasoningReserveTokens: 2_000,
    promptTokens: 1_000,
  })
  assert.equal(budget.status, 'fit')
  assert.equal(budget.capacityTokens, 100_000 - 1_024 - 4_096 - 1_024 - 2_000)
})
