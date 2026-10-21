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
  productionShapedEmptyResponseBridgeOptions,
} from './fixtures/emptyResponseMetadataHandoff.fixture.js'
import {
  assertNoForbiddenPersistenceSubstrings,
  parseBoundedProviderInvokeDiagnostics,
} from './fixtures/providerInvokeDiagnosticsAllowlist.js'

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

  it('isolates overlapping request-local metadata per attempt', async () => {
    const bridgeA = new ProviderResearchModelBridge(
      productionShapedEmptyResponseBridgeOptions(
        emptyResponseHandoffRunner({
          inferenceId: 'inf-overlap-a',
          providerRequestId: 'req-overlap-a',
        }),
      ),
    )
    const bridgeB = new ProviderResearchModelBridge(
      productionShapedEmptyResponseBridgeOptions(
        emptyResponseHandoffRunner({
          inferenceId: 'inf-overlap-b',
          providerRequestId: 'req-overlap-b',
        }),
      ),
    )
    const [resultA, resultB] = await Promise.all([
      bridgeA.invokeStructured({
        operationId: 'op-overlap-a',
        attemptId: 'att-overlap-a',
        kind: 'plan_questions',
        input: { mission_id: 'mission-fixture' },
        signal: new AbortController().signal,
      }),
      bridgeB.invokeStructured({
        operationId: 'op-overlap-b',
        attemptId: 'att-overlap-b',
        kind: 'plan_questions',
        input: { mission_id: 'mission-fixture' },
        signal: new AbortController().signal,
      }),
    ])
    assert.equal(resultA.status, 'failed')
    assert.equal(resultB.status, 'failed')
    if (resultA.status !== 'failed' || resultB.status !== 'failed') return
    const diagA = parseBoundedProviderInvokeDiagnostics(resultA.providerInvokeDiagnostics)
    const diagB = parseBoundedProviderInvokeDiagnostics(resultB.providerInvokeDiagnostics)
    assert.equal(diagA.provider_request_id, 'req-overlap-a')
    assert.equal(diagB.provider_request_id, 'req-overlap-b')
    assert.equal(diagA.inference_id, 'inf-overlap-a')
    assert.equal(diagB.inference_id, 'inf-overlap-b')
  })
})
