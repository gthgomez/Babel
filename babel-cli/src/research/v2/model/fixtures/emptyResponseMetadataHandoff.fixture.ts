import type { ZodType } from 'zod'
import {
  buildStructuredOutputError,
  type LlmRunner,
  type ProviderInvocationCompleted,
  type RunnerCallbacks,
  type RunnerInvocationMetadata,
} from '../../../../runners/base.js'

/** Attempt3-shaped usage from live empty-response diagnostic (no live call in tests). */
export const EMPTY_RESPONSE_HANDOFF_USAGE_META: RunnerInvocationMetadata = {
  provider: 'openrouter',
  provider_model_id: 'deepseek/deepseek-v4-flash-0731',
  observed_model_id: 'deepseek/deepseek-v4-flash-0731',
  latency_ms: 120_000,
  prompt_tokens: 652,
  completion_tokens: 32_000,
  total_tokens: 32_652,
  actual_reasoning_tokens: 31_500,
  normalized_finish_reason: 'OUTPUT_BUDGET_EXHAUSTED',
  requested_output_budget: 32_000,
  effective_output_budget: 32_000,
  estimated_cost_usd: 0.004328364,
  cost_precision: 'exact',
}

/** Must never appear in persisted store JSON when A repair is bounded correctly. */
export const EMPTY_RESPONSE_HANDOFF_FORBIDDEN_STORE_SUBSTRINGS = [
  'Bearer handoff-fixture-secret-token',
  'authorization: Bearer',
  'THINKING_TRACE_LEAK_FIXTURE',
  'req-handoff-secret-header-value',
] as const

export const PROVIDER_INVOKE_DIAGNOSTICS_ALLOWLIST_KEYS = new Set([
  'normalized_finish_reason',
  'visible_content_present',
  'visible_content_byte_length',
  'output_digest',
  'input_tokens',
  'output_tokens',
  'reasoning_tokens',
  'requested_output_budget',
  'effective_output_budget',
  'provider_request_id',
  'inference_id',
  'upstream_http_retry_count',
])

export interface EmptyResponseHandoffRunnerOptions {
  inferenceId?: string
  providerRequestId?: string
  outputDigest?: string
}

/**
 * Delivered-path empty body: hook fires with usage + bounded metadata, then structured empty_response throw.
 * Includes in-memory secret/reasoning decoys that must not be persisted.
 */
export function emptyResponseHandoffRunner(
  options: EmptyResponseHandoffRunnerOptions = {},
): Pick<LlmRunner, 'execute'> {
  const inferenceId = options.inferenceId ?? 'inf-empty-handoff'
  const providerRequestId = options.providerRequestId ?? 'req-handoff-fixture'
  const outputDigest =
    options.outputDigest ??
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

  return {
    async execute<T>(_prompt: string, _schema: ZodType<T>, callbacks?: RunnerCallbacks): Promise<T> {
      const completionEvent: ProviderInvocationCompleted = {
        inference_id: inferenceId,
        provider: 'openrouter',
        model: 'deepseek/deepseek-v4-flash-0731',
        status: 'delivered',
        usage_metadata: EMPTY_RESPONSE_HANDOFF_USAGE_META,
        observed_model_id: 'deepseek/deepseek-v4-flash-0731',
        output_digest: outputDigest,
        normalized_finish_reason: 'OUTPUT_BUDGET_EXHAUSTED',
        provider_request_id: providerRequestId,
        requested_output_budget: 32_000,
        effective_output_budget: 32_000,
      }
      Object.assign(completionEvent, {
        decoy_authorization: 'Bearer handoff-fixture-secret-token',
        decoy_raw_reasoning: 'THINKING_TRACE_LEAK_FIXTURE',
      })
      callbacks?.onInvocationCompleted?.(completionEvent)
      throw buildStructuredOutputError({
        failure_kind: 'empty_response',
        provider: 'openrouter',
        model: 'deepseek/deepseek-v4-flash-0731',
        message: '[deepInfraApi] Empty response from model "deepseek/deepseek-v4-flash-0731".',
        raw_output: '',
      })
    },
  }
}

export function productionShapedEmptyResponseBridgeOptions(
  runner: Pick<LlmRunner, 'execute'> = emptyResponseHandoffRunner(),
) {
  return {
    runner,
    backendKey: 'deepseek-v4-flash-openrouter',
    provider: 'openrouter',
    providerModelId: 'deepseek/deepseek-v4-flash-0731',
  }
}
