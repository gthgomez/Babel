/**
 * Production reciprocal tests for semantic passage support vs plan question coverage (A c3c553a).
 * Historical pre-repair gap characterization lives only in
 * review-artifacts/historical-semantic-question-coverage-gap-9d532d9b.json — not here.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import type { FindingRecord } from '../contracts/findings.js'
import { PlanRevisionSchema } from '../contracts/plan.js'
import { ResearchMissionV2Schema } from '../contracts/mission.js'
import { buildSemanticSupportReviewInput } from './buildSemanticSupportReviewInput.js'
import { buildSynthesizedResearchReport } from './buildSynthesizedResearchReport.js'
import { applySemanticSupportReview } from './findingsFromModelOutput.js'
import {
  deriveQuestionCoverageLimitations,
  deriveUnansweredPlanQuestionIds,
  questionIdsWithAnsweredCoverage,
} from './researchReportFinalization.js'

const campaignDir = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/campaign')
const gL2TwoQuestionPlan = PlanRevisionSchema.parse(
  JSON.parse(readFileSync(join(campaignDir, 'G-L2-two-question-plan.fixture.json'), 'utf8')),
)
const gL3Mission = ResearchMissionV2Schema.parse(
  JSON.parse(readFileSync(join(campaignDir, 'G-L3-mission.json'), 'utf8')),
)

const multiPartPlan = PlanRevisionSchema.parse({
  plan_revision_id: 'plan-multi-part-version-date',
  mission_id: gL3Mission.mission_id,
  created_at: '2026-10-21T10:05:00.000Z',
  revision_reason: 'fixture_multi_part_single_question',
  questions: [
    {
      question_id: 'q-g-l3-stable-version-and-date',
      text:
        'On official python.org pages, what is the latest stable CPython version and its release date?',
      importance: 'critical',
      evidence_requirement: 'Both version and date from admitted excerpts',
      status: 'open',
    },
  ],
})

const REVIEWER = 'research-v2-semantic-review'
const REVIEWED_AT = '2026-10-21T10:06:00.000Z'

function baseFinding(
  overrides: Partial<FindingRecord> & Pick<FindingRecord, 'finding_id' | 'question_id'>,
): FindingRecord {
  return {
    assertion_text: 'synthetic fixture assertion',
    assertion_kind: 'source_observation',
    passage_ids: ['p-synth-1'],
    source_integrity: 'valid',
    created_at: '2026-10-21T10:05:00.000Z',
    ...overrides,
  }
}

function withReview(
  finding: FindingRecord,
  status: 'supported' | 'insufficient' | 'contradicted',
  questionCoverage: 'answers' | 'partial' | 'tangential' | 'none',
): FindingRecord {
  return applySemanticSupportReview(
    [finding],
    {
      kind: 'semantic_support_review',
      judgments: [
        {
          finding_id: finding.finding_id,
          status,
          rationale: 'synthetic production reciprocal judgment',
          question_coverage: questionCoverage,
        },
      ],
    },
    REVIEWED_AT,
  )[0]!
}

describe('semantic question coverage (production c3c553a reciprocal)', () => {
  it('buildSemanticSupportReviewInput binds question_text from active plan', () => {
    const finding = baseFinding({
      finding_id: 'f-bind-text',
      question_id: 'q-g-l2-mdn-cache',
      assertion_text: 'MDN mentions max-age.',
    })
    const passages = [
      {
        passage_id: 'p-synth-1',
        source_revision_id: 'rev-1',
        locator: { kind: 'section' as const, section_id: 's' },
        text_ref: { mode: 'inline' as const, text: 'max-age=3600', text_hash: 'a'.repeat(64) },
      },
    ]
    const input = buildSemanticSupportReviewInput([finding], passages, gL2TwoQuestionPlan)
    assert.equal(input.findings[0]?.question_text, gL2TwoQuestionPlan.questions[0]?.text)
    assert.equal(input.findings[0]?.question_id, 'q-g-l2-mdn-cache')
  })

  it('supported + tangential does not close plan question coverage', () => {
    const raw = baseFinding({
      finding_id: 'f-tangential',
      question_id: 'q-g-l3-stable-version-and-date',
      assertion_text: 'The python.org footer includes a copyright notice.',
    })
    const finding = withReview(raw, 'supported', 'tangential')
    assert.deepEqual(deriveUnansweredPlanQuestionIds(multiPartPlan, [finding]), [
      'q-g-l3-stable-version-and-date',
    ])
    assert.equal(questionIdsWithAnsweredCoverage([finding]).size, 0)
    const limitations = deriveQuestionCoverageLimitations([finding])
    assert.ok(limitations.some((l) => l.startsWith('question_coverage_tangential:')))
  })

  it('supported + partial on multi-part question keeps question unanswered', () => {
    const finding = withReview(
      baseFinding({
        finding_id: 'f-version-only',
        question_id: 'q-g-l3-stable-version-and-date',
        assertion_text: 'Latest stable version is 3.14.0.',
      }),
      'supported',
      'partial',
    )
    assert.deepEqual(deriveUnansweredPlanQuestionIds(multiPartPlan, [finding]), [
      'q-g-l3-stable-version-and-date',
    ])
    assert.ok(
      deriveQuestionCoverageLimitations([finding]).some((l) =>
        l.startsWith('question_coverage_partial:'),
      ),
    )
  })

  it('supported + answers closes only the bound question with answered coverage', () => {
    const answered = withReview(
      baseFinding({
        finding_id: 'f-answered',
        question_id: 'q-g-l2-mdn-cache',
        assertion_text: 'MDN documents max-age for browser caches.',
      }),
      'supported',
      'answers',
    )
    assert.deepEqual(deriveUnansweredPlanQuestionIds(gL2TwoQuestionPlan, [answered]), [
      'q-g-l2-cloudflare-cache',
    ])
    assert.ok(questionIdsWithAnsweredCoverage([answered]).has('q-g-l2-mdn-cache'))
  })

  it('legacy not_assessed on supported finding cannot close coverage', () => {
    const finding = baseFinding({
      finding_id: 'f-not-assessed',
      question_id: 'q-g-l2-mdn-cache',
      assertion_text: 'Supported-looking assertion without coverage judgment.',
      semantic_support: {
        status: 'supported',
        reviewer: REVIEWER,
        reviewer_version: '0.1.0-offline',
        rationale: 'synthetic: passage supports assertion text only',
        reviewed_at: REVIEWED_AT,
      },
      question_coverage: {
        status: 'not_assessed',
        reviewer: REVIEWER,
        reviewer_version: '0.1.0-question-coverage',
        rationale: 'synthetic: legacy row',
        reviewed_at: REVIEWED_AT,
      },
    })
    assert.deepEqual(deriveUnansweredPlanQuestionIds(gL2TwoQuestionPlan, [finding]), [
      'q-g-l2-mdn-cache',
      'q-g-l2-cloudflare-cache',
    ])
  })

  it('synthesized report stays partial when tangential supported finding would have closed Q[0] under legacy rules', () => {
    const finding = withReview(
      baseFinding({
        finding_id: 'f-report-tangential',
        question_id: 'q-g-l3-stable-version-and-date',
        assertion_text: 'Footer copyright notice only.',
      }),
      'supported',
      'tangential',
    )
    const report = buildSynthesizedResearchReport({
      mission: gL3Mission,
      plan: multiPartPlan,
      ctx: {
        mission_id: gL3Mission.mission_id,
        plan_revision_id: multiPartPlan.plan_revision_id,
        writer_generation: 1,
      },
      findings: [finding],
      passages: [
        {
          passage_id: 'p-synth-1',
          source_revision_id: 'rev-synth',
          locator: { kind: 'section' as const, section_id: 'footer' },
          text_ref: {
            mode: 'inline' as const,
            text: 'Copyright notice',
            text_hash: 'b'.repeat(64),
          },
        },
      ],
      sourceRevisions: [
        {
          revision_id: 'rev-synth',
          source_id: 'src-synth',
          content_hash: 'c'.repeat(64),
          retrieved_at: '2026-10-21T10:05:01.000Z',
          extraction_version: 'test/0',
          media_type: 'text/html',
          completeness: 'complete',
          byte_length_received: 100,
        },
      ],
      modelOutput: {
        kind: 'synthesize_report',
        answer_summary: 'Excluded model prose.',
        stopping_reason: 'coverage_sufficient',
      },
      generatedAt: REVIEWED_AT,
    })
    assert.equal(report.terminal_state, 'partial')
    assert.deepEqual(report.unanswered_questions, ['q-g-l3-stable-version-and-date'])
    assert.ok(report.limitations.some((l) => l.startsWith('question_coverage_tangential:')))
  })
})
