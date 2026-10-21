/**
 * B regression evidence for A: request-local completion hook carries diagnostics
 * that research v2 bridge does not yet persist (empty-response / budget-exhaust class).
 * A owns bridge + contract extension; this test documents current behavior.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ZodType } from 'zod'
import {
  buildStructuredOutputError,
  type LlmRunner,
  type RunnerCallbacks,
  type RunnerInvocationMetadata,
} from '../../../runners/base.js'
import { ProviderResearchModelBridge } from './providerResearchModelBridge.js'

const EMPTY_HOOK_META: RunnerInvocationMetadata = {
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

function emptyDeliveredRunner(): Pick<LlmRunner, 'execute'> {
  return {
    async execute<T>(_prompt: string, _schema: ZodType<T>, callbacks?: RunnerCallbacks): Promise<T> {
      callbacks?.onInvocationCompleted?.({
        inference_id: 'inf-empty-handoff',
        provider: 'openrouter',
        model: 'deepseek/deepseek-v4-flash-0731',
        status: 'delivered',
        usage_metadata: EMPTY_HOOK_META,
        observed_model_id: 'deepseek/deepseek-v4-flash-0731',
        output_digest: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        normalized_finish_reason: 'OUTPUT_BUDGET_EXHAUSTED',
        provider_request_id: 'req-handoff-fixture',
        requested_output_budget: 32_000,
        effective_output_budget: 32_000,
      })
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

describe('ProviderResearchModelBridge empty-response metadata handoff (B evidence for A)', () => {
  it('fails on empty visible content with provider_invoke_failed', async () => {
    const bridge = new ProviderResearchModelBridge({
      runner: emptyDeliveredRunner(),
      backendKey: 'deepseek-v4-flash-openrouter',
      provider: 'openrouter',
      providerModelId: 'deepseek/deepseek-v4-flash-0731',
    })
    const result = await bridge.invokeStructured({
      operationId: 'op-empty',
      attemptId: 'att-empty',
      kind: 'plan_questions',
      input: { mission_id: 'mission-fixture' },
      signal: new AbortController().signal,
    })
    assert.equal(result.status, 'failed')
    if (result.status !== 'failed') return
    assert.match(result.message, /Empty response/i)
  })

  it('today persists token totals but drops reasoning split and finish reason from the completion hook', async () => {
    const bridge = new ProviderResearchModelBridge({
      runner: emptyDeliveredRunner(),
      backendKey: 'deepseek-v4-flash-openrouter',
      provider: 'openrouter',
      providerModelId: 'deepseek/deepseek-v4-flash-0731',
    })
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
