import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { PlanRevisionSchema } from '../contracts/plan.js'
import type { FindingRecord } from '../contracts/findings.js'
import { applySemanticSupportReview } from './findingsFromModelOutput.js'
import { deriveUnansweredPlanQuestionIds } from './researchReportFinalization.js'
import {
  assertExtractQuestionIdsAdmittedByPlan,
  ExtractQuestionAttributionError,
  ProposedExtractFindingsOutputSchema,
} from './testSupport/proposedExtractQuestionAttributionContract.js'

const campaignDir = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/campaign')
const twoQuestionPlan = PlanRevisionSchema.parse(
  JSON.parse(readFileSync(join(campaignDir, 'G-L2-two-question-plan.fixture.json'), 'utf8')),
)

describe('PROPOSED extract question_id contract (A adoption; not production)', () => {
  it('requires question_id on every extract finding row', () => {
    assert.throws(() =>
      ProposedExtractFindingsOutputSchema.parse({
        kind: 'extract_findings',
        findings: [
          {
            assertion_text: 'missing question_id',
            assertion_kind: 'source_observation',
            passage_ids: ['p-1'],
          },
        ],
      }),
    )
  })

  it('two-question attribution success when both question_ids are admitted by plan', () => {
    const parsed = ProposedExtractFindingsOutputSchema.parse({
      kind: 'extract_findings',
      findings: [
        {
          assertion_text: 'MDN max-age guidance',
          assertion_kind: 'source_observation',
          passage_ids: ['p-mdn'],
          question_id: 'q-g-l2-mdn-cache',
        },
        {
          assertion_text: 'Cloudflare edge TTL guidance',
          assertion_kind: 'source_observation',
          passage_ids: ['p-cf'],
          question_id: 'q-g-l2-cloudflare-cache',
        },
      ],
    })
    assertExtractQuestionIdsAdmittedByPlan(twoQuestionPlan, parsed.findings)
    const bindings = new Set(parsed.findings.map((f) => f.question_id))
    assert.deepEqual(bindings, new Set(['q-g-l2-mdn-cache', 'q-g-l2-cloudflare-cache']))
  })

  it('rejects unknown question_id with no Q1 fallback', () => {
    assert.throws(
      () =>
        assertExtractQuestionIdsAdmittedByPlan(twoQuestionPlan, [
          { question_id: 'q-not-on-plan' },
        ]),
      (err: unknown) => err instanceof ExtractQuestionAttributionError,
    )
  })

  it('semantic review preserves finding question_id; unanswered derives per question', () => {
    const findings: FindingRecord[] = [
      {
        finding_id: 'f-mdn',
        question_id: 'q-g-l2-mdn-cache',
        assertion_text: 'MDN assertion',
        assertion_kind: 'source_observation',
        passage_ids: ['p-mdn'],
        source_integrity: 'valid',
        created_at: '2026-10-21T09:00:00.000Z',
      },
      {
        finding_id: 'f-cf',
        question_id: 'q-g-l2-cloudflare-cache',
        assertion_text: 'CF assertion',
        assertion_kind: 'source_observation',
        passage_ids: ['p-cf'],
        source_integrity: 'valid',
        created_at: '2026-10-21T09:00:00.000Z',
      },
    ]
    const reviewed = applySemanticSupportReview(
      findings,
      {
        kind: 'semantic_support_review',
        judgments: [
          {
            finding_id: 'f-mdn',
            status: 'supported',
            rationale: 'MDN passage supports max-age wording',
          },
          {
            finding_id: 'f-cf',
            status: 'insufficient',
            rationale: 'Edge TTL excerpt does not establish browser max-age equivalence',
          },
        ],
      },
      '2026-10-21T09:05:00.000Z',
    )
    assert.equal(reviewed[0]?.question_id, 'q-g-l2-mdn-cache')
    assert.equal(reviewed[1]?.question_id, 'q-g-l2-cloudflare-cache')
    assert.equal(reviewed[1]?.semantic_support?.status, 'insufficient')
    assert.deepEqual(deriveUnansweredPlanQuestionIds(twoQuestionPlan, reviewed), [
      'q-g-l2-cloudflare-cache',
    ])
  })

  it('contradicted on one question does not clear the other supported question', () => {
    const findings: FindingRecord[] = [
      {
        finding_id: 'f-a',
        question_id: 'q-g-l2-mdn-cache',
        assertion_text: 'A',
        assertion_kind: 'source_observation',
        passage_ids: ['p-1'],
        source_integrity: 'valid',
        created_at: '2026-10-21T09:00:00.000Z',
        semantic_support: {
          status: 'supported',
          reviewer: 'r',
          reviewer_version: '0',
          rationale: 'ok',
          reviewed_at: '2026-10-21T09:05:00.000Z',
        },
      },
      {
        finding_id: 'f-b',
        question_id: 'q-g-l2-cloudflare-cache',
        assertion_text: 'B',
        assertion_kind: 'source_observation',
        passage_ids: ['p-2'],
        source_integrity: 'valid',
        created_at: '2026-10-21T09:00:00.000Z',
        semantic_support: {
          status: 'contradicted',
          reviewer: 'r',
          reviewer_version: '0',
          rationale: 'conflicts with admitted passage',
          reviewed_at: '2026-10-21T09:05:00.000Z',
        },
      },
    ]
    assert.deepEqual(deriveUnansweredPlanQuestionIds(twoQuestionPlan, findings), [
      'q-g-l2-cloudflare-cache',
    ])
  })
})
