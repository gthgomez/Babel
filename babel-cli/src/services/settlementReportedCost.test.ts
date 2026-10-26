import assert from 'node:assert/strict'
import test from 'node:test'

import type { RunnerInvocationMetadata } from '../runners/base.js'
import { settlementReportedCostUsd } from './settlementReportedCost.js'

function meta(overrides: Partial<RunnerInvocationMetadata> = {}): RunnerInvocationMetadata {
  return {
    provider: 'openrouter',
    provider_model_id: 'deepseek/deepseek-v4-flash-0731',
    latency_ms: 0,
    prompt_tokens: 10,
    completion_tokens: 5,
    total_tokens: 15,
    estimated_cost_usd: 0.01,
    ...overrides,
  }
}

test('settlementReportedCostUsd returns undefined only when report field is absent', () => {
  assert.equal(settlementReportedCostUsd(undefined), undefined)
  assert.equal(settlementReportedCostUsd(null), undefined)
  assert.equal(settlementReportedCostUsd(meta()), undefined)
  assert.equal(settlementReportedCostUsd({ ...meta(), provider_reported_total_charge_usd: undefined as never }), undefined)
})

test('settlementReportedCostUsd returns null for explicit unavailable or invalid reports', () => {
  assert.equal(settlementReportedCostUsd(meta({ provider_reported_total_charge_usd: null })), null)
  assert.equal(settlementReportedCostUsd(meta({ provider_reported_total_charge_usd: Number.NaN })), null)
  assert.equal(settlementReportedCostUsd(meta({ provider_reported_total_charge_usd: -0.001 })), null)
  assert.equal(settlementReportedCostUsd(meta({ provider_reported_total_charge_usd: '0.01' as unknown as number })), null)
})

test('settlementReportedCostUsd preserves valid finite nonnegative reports including zero', () => {
  assert.equal(settlementReportedCostUsd(meta({ provider_reported_total_charge_usd: 0 })), 0)
  assert.equal(settlementReportedCostUsd(meta({ provider_reported_total_charge_usd: 0.002 })), 0.002)
})
