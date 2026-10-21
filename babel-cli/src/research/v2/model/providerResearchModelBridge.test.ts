import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { LlmRunner } from '../../../runners/base.js'
import { ProviderResearchModelBridge } from './providerResearchModelBridge.js'

describe('ProviderResearchModelBridge', () => {
  it('invokes injected LlmRunner and returns validated structured output', async () => {
    const runner: Pick<LlmRunner, 'execute' | 'getLastInvocationMetadata'> = {
      async execute(_prompt, schema) {
        return schema.parse({
          kind: 'plan_questions',
          questions: [{ text: 'What changed?', importance: 'high' }],
        })
      },
      getLastInvocationMetadata() {
        return {
          provider: 'openrouter',
          provider_model_id: 'test/model',
          latency_ms: 12,
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
          estimated_cost_usd: 0.001,
        }
      },
    }
    const bridge = new ProviderResearchModelBridge({
      runner,
      backendKey: 'research-v2',
      provider: 'openrouter',
      providerModelId: 'test/model',
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
      assert.equal(result.receipt.usage_settlement.attempt_id, 'att-plan-1')
    }
  })
})
