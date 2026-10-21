import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import type { LlmRunner } from '../../../runners/base.js'
import type { ZodType } from 'zod'
import { ProviderResearchModelBridge } from './providerResearchModelBridge.js'
import { buildResearchV2StructuredModelPrompt } from './researchV2ProviderModelPrompt.js'

const fixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  '../fixtures/campaign/G-L1-live-malformed-plan-questions-response.json',
)

function malformedRunner(): Pick<LlmRunner, 'execute'> {
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
    raw_model_payload: Record<string, unknown>
  }
  return {
    async execute<T>(_prompt: string, _schema: ZodType<T>): Promise<T> {
      return fixture.raw_model_payload as T
    },
  }
}

describe('ProviderResearchModelBridge G-L1 malformed replay (B ac011dea)', () => {
  it('fails closed with provider_invoke_failed and preserves usage settlement', async () => {
    const bridge = new ProviderResearchModelBridge({
      runner: malformedRunner(),
      backendKey: 'research-v2-cli',
      provider: 'openrouter',
      providerModelId: 'deepseek/deepseek-v4-flash-0731',
      buildPrompt: buildResearchV2StructuredModelPrompt,
    })
    const built = buildResearchV2StructuredModelPrompt({
      operationId: 'op-plan',
      attemptId: 'att-plan',
      kind: 'plan_questions',
      input: { mission_id: 'mission-g-l1-general-live' },
      signal: new AbortController().signal,
    })
    assert.match(built.prompt, /"text"/)

    const result = await bridge.invokeStructured({
      operationId: 'op-plan',
      attemptId: 'att-plan',
      kind: 'plan_questions',
      input: { mission_id: 'mission-g-l1-general-live' },
      signal: new AbortController().signal,
    })
    assert.equal(result.status, 'failed')
    if (result.status === 'failed') {
      assert.equal(result.failureCategory, 'provider_invoke_failed')
      assert.match(result.message, /questions|text|importance|Unrecognized|invalid/i)
      assert.equal(result.usageSettlement.attempt_id, 'att-plan')
    }
  })
})
