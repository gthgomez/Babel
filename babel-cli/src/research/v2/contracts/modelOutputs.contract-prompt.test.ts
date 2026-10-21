import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import {
  ResearchModelOperationKindSchema,
  parseValidatedModelOutput,
  PlanQuestionsOutputSchema,
} from './modelOutputs.js'
import {
  describeStrictResearchModelOutputContract,
  RESEARCH_MODEL_OUTPUT_CONTRACT_PROMPT,
} from './modelOutputContractPrompt.js'
import { buildResearchV2StructuredModelPrompt } from '../model/researchV2ProviderModelPrompt.js'
import { ProviderResearchModelBridge } from '../model/providerResearchModelBridge.js'

export const MINIMAL_VALID_MODEL_OUTPUT_BY_KIND: Record<string, Record<string, unknown>> = {
  plan_questions: {
    kind: 'plan_questions',
    questions: [{ text: 'What is the stable release?', importance: 'high' }],
  },
  extract_findings: {
    kind: 'extract_findings',
    findings: [
      {
        assertion_text: 'Observed value in passage.',
        assertion_kind: 'source_observation',
        passage_ids: ['passage-1'],
        question_id: 'q-plan-1',
      },
    ],
  },
  semantic_support_review: {
    kind: 'semantic_support_review',
    judgments: [
      {
        finding_id: 'finding-1',
        status: 'insufficient',
        rationale: 'Passage does not establish the claim.',
        question_coverage: 'none',
        claimed_source_attribution: 'names_unfetched_or_unread_source',
        claimed_source_slots: ['web-ref-0'],
      },
    ],
  },
  synthesize_report: {
    kind: 'synthesize_report',
    answer_summary: 'Insufficient evidence for a verified answer.',
    stopping_reason: 'insufficient_semantic_support',
  },
}

describe('research model output contract prompt sync', () => {
  for (const kind of ResearchModelOperationKindSchema.options) {
    it(`${kind}: minimal example passes the same Zod schema used at invoke time`, () => {
      const example = MINIMAL_VALID_MODEL_OUTPUT_BY_KIND[kind]
      assert.ok(example)
      parseValidatedModelOutput(kind, example)
    })

    it(`${kind}: contract prompt documents enums and rejects extra root keys in validation`, () => {
      const contract = describeStrictResearchModelOutputContract(kind)
      assert.ok(RESEARCH_MODEL_OUTPUT_CONTRACT_PROMPT[kind])
      assert.match(contract, /strict/i)
      const withExtra = { ...MINIMAL_VALID_MODEL_OUTPUT_BY_KIND[kind], operation_kind: kind }
      assert.throws(() => parseValidatedModelOutput(kind, withExtra))
    })
  }

  it('buildResearchV2StructuredModelPrompt embeds full contract for each kind (not operation_kind-only JSON)', () => {
    for (const kind of ResearchModelOperationKindSchema.options) {
      const built = buildResearchV2StructuredModelPrompt({
        operationId: 'op',
        attemptId: 'att',
        kind,
        input: { mission_id: 'm-1', note: 'untrusted context' },
        signal: new AbortController().signal,
      })
      assert.match(built.prompt, new RegExp(`operation "${kind}"`))
      assert.match(built.prompt, /untrusted evidence context/i)
      const contractSnippet = describeStrictResearchModelOutputContract(kind).slice(0, 40)
      assert.ok(built.prompt.includes(contractSnippet.slice(0, 20)))
      assert.doesNotMatch(built.prompt, /matching the requested research operation schema/i)
    }
  })

  it('ProviderResearchModelBridge default buildPrompt uses strict contract (not legacy operation_kind wrapper)', () => {
    const captured: string[] = []
    const runner = {
      async execute<T>(prompt: string, schema: { parse: (v: unknown) => T }): Promise<T> {
        captured.push(prompt)
        return schema.parse(MINIMAL_VALID_MODEL_OUTPUT_BY_KIND.plan_questions) as T
      },
    }
    const bridge = new ProviderResearchModelBridge({
      runner,
      backendKey: 'k',
      provider: 'openrouter',
      providerModelId: 'test/model',
    })
    return bridge
      .invokeStructured({
        operationId: 'op-default-prompt',
        attemptId: 'att-default-prompt',
        kind: 'plan_questions',
        input: { mission_id: 'm' },
        signal: new AbortController().signal,
      })
      .then((result) => {
        assert.equal(result.status, 'ok')
        assert.equal(captured.length, 1)
        assert.match(captured[0]!, /"kind": "plan_questions"/)
        assert.match(captured[0]!, /Forbidden per-question keys/)
        assert.doesNotMatch(captured[0]!, /"operation_kind":"plan_questions"/)
      })
  })

  it('G-L1 malformed replay fixture fails PlanQuestionsOutputSchema (B attempt1)', () => {
    const fixturePath = join(
      dirname(fileURLToPath(import.meta.url)),
      '../fixtures/campaign/G-L1-live-malformed-plan-questions-response.json',
    )
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
      representative_validation_failure_payload: unknown
    }
    assert.throws(() =>
      PlanQuestionsOutputSchema.parse(fixture.representative_validation_failure_payload),
    )
  })
})
