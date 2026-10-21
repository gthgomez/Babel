import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { ExtractFindingsOutputSchema } from '../contracts/modelOutputs.js'
import { PlanRevisionSchema } from '../contracts/plan.js'
import type { FindingRecord } from '../contracts/findings.js'
import {
  applySemanticSupportReview,
  findingsFromExtractModelOutput,
} from './findingsFromModelOutput.js'
import { deriveUnansweredPlanQuestionIds } from './researchReportFinalization.js'

const campaignDir = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/campaign')
const twoQuestionPlan = PlanRevisionSchema.parse(
  JSON.parse(readFileSync(join(campaignDir, 'G-L2-two-question-plan.fixture.json'), 'utf8')),
)

const passageFixture = {
  passage_id: 'p-mdn',
  source_revision_id: 'rev-1',
  locator: { kind: 'section' as const, section_id: 's' },
  text_ref: { mode: 'inline' as const, text: 't', text_hash: 'a'.repeat(64) },
}

describe('extract question_id contract (production b0194564)', () => {
  it('requires question_id on every extract finding row (schema)', () => {
    assert.throws(() =>
      ExtractFindingsOutputSchema.parse({
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
    const findings = findingsFromExtractModelOutput({
      operationId: 'op-g-l2-two-q',
      plan: twoQuestionPlan,
      passages: [
        passageFixture,
        { ...passageFixture, passage_id: 'p-cf' },
      ],
      createdAt: '2026-10-21T10:00:00.000Z',
      modelOutput: {
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
      },
    })
    assert.deepEqual(
      new Set(findings.map((f) => f.question_id)),
      new Set(['q-g-l2-mdn-cache', 'q-g-l2-cloudflare-cache']),
    )
  })

  it('rejects unknown question_id with no Q1 fallback', () => {
    assert.throws(
      () =>
        findingsFromExtractModelOutput({
          operationId: 'op-bad-q',
          plan: twoQuestionPlan,
          passages: [passageFixture],
          createdAt: '2026-10-21T10:00:00.000Z',
          modelOutput: {
            kind: 'extract_findings',
            findings: [
              {
                assertion_text: 'X',
                assertion_kind: 'source_observation',
                passage_ids: ['p-mdn'],
                question_id: 'q-not-on-plan',
              },
            ],
          },
        }),
      /unknown question_id/,
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
            question_coverage: 'answers',
          },
          {
            finding_id: 'f-cf',
            status: 'insufficient',
            rationale: 'Edge TTL excerpt does not establish browser max-age equivalence',
            question_coverage: 'none',
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
        question_coverage: {
          status: 'answers',
          reviewer: 'r',
          reviewer_version: '0',
          rationale: 'answers mdn question',
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
        question_coverage: {
          status: 'none',
          reviewer: 'r',
          reviewer_version: '0',
          rationale: 'contradicted does not answer',
          reviewed_at: '2026-10-21T09:05:00.000Z',
        },
      },
    ]
    assert.deepEqual(deriveUnansweredPlanQuestionIds(twoQuestionPlan, findings), [
      'q-g-l2-cloudflare-cache',
    ])
  })
})
