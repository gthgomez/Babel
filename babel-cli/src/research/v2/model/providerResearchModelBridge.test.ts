import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { LlmRunner, RunnerCallbacks, RunnerInvocationMetadata } from '../../../runners/base.js'
import { ProviderResearchModelBridge } from './providerResearchModelBridge.js'

function runnerWithMetadata(
  meta: RunnerInvocationMetadata,
  delayMs = 0,
): Pick<LlmRunner, 'execute' | 'getLastInvocationMetadata'> {
  return {
    async execute(_prompt, schema, callbacks?: RunnerCallbacks) {
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs))
      }
      callbacks?.onInvocationCompleted?.({
        inference_id: 'inf-1',
        provider: 'openrouter',
        model: meta.provider_model_id ?? 'test/model',
        status: 'delivered',
        usage_metadata: meta,
        observed_model_id: meta.observed_model_id ?? null,
      })
      return schema.parse({
        kind: 'plan_questions',
        questions: [{ text: 'What changed?', importance: 'high' }],
      })
    },
    getLastInvocationMetadata() {
      return {
        provider: 'stale-provider',
        provider_model_id: 'stale/model',
        latency_ms: 0,
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
        estimated_cost_usd: 999,
        cost_precision: 'exact',
      }
    },
  }
}

describe('ProviderResearchModelBridge', () => {
  it('invokes injected LlmRunner and returns validated structured output', async () => {
    const runner = runnerWithMetadata({
      provider: 'openrouter',
      provider_model_id: 'test/model',
      observed_model_id: 'routed/test-model',
      latency_ms: 12,
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
      estimated_cost_usd: 0.001,
      cost_precision: 'exact',
    })
    const bridge = new ProviderResearchModelBridge({
      runner,
      backendKey: 'research-v2',
      provider: 'openrouter',
      providerModelId: 'configured/model',
    })
    const result = await bridge.invokeStructured({
      operationId: 'op-plan-1',
      attemptId: 'att-plan-1',
      kind: 'plan_questions',
      input: { mission_id: 'm-1' },
      signal: new AbortController().signal,
    })
    assert.equal(result.status, 'ok')
    if (result.status === 'ok') {
      assert.equal(result.output.kind, 'plan_questions')
      assert.equal(result.receipt.provider, 'openrouter')
      assert.equal(result.receipt.provider_model_id, 'routed/test-model')
      assert.equal(result.receipt.usage_settlement.attempt_id, 'att-plan-1')
      assert.equal(result.receipt.usage_settlement.cost.status, 'reported')
    }
  })

  it('maps conservative cost precision to estimated settlement', async () => {
    const runner = runnerWithMetadata({
      provider: 'openrouter',
      provider_model_id: 'test/model',
      latency_ms: 1,
      prompt_tokens: 1,
      completion_tokens: 1,
      total_tokens: 2,
      estimated_cost_usd: 0.002,
      cost_precision: 'conservative',
      pricing_verified_at: '2026-10-20T12:00:00.000Z',
    })
    const bridge = new ProviderResearchModelBridge({
      runner,
      backendKey: 'research-v2',
      provider: 'openrouter',
      providerModelId: 'test/model',
    })
    const result = await bridge.invokeStructured({
      operationId: 'op-cost',
      attemptId: 'att-cost',
      kind: 'plan_questions',
      input: {},
      signal: new AbortController().signal,
    })
    assert.equal(result.status, 'ok')
    if (result.status === 'ok') {
      assert.equal(result.receipt.usage_settlement.cost.status, 'estimated')
      if (result.receipt.usage_settlement.cost.status === 'estimated') {
        assert.equal(result.receipt.usage_settlement.cost.method, 'conservative_pinned_rate')
      }
    }
  })

  it('does not use stale getLastInvocationMetadata when callback metadata is present', async () => {
    const runner = runnerWithMetadata({
      provider: 'openrouter',
      provider_model_id: 'callback/model',
      latency_ms: 1,
      prompt_tokens: 1,
      completion_tokens: 1,
      total_tokens: 2,
      estimated_cost_usd: 0.01,
      cost_precision: 'exact',
    })
    const bridge = new ProviderResearchModelBridge({
      runner,
      backendKey: 'research-v2',
      provider: 'openrouter',
      providerModelId: 'configured/model',
    })
    const result = await bridge.invokeStructured({
      operationId: 'op-stale',
      attemptId: 'att-stale',
      kind: 'plan_questions',
      input: {},
      signal: new AbortController().signal,
    })
    assert.equal(result.status, 'ok')
    if (result.status === 'ok') {
      assert.equal(result.receipt.provider_model_id, 'callback/model')
      assert.notEqual(result.receipt.usage_settlement.cost.status, 'unknown')
      if (result.receipt.usage_settlement.cost.status === 'reported') {
        assert.equal(result.receipt.usage_settlement.cost.amount_usd, 0.01)
      }
    }
  })

  it('isolates concurrent invocations via request-local callbacks', async () => {
    const runner: Pick<LlmRunner, 'execute' | 'getLastInvocationMetadata'> = {
      async execute(_prompt, schema, callbacks?: RunnerCallbacks) {
        const id = _prompt.includes('slow') ? 'slow' : 'fast'
        const meta: RunnerInvocationMetadata = {
          provider: 'openrouter',
          provider_model_id: id === 'slow' ? 'slow/model' : 'fast/model',
          latency_ms: 1,
          prompt_tokens: 1,
          completion_tokens: 1,
          total_tokens: 2,
          estimated_cost_usd: id === 'slow' ? 0.2 : 0.1,
          cost_precision: 'exact',
        }
        if (id === 'slow') {
          await new Promise((resolve) => setTimeout(resolve, 30))
        }
        callbacks?.onInvocationCompleted?.({
          inference_id: id,
          provider: 'openrouter',
          model: meta.provider_model_id ?? 'm',
          status: 'delivered',
          usage_metadata: meta,
        })
        return schema.parse({
          kind: 'plan_questions',
          questions: [{ text: id, importance: 'low' }],
        })
      },
      getLastInvocationMetadata: () => null,
    }
    const bridge = new ProviderResearchModelBridge({
      runner,
      backendKey: 'research-v2',
      provider: 'openrouter',
      providerModelId: 'configured/model',
    })
    const [fast, slow] = await Promise.all([
      bridge.invokeStructured({
        operationId: 'fast-op',
        attemptId: 'fast-att',
        kind: 'plan_questions',
        input: { tag: 'fast' },
        signal: new AbortController().signal,
      }),
      bridge.invokeStructured({
        operationId: 'slow-op',
        attemptId: 'slow-att',
        kind: 'plan_questions',
        input: { tag: 'slow' },
        signal: new AbortController().signal,
      }),
    ])
    assert.equal(fast.status, 'ok')
    assert.equal(slow.status, 'ok')
    if (fast.status === 'ok' && slow.status === 'ok') {
      assert.equal(fast.receipt.provider_model_id, 'fast/model')
      assert.equal(slow.receipt.provider_model_id, 'slow/model')
    }
  })

  it('returns cancelled when signal aborts after runner completes', async () => {
    const controller = new AbortController()
    const runner: Pick<LlmRunner, 'execute' | 'getLastInvocationMetadata'> = {
      async execute(_prompt, schema, callbacks?: RunnerCallbacks) {
        callbacks?.onInvocationCompleted?.({
          inference_id: 'inf',
          provider: 'openrouter',
          model: 'test/model',
          status: 'delivered',
          usage_metadata: {
            provider: 'openrouter',
            provider_model_id: 'test/model',
            latency_ms: 1,
            prompt_tokens: 1,
            completion_tokens: 1,
            total_tokens: 2,
            estimated_cost_usd: null,
            cost_precision: 'unknown',
          },
        })
        controller.abort()
        return schema.parse({
          kind: 'plan_questions',
          questions: [{ text: 'late cancel', importance: 'low' }],
        })
      },
      getLastInvocationMetadata: () => null,
    }
    const bridge = new ProviderResearchModelBridge({
      runner,
      backendKey: 'research-v2',
      provider: 'openrouter',
      providerModelId: 'test/model',
    })
    const result = await bridge.invokeStructured({
      operationId: 'op-cancel',
      attemptId: 'att-cancel',
      kind: 'plan_questions',
      input: {},
      signal: controller.signal,
    })
    assert.equal(result.status, 'cancelled')
  })
})
