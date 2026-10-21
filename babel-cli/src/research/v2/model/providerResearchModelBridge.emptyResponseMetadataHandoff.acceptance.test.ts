/**
 * Positive acceptance vs Agent A repaired ProviderResearchModelBridge (runtime probe).
 * Skipped until shared bridge persists bounded hook metadata; characterization stays frozen.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ProviderResearchModelBridge } from './providerResearchModelBridge.js'
import {
  EMPTY_RESPONSE_HANDOFF_FORBIDDEN_STORE_SUBSTRINGS,
  EMPTY_RESPONSE_HANDOFF_USAGE_META,
  emptyResponseHandoffRunner,
  productionShapedEmptyResponseBridgeOptions,
} from './fixtures/emptyResponseMetadataHandoff.fixture.js'
import {
  assertAllowlistedProviderInvokeDiagnosticsOnly,
  assertNoForbiddenPersistenceSubstrings,
} from './fixtures/providerInvokeDiagnosticsAllowlist.js'
import {
  probeProviderEmptyResponseMetadataRepair,
  type FailedInvokeWithDiagnostics,
} from './emptyResponseMetadataRepairProbe.js'

describe('ProviderResearchModelBridge empty-response metadata (A repair acceptance)', () => {
  it('persists bounded diagnostics on failed empty-response invoke', async (t) => {
    if (!(await probeProviderEmptyResponseMetadataRepair())) {
      t.skip('Agent A empty-response metadata bridge repair not detected on ProviderResearchModelBridge')
      return
    }
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
    const enriched = result as FailedInvokeWithDiagnostics
    assert.equal(
      enriched.usageSettlement.reasoning_tokens,
      EMPTY_RESPONSE_HANDOFF_USAGE_META.actual_reasoning_tokens,
    )
    const diagnostics = enriched.provider_invoke_diagnostics
    assert.ok(diagnostics)
    assertAllowlistedProviderInvokeDiagnosticsOnly(diagnostics as Record<string, unknown>)
    assert.equal(diagnostics.normalized_finish_reason, 'OUTPUT_BUDGET_EXHAUSTED')
    assert.equal(diagnostics.visible_content_present, false)
    assert.equal(diagnostics.visible_content_byte_length, 0)
    assert.equal(diagnostics.provider_request_id, 'req-handoff-fixture')
    assert.equal(diagnostics.output_digest, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    assert.equal(diagnostics.upstream_http_retry_count, undefined)
    const serialized = JSON.stringify(result)
    assertNoForbiddenPersistenceSubstrings(serialized, EMPTY_RESPONSE_HANDOFF_FORBIDDEN_STORE_SUBSTRINGS)
  })

  it('isolates overlapping request-local metadata per attempt', async (t) => {
    if (!(await probeProviderEmptyResponseMetadataRepair())) {
      t.skip('Agent A empty-response metadata bridge repair not detected on ProviderResearchModelBridge')
      return
    }
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
    const diagA = (resultA as FailedInvokeWithDiagnostics).provider_invoke_diagnostics
    const diagB = (resultB as FailedInvokeWithDiagnostics).provider_invoke_diagnostics
    assert.equal(diagA?.provider_request_id, 'req-overlap-a')
    assert.equal(diagB?.provider_request_id, 'req-overlap-b')
    assert.equal(diagA?.inference_id, 'inf-overlap-a')
    assert.equal(diagB?.inference_id, 'inf-overlap-b')
  })
})
