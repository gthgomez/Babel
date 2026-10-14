import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildInvocationMetadata } from './providerResponseMetadata.js'

test('OpenRouter reported billing supports an unpriced model without substituting zero', () => {
  for (const cost of [0, 0.007]) {
    const metadata = buildInvocationMetadata('openrouter', 'deepseek/deepseek-v4.1-flash', 1,
      { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost })
    assert.equal(metadata.estimated_cost_usd, cost)
    assert.equal(metadata.cost_precision, 'exact')
  }
  const absent = buildInvocationMetadata('openrouter', 'unpriced-fixture-model', 1,
    { prompt_tokens: 10, completion_tokens: 5 })
  assert.equal(absent.estimated_cost_usd, null)
  assert.equal(absent.cost_precision, 'unknown')
})

test('invalid reported billing stays unknown even when a pricing estimate exists', () => {
  for (const cost of [-1, NaN, Infinity, '0.01']) {
    const metadata = buildInvocationMetadata('openrouter', 'z-ai/glm-5.3-flash', 1,
      { prompt_tokens: 10, completion_tokens: 5, cost })
    assert.equal(metadata.estimated_cost_usd, null)
    assert.equal(metadata.cost_precision, 'unknown')
  }
})
