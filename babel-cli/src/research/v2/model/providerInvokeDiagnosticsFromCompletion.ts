import type { ProviderInvocationCompleted } from '../../../runners/base.js'
import type { ProviderInvokeDiagnostics } from '../contracts/providerInvokeDiagnostics.js'

export const EMPTY_VISIBLE_OUTPUT_DIGEST =
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

function deliveredVisibleContentFields(
  digest: string,
): Pick<ProviderInvokeDiagnostics, 'visible_content_present' | 'visible_content_byte_length'> {
  if (digest === EMPTY_VISIBLE_OUTPUT_DIGEST) {
    return { visible_content_present: false, visible_content_byte_length: 0 }
  }
  return { visible_content_present: true }
}

/** Map one request-local {@link ProviderInvocationCompleted} hook event to storable diagnostics. */
export function providerInvokeDiagnosticsFromCompletion(
  event: ProviderInvocationCompleted,
): ProviderInvokeDiagnostics {
  const meta = event.usage_metadata
  const digest = event.output_digest ?? null

  const normalizedFinishReason =
    event.normalized_finish_reason ?? meta?.normalized_finish_reason ?? undefined

  const requestedBudget =
    event.requested_output_budget !== undefined
      ? event.requested_output_budget
      : meta?.requested_output_budget !== undefined
        ? meta.requested_output_budget
        : undefined

  const effectiveBudget =
    event.effective_output_budget !== undefined
      ? event.effective_output_budget
      : meta?.effective_output_budget !== undefined
        ? meta.effective_output_budget
        : undefined

  const visibilityFields =
    event.status === 'delivered' && digest !== null
      ? deliveredVisibleContentFields(digest)
      : {}

  return {
    inference_id: event.inference_id,
    ...visibilityFields,
    ...(normalizedFinishReason ? { normalized_finish_reason: normalizedFinishReason } : {}),
    ...(digest ? { output_digest: digest } : {}),
    ...(meta?.prompt_tokens != null ? { input_tokens: meta.prompt_tokens } : {}),
    ...(meta?.completion_tokens != null ? { output_tokens: meta.completion_tokens } : {}),
    ...(meta?.actual_reasoning_tokens != null
      ? { reasoning_tokens: meta.actual_reasoning_tokens }
      : {}),
    ...(requestedBudget !== undefined ? { requested_output_budget: requestedBudget } : {}),
    ...(effectiveBudget !== undefined ? { effective_output_budget: effectiveBudget } : {}),
    ...(event.provider_request_id !== undefined
      ? { provider_request_id: event.provider_request_id }
      : {}),
  }
}
