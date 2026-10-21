import { ProviderResearchModelBridge } from './providerResearchModelBridge.js'
import {
  EMPTY_RESPONSE_HANDOFF_USAGE_META,
  productionShapedEmptyResponseBridgeOptions,
} from './fixtures/emptyResponseMetadataHandoff.fixture.js'
import { assertAllowlistedProviderInvokeDiagnosticsOnly } from './fixtures/providerInvokeDiagnosticsAllowlist.js'

/**
 * Agent A repaired bridge checkpoint (git SHA). Null until A lands shared bridge + settlement wiring.
 * B acceptance tests skip when runtime probe is false; pin SHA here for offline worktree validation only.
 */
export const PINNED_EMPTY_RESPONSE_METADATA_REPAIR_SHA: string | null = null

export type ProviderInvokeDiagnostics = {
  normalized_finish_reason?: string
  visible_content_present?: boolean
  visible_content_byte_length?: number
  output_digest?: string
  input_tokens?: number
  output_tokens?: number
  reasoning_tokens?: number
  requested_output_budget?: number | null
  effective_output_budget?: number | null
  provider_request_id?: string | null
  inference_id?: string
  upstream_http_retry_count?: number | 'unknown'
}

export type FailedInvokeWithDiagnostics = {
  status: 'failed'
  usageSettlement: {
    reasoning_tokens?: number
  }
  provider_invoke_diagnostics?: ProviderInvokeDiagnostics
}

/**
 * Detect A's repaired ProviderResearchModelBridge without forking production types.
 * False on current main: reasoning split and event-level diagnostics are still dropped.
 */
export async function probeProviderEmptyResponseMetadataRepair(): Promise<boolean> {
  const bridge = new ProviderResearchModelBridge(productionShapedEmptyResponseBridgeOptions())
  const result = await bridge.invokeStructured({
    operationId: 'probe-empty-response-op',
    attemptId: 'probe-empty-response-att',
    kind: 'plan_questions',
    input: { mission_id: 'mission-probe' },
    signal: new AbortController().signal,
  })
  if (result.status !== 'failed') {
    return false
  }
  const enriched = result as FailedInvokeWithDiagnostics
  const reasoningOk =
    enriched.usageSettlement.reasoning_tokens ===
    EMPTY_RESPONSE_HANDOFF_USAGE_META.actual_reasoning_tokens
  const diagnostics = enriched.provider_invoke_diagnostics
  if (!reasoningOk || diagnostics == null) {
    return false
  }
  try {
    assertAllowlistedProviderInvokeDiagnosticsOnly(diagnostics as Record<string, unknown>)
  } catch {
    return false
  }
  if (diagnostics.normalized_finish_reason !== 'OUTPUT_BUDGET_EXHAUSTED') {
    return false
  }
  if (diagnostics.visible_content_present !== false) {
    return false
  }
  if (diagnostics.output_digest == null) {
    return false
  }
  return true
}
