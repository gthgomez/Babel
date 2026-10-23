import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { LlmRunner } from '../../../runners/base.js'
import { buildStructuredOutputError } from '../../../runners/base.js'
import type { ZodType } from 'zod'
import { ProviderResearchModelBridge } from './providerResearchModelBridge.js'

describe('ProviderResearchModelBridge structured output failures', () => {
  it('maps OpenRouter-compatible StructuredOutputError zod_validation_failed to structured_output_validation_failed', async () => {
    const runner: Pick<LlmRunner, 'execute'> = {
      async execute<T>(_prompt: string, _schema: ZodType<T>): Promise<T> {
        throw buildStructuredOutputError({
          failure_kind: 'zod_validation_failed',
          provider: 'openrouter',
          model: 'deepseek/deepseek-v4-flash-0731',
          message: 'zod validation failed for plan_questions',
          zod_issues: [{ path: ['questions', 0, 'text'], message: 'Required' }],
        })
      },
    }
    const bridge = new ProviderResearchModelBridge({
      runner,
      backendKey: 'research-v2-cli',
      provider: 'openrouter',
      providerModelId: 'deepseek/deepseek-v4-flash-0731',
    })
    const result = await bridge.invokeStructured({
      operationId: 'op-zod-runner',
      attemptId: 'att-zod-runner',
      kind: 'plan_questions',
      input: { mission_id: 'm' },
      signal: new AbortController().signal,
    })
    assert.equal(result.status, 'failed')
    if (result.status === 'failed') {
      assert.equal(result.failureCategory, 'structured_output_validation_failed')
      assert.match(result.message, /zod validation failed/i)
    }
  })
})
