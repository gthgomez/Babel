/**
 * B metadata acceptance on Agent A mapper @ 3340cf0deb555ff9c8a74020017c02262cfc8247 (draft PR 406).
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ProviderInvokeDiagnosticsSchema } from '../contracts/providerInvokeDiagnostics.js'
import { EMPTY_VISIBLE_OUTPUT_DIGEST } from './providerInvokeDiagnosticsFromCompletion.js'
import { ProviderResearchModelBridge } from './providerResearchModelBridge.js'
import {
  EMPTY_RESPONSE_HANDOFF_FORBIDDEN_STORE_SUBSTRINGS,
  EMPTY_RESPONSE_HANDOFF_USAGE_META,
  emptyResponseHandoffRunner,
  interleavedEmptyResponseHandoffRunner,
  productionShapedEmptyResponseBridgeOptions,
} from './fixtures/emptyResponseMetadataHandoff.fixture.js'
import {
  assertNoForbiddenPersistenceSubstrings,
  parseBoundedProviderInvokeDiagnostics,
} from './fixtures/providerInvokeDiagnosticsAllowlist.js'

const REPORTED_COST_USD = EMPTY_RESPONSE_HANDOFF_USAGE_META.estimated_cost_usd

describe('ProviderResearchModelBridge empty-response metadata (A repair acceptance)', () => {
  it('persists bounded diagnostics on failed empty-response invoke', async () => {
    const bridge = new ProviderResearchModelBridge(
      productionShapedEmptyResponseBridgeOptions(emptyResponseHandoffRunner()),
    )
    const result = await bridge.invokeStructured({
      operationId: 'op-empty-accept',
      attemptId: 'att-empty-accept',
      kind: 'plan_questions',
      input: { mission_id: 'mission-fixture' },
      signal: new AbortController().signal,
    })
    assert.equal(result.status, 'failed')
    if (result.status !== 'failed') return
    assert.equal(
      result.usageSettlement.reasoning_tokens,
      EMPTY_RESPONSE_HANDOFF_USAGE_META.actual_reasoning_tokens,
    )
    assert.equal(result.usageSettlement.cost.status, 'reported')
    assert.equal(result.usageSettlement.cost.amount_usd, REPORTED_COST_USD)
    assert.ok(result.providerInvokeDiagnostics)
    const diagnostics = parseBoundedProviderInvokeDiagnostics(result.providerInvokeDiagnostics)
    ProviderInvokeDiagnosticsSchema.parse(diagnostics)
    assert.equal(diagnostics.normalized_finish_reason, 'OUTPUT_BUDGET_EXHAUSTED')
    assert.equal(diagnostics.visible_content_present, false)
    assert.equal(diagnostics.visible_content_byte_length, 0)
    assert.equal(diagnostics.provider_request_id, 'req-handoff-fixture')
    assert.equal(diagnostics.output_digest, EMPTY_VISIBLE_OUTPUT_DIGEST)
    assert.equal(diagnostics.inference_id, 'inf-empty-handoff')
    const serialized = JSON.stringify(result)
    assertNoForbiddenPersistenceSubstrings(serialized, EMPTY_RESPONSE_HANDOFF_FORBIDDEN_STORE_SUBSTRINGS)
  })

  it('isolates interleaved concurrent invokes on one shared bridge and runner', async () => {
    const turnOrder: Array<() => void> = []
    const awaitTurn = (index: number) =>
      new Promise<void>((resolve) => {
        turnOrder[index] = resolve
      })

    const runner = interleavedEmptyResponseHandoffRunner([
      { inferenceId: 'inf-shared-a', providerRequestId: 'req-shared-a', awaitTurn: () => awaitTurn(0) },
      { inferenceId: 'inf-shared-b', providerRequestId: 'req-shared-b', awaitTurn: () => awaitTurn(1) },
    ])
    const bridge = new ProviderResearchModelBridge(productionShapedEmptyResponseBridgeOptions(runner))

    const pendingA = bridge.invokeStructured({
      operationId: 'op-shared-a',
      attemptId: 'att-shared-a',
      kind: 'plan_questions',
      input: { mission_id: 'mission-fixture' },
      signal: new AbortController().signal,
    })
    const pendingB = bridge.invokeStructured({
      operationId: 'op-shared-b',
      attemptId: 'att-shared-b',
      kind: 'plan_questions',
      input: { mission_id: 'mission-fixture' },
      signal: new AbortController().signal,
    })

    turnOrder[1]?.()
    turnOrder[0]?.()

    const [resultA, resultB] = await Promise.all([pendingA, pendingB])
    assert.equal(resultA.status, 'failed')
    assert.equal(resultB.status, 'failed')
    if (resultA.status !== 'failed' || resultB.status !== 'failed') return

    const diagA = parseBoundedProviderInvokeDiagnostics(resultA.providerInvokeDiagnostics)
    const diagB = parseBoundedProviderInvokeDiagnostics(resultB.providerInvokeDiagnostics)
    assert.equal(diagA.provider_request_id, 'req-shared-a')
    assert.equal(diagB.provider_request_id, 'req-shared-b')
    assert.equal(diagA.inference_id, 'inf-shared-a')
    assert.equal(diagB.inference_id, 'inf-shared-b')
    assert.equal(resultA.usageSettlement.cost.status, 'reported')
    assert.equal(resultA.usageSettlement.cost.amount_usd, REPORTED_COST_USD)
    assert.equal(resultB.usageSettlement.cost.status, 'reported')
    assert.equal(resultB.usageSettlement.cost.amount_usd, REPORTED_COST_USD)
  })
})
