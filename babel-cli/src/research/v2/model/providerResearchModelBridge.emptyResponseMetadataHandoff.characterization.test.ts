/**
 * Frozen historical evidence: pre-A-repair bridge drops hook fields (attempt3 class).
 * Do not rewrite assertions when acceptance flips green — add acceptance tests instead.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ProviderResearchModelBridge } from './providerResearchModelBridge.js'
import {
  emptyResponseHandoffRunner,
  productionShapedEmptyResponseBridgeOptions,
} from './fixtures/emptyResponseMetadataHandoff.fixture.js'

describe('ProviderResearchModelBridge empty-response metadata (historical characterization)', () => {
  it('fails on empty visible content with provider_invoke_failed', async () => {
    const bridge = new ProviderResearchModelBridge(
      productionShapedEmptyResponseBridgeOptions(emptyResponseHandoffRunner()),
    )
    const result = await bridge.invokeStructured({
      operationId: 'op-empty',
      attemptId: 'att-empty',
      kind: 'plan_questions',
      input: { mission_id: 'mission-fixture' },
      signal: new AbortController().signal,
    })
    assert.equal(result.status, 'failed')
    if (result.status !== 'failed') return
    assert.equal(result.failureCategory, 'provider_invoke_failed')
    assert.match(result.message, /Empty response/i)
  })

  it('today persists token totals but drops reasoning split and finish reason from the completion hook', async () => {
    const bridge = new ProviderResearchModelBridge(
      productionShapedEmptyResponseBridgeOptions(emptyResponseHandoffRunner()),
    )
    const result = await bridge.invokeStructured({
      operationId: 'op-empty-2',
      attemptId: 'att-empty-2',
      kind: 'plan_questions',
      input: { mission_id: 'mission-fixture' },
      signal: new AbortController().signal,
    })
    assert.equal(result.status, 'failed')
    if (result.status !== 'failed') return
    assert.equal(result.usageSettlement.output_tokens, 32_000)
    assert.equal(result.usageSettlement.input_tokens, 652)
    assert.equal(result.usageSettlement.reasoning_tokens, undefined)
    assert.equal(
      (result as { provider_invoke_diagnostics?: unknown }).provider_invoke_diagnostics,
      undefined,
    )
  })
})
