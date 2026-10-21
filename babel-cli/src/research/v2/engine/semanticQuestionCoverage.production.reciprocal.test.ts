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
  deriveTerminalState,
  deriveUnansweredPlanQuestionIds,
  questionIdsWithSupportedFindings,
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

const supportedReview = {
  status: 'supported' as const,
  reviewer: 'research-v2-semantic-review',
  reviewer_version: '0.1.0-offline',
  rationale: 'Passage text is consistent with the assertion wording.',
  reviewed_at: '2026-10-21T10:06:00.000Z',
}

const insufficientReview = {
  status: 'insufficient' as const,
  reviewer: 'research-v2-semantic-review',
  reviewer_version: '0.1.0-offline',
  rationale: 'Excerpt does not establish the release date asked by the plan question.',
  reviewed_at: '2026-10-21T10:06:00.000Z',
}

function baseFinding(overrides: Partial<FindingRecord> & Pick<FindingRecord, 'finding_id' | 'question_id'>): FindingRecord {
  return {
    assertion_text: 'placeholder',
    assertion_kind: 'source_observation',
    passage_ids: ['p-1'],
    source_integrity: 'valid',
    created_at: '2026-10-21T10:05:00.000Z',
    ...overrides,
  }
}

/**
 * Flip to true when Agent A lands canonical question-coverage in host finalization
 * (after general multi-source). Until then, tests document honest capability gaps.
 */
const HOST_EVALUATES_QUESTION_COVERAGE = false

describe('semantic question coverage vs passage support (production reciprocal, B-owned tests)', () => {
  it('production semantic review input carries assertion + cited passages only (question text binding queued on A)', () => {
    const findings = [
      baseFinding({
        finding_id: 'f-1',
        question_id: 'q-g-l2-mdn-cache',
        assertion_text: 'MDN mentions max-age.',
      }),
    ]
    const passages = [
      {
        passage_id: 'p-1',
        source_revision_id: 'rev-1',
        locator: { kind: 'section' as const, section_id: 's' },
        text_ref: { mode: 'inline' as const, text: 'Cache-Control: max-age=3600', text_hash: 'c'.repeat(64) },
      },
    ]
    const input = buildSemanticSupportReviewInput(findings, passages)
    assert.equal(input.findings.length, 1)
    const row = input.findings[0]
    assert.equal(row?.finding_id, 'f-1')
    assert.equal(row?.assertion_text, 'MDN mentions max-age.')
    assert.ok(row?.cited_passages[0]?.content_status === 'available')
    assert.equal('question_id' in (row ?? {}), false)
    assert.equal('question_text' in (row ?? {}), false)
  })

  it('honest partial: insufficient judgment keeps plan question in unanswered (passage support ≠ question answered)', () => {
    const findings = [
      baseFinding({
        finding_id: 'f-irrelevant-insufficient',
        question_id: 'q-g-l3-stable-version-and-date',
        assertion_text: 'The downloads page uses a responsive layout.',
        semantic_support: insufficientReview,
      }),
    ]
    assert.deepEqual(deriveUnansweredPlanQuestionIds(multiPartPlan, findings), [
      'q-g-l3-stable-version-and-date',
    ])
    const terminal = deriveTerminalState({
      unansweredQuestionIds: deriveUnansweredPlanQuestionIds(multiPartPlan, findings),
      acquisitionLimitations: [],
      evidenceVerificationLimitations: [],
      runtimeLimitations: [],
      hasSemanticInsufficient: true,
      hasSemanticContradiction: false,
      hasSemanticNotChecked: false,
    })
    assert.equal(terminal, 'partial')
  })

  it('honest partial: multi-part question stays open when only a partial substantive finding is insufficient', () => {
    const versionOnly = baseFinding({
      finding_id: 'f-version',
      question_id: 'q-g-l3-stable-version-and-date',
      assertion_text: 'Latest stable version is 3.14.0.',
      semantic_support: insufficientReview,
    })
    assert.deepEqual(deriveUnansweredPlanQuestionIds(multiPartPlan, [versionOnly]), [
      'q-g-l3-stable-version-and-date',
    ])
  })

  it('applySemanticSupportReview: insufficient on bound question preserves question_id and unanswered', () => {
    const extracted = [
      baseFinding({
        finding_id: 'f-extract',
        question_id: 'q-g-l2-cloudflare-cache',
        assertion_text: 'Cloudflare logo color is orange.',
      }),
    ]
    const reviewed = applySemanticSupportReview(
      extracted,
      {
        kind: 'semantic_support_review',
        judgments: [
          {
            finding_id: 'f-extract',
            status: 'insufficient',
            rationale: 'Passage supports branding text, not edge TTL / max-age guidance.',
          },
        ],
      },
      '2026-10-21T10:06:00.000Z',
    )
    assert.equal(reviewed[0]?.semantic_support?.status, 'insufficient')
    assert.deepEqual(deriveUnansweredPlanQuestionIds(gL2TwoQuestionPlan, reviewed), [
      'q-g-l2-mdn-cache',
      'q-g-l2-cloudflare-cache',
    ])
  })

  it('two-question plan: supported on one question does not clear the sibling without its own supported finding', () => {
    const findings = [
      baseFinding({
        finding_id: 'f-mdn',
        question_id: 'q-g-l2-mdn-cache',
        assertion_text: 'MDN documents max-age for browsers.',
        semantic_support: supportedReview,
      }),
      baseFinding({
        finding_id: 'f-cf-insufficient',
        question_id: 'q-g-l2-cloudflare-cache',
        assertion_text: 'Cloudflare mentions cookies.',
        semantic_support: insufficientReview,
      }),
    ]
    assert.deepEqual(deriveUnansweredPlanQuestionIds(gL2TwoQuestionPlan, findings), [
      'q-g-l2-cloudflare-cache',
    ])
    const report = buildSynthesizedResearchReport({
      mission: gL3Mission,
      plan: gL2TwoQuestionPlan,
      ctx: {
        mission_id: gL3Mission.mission_id,
        plan_revision_id: gL2TwoQuestionPlan.plan_revision_id,
        writer_generation: 1,
      },
      findings,
      modelOutput: {
        kind: 'synthesize_report',
        answer_summary: 'Model must not imply both vendors answered.',
        stopping_reason: 'coverage_sufficient',
      },
      generatedAt: '2026-10-21T10:06:00.000Z',
    })
    assert.equal(report.terminal_state, 'partial')
    assert.deepEqual(report.unanswered_questions, ['q-g-l2-cloudflare-cache'])
    assert.ok(report.limitations.includes('semantic_support_insufficient'))
    assert.ok(!report.stopping_reason.includes('coverage_sufficient'))
  })

  it('capability_gap_reciprocal: supported passage-backed assertion closes question_id without question-text coverage check', () => {
    const findings = [
      baseFinding({
        finding_id: 'f-supported-irrelevant',
        question_id: 'q-g-l3-stable-version-and-date',
        assertion_text: 'The python.org footer includes a copyright notice.',
        semantic_support: {
          ...supportedReview,
          rationale: 'Passage includes a footer copyright line matching the assertion.',
        },
      }),
    ]
    const unanswered = deriveUnansweredPlanQuestionIds(multiPartPlan, findings)
    const supportedQuestions = questionIdsWithSupportedFindings(findings)
    if (HOST_EVALUATES_QUESTION_COVERAGE) {
      assert.deepEqual(unanswered, ['q-g-l3-stable-version-and-date'])
      assert.equal(supportedQuestions.has('q-g-l3-stable-version-and-date'), false)
    } else {
      assert.deepEqual(unanswered, [])
      assert.ok(supportedQuestions.has('q-g-l3-stable-version-and-date'))
      const passage = {
        passage_id: 'p-1',
        source_revision_id: 'rev-g-l3-gap',
        locator: { kind: 'section' as const, section_id: 'footer' },
        text_ref: {
          mode: 'inline' as const,
          text: 'Copyright © Python Software Foundation',
          text_hash: 'd'.repeat(64),
        },
      }
      const revision = {
        revision_id: 'rev-g-l3-gap',
        source_id: 'src-g-l3-footer',
        content_hash: 'e'.repeat(64),
        retrieved_at: '2026-10-21T10:05:01.000Z',
        extraction_version: 'general-static-html/0.1.0',
        media_type: 'text/html',
        completeness: 'complete' as const,
        byte_length_received: 4_000,
      }
      const report = buildSynthesizedResearchReport({
        mission: gL3Mission,
        plan: multiPartPlan,
        ctx: {
          mission_id: gL3Mission.mission_id,
          plan_revision_id: multiPartPlan.plan_revision_id,
          writer_generation: 1,
        },
        findings,
        passages: [passage],
        sourceRevisions: [revision],
        modelOutput: {
          kind: 'synthesize_report',
          answer_summary: 'Must not be treated as verified mission answer.',
          stopping_reason: 'coverage_sufficient',
        },
        generatedAt: '2026-10-21T10:06:00.000Z',
      })
      assert.equal(report.terminal_state, 'complete')
      assert.ok(
        report.limitations.every((l) => !l.startsWith('question_coverage_')),
        'host does not yet emit question-coverage limitations',
      )
      assert.ok(
        !report.coverage_notes.toLowerCase().includes('all plan questions substantively answered'),
      )
    }
  })

  it('capability_gap_reciprocal: partial multi-part answer with one supported finding still closes single plan question', () => {
    const findings = [
      baseFinding({
        finding_id: 'f-version-only',
        question_id: 'q-g-l3-stable-version-and-date',
        assertion_text: 'Latest stable version is 3.14.0.',
        semantic_support: supportedReview,
      }),
      baseFinding({
        finding_id: 'f-date-missing',
        question_id: 'q-g-l3-stable-version-and-date',
        assertion_text: 'Release date was not stated in the excerpt.',
        semantic_support: insufficientReview,
      }),
    ]
    const unanswered = deriveUnansweredPlanQuestionIds(multiPartPlan, findings)
    if (HOST_EVALUATES_QUESTION_COVERAGE) {
      assert.deepEqual(unanswered, ['q-g-l3-stable-version-and-date'])
    } else {
      assert.deepEqual(unanswered, [])
      assert.ok(questionIdsWithSupportedFindings(findings).has('q-g-l3-stable-version-and-date'))
    }
  })
})
