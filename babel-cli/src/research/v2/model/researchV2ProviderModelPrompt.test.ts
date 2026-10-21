import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { buildResearchV2StructuredModelPrompt } from './researchV2ProviderModelPrompt.js'

describe('buildResearchV2StructuredModelPrompt', () => {
  it('embeds plan_questions text/importance contract and forbids B malformed keys', () => {
    const built = buildResearchV2StructuredModelPrompt({
      operationId: 'op-1',
      attemptId: 'att-1',
      kind: 'plan_questions',
      input: { mission_id: 'mission-g-l1-general-live', primary_question: 'test' },
      signal: new AbortController().signal,
    })
    assert.match(built.prompt, /"text"/)
    assert.match(built.prompt, /"importance"/)
    assert.match(built.prompt, /Forbidden question fields: question, id, purpose/)
    assert.match(built.prompt, /Do not echo request metadata \(operation_kind, input_mission_id/)
  })
})

describe('G-L1 malformed model replay fixture', () => {
  it('fails strict PlanQuestionsOutputSchema parse deterministically', async () => {
    const fixturePath = join(
      dirname(fileURLToPath(import.meta.url)),
      '../fixtures/campaign/G-L1-live-malformed-plan-questions-response.json',
    )
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
      raw_model_payload: unknown
    }
    const { PlanQuestionsOutputSchema } = await import('../contracts/modelOutputs.js')
    assert.throws(() => PlanQuestionsOutputSchema.parse(fixture.raw_model_payload))
  })
})
