import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildResearchV2StructuredModelPrompt } from './researchV2ProviderModelPrompt.js'
import { describeStrictResearchModelOutputContract } from '../contracts/modelOutputContractPrompt.js'

describe('buildResearchV2StructuredModelPrompt', () => {
  it('delegates to shared contract source for plan_questions', () => {
    const built = buildResearchV2StructuredModelPrompt({
      operationId: 'op-1',
      attemptId: 'att-1',
      kind: 'plan_questions',
      input: { mission_id: 'mission-g-l1-general-live', primary_question: 'test' },
      signal: new AbortController().signal,
    })
    assert.ok(built.prompt.includes(describeStrictResearchModelOutputContract('plan_questions')))
    assert.match(built.prompt, /untrusted evidence context/i)
  })
})
