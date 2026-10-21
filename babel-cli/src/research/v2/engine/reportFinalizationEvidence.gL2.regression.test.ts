import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { ResearchMissionV2Schema } from '../contracts/mission.js'
import { buildSynthesizedResearchReport } from './buildSynthesizedResearchReport.js'
import { applySemanticSupportReview } from './findingsFromModelOutput.js'
import {
  deriveUnansweredPlanQuestionIds,
  questionIdsWithAnsweredCoverage,
} from './researchReportFinalization.js'
import {
  GL2_ORIGINAL_DERIVED_LABEL,
  gL2AuditDerivedModelReviewBothClaimingAnswers,
  gL2AuditDerivedModelReviewClaimingAnswersFor,
  gL2NonCacheFindingInsufficient,
  gL2NonCachePassages,
  gL2NonCachePlan,
  gL2NonCacheRevisions,
  gL2NonCacheSources,
  gL2OriginalDerivedFindingQ3Positive,
  gL2OriginalDerivedFindingQ3_7f3,
  gL2OriginalDerivedFindingQ4Positive,
  gL2OriginalDerivedFindingQ4_a0cf,
  gL2OriginalDerivedPassages,
  gL2OriginalDerivedPlan,
  gL2OriginalDerivedRevisions,
  gL2OriginalDerivedSources,
  gL2RenamedSlotFindingPartial,
  gL2RenamedSlotPassages,
  gL2RenamedSlotPlan,
  gL2RenamedSlotRevisions,
  gL2RenamedSlotSources,
} from './testSupport/gL2OriginalDerivedRegression.js'

const gL2MissionPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '../fixtures/campaign/G-L2-mission.json',
)

describe(`G-L2 original-derived coverage (${GL2_ORIGINAL_DERIVED_LABEL})`, () => {
  it('downgrades model answers on q3 (7f3) when MDN lacks max-age TTL substance despite Cache-Control mention', () => {
    const reviewedAt = '2026-10-21T11:06:00.000Z'
    const reviewed = applySemanticSupportReview(
      [gL2OriginalDerivedFindingQ3_7f3],
      gL2AuditDerivedModelReviewClaimingAnswersFor(gL2OriginalDerivedFindingQ3_7f3.finding_id),
      reviewedAt,
      {
        plan: gL2OriginalDerivedPlan,
        passages: gL2OriginalDerivedPassages,
        sources: gL2OriginalDerivedSources,
        sourceRevisions: gL2OriginalDerivedRevisions,
      },
    )
    const finding = reviewed[0]
    assert.equal(finding?.semantic_support?.status, 'supported')
    assert.equal(finding?.question_coverage?.status, 'partial')
    assert.match(finding?.question_coverage?.rationale ?? '', /ob-mdn-max-age-semantics/)
    assert.deepEqual(questionIdsWithAnsweredCoverage(reviewed), new Set())
    assert.deepEqual(deriveUnansweredPlanQuestionIds(gL2OriginalDerivedPlan, reviewed), [
      'q-g-l2-audit-3',
      'q-g-l2-audit-4',
    ])
  })

  it('downgrades model answers on q4 (a0cf) when admitted evidence is cache-directive not audience', () => {
    const reviewedAt = '2026-10-21T11:06:01.000Z'
    const reviewed = applySemanticSupportReview(
      [gL2OriginalDerivedFindingQ4_a0cf],
      gL2AuditDerivedModelReviewClaimingAnswersFor(gL2OriginalDerivedFindingQ4_a0cf.finding_id),
      reviewedAt,
      {
        plan: gL2OriginalDerivedPlan,
        passages: gL2OriginalDerivedPassages,
        sources: gL2OriginalDerivedSources,
        sourceRevisions: gL2OriginalDerivedRevisions,
      },
    )
    const finding = reviewed[0]
    assert.equal(finding?.question_coverage?.status, 'tangential')
    assert.match(finding?.question_coverage?.rationale ?? '', /ob-mdn-audience/)
  })

  it('keeps model answers when all plan obligations are satisfied (positive control)', () => {
    const reviewedAt = '2026-10-21T11:06:01.500Z'
    const reviewed = applySemanticSupportReview(
      [gL2OriginalDerivedFindingQ3Positive, gL2OriginalDerivedFindingQ4Positive],
      {
        kind: 'semantic_support_review',
        judgments: [
          {
            finding_id: gL2OriginalDerivedFindingQ3Positive.finding_id,
            status: 'supported',
            rationale: 'Both slots document max-age semantics in admitted excerpts.',
            question_coverage: 'answers',
          },
          {
            finding_id: gL2OriginalDerivedFindingQ4Positive.finding_id,
            status: 'supported',
            rationale: 'Audience roles are explicit per source.',
            question_coverage: 'answers',
          },
        ],
      },
      reviewedAt,
      {
        plan: gL2OriginalDerivedPlan,
        passages: gL2OriginalDerivedPassages,
        sources: gL2OriginalDerivedSources,
        sourceRevisions: gL2OriginalDerivedRevisions,
      },
    )
    assert.deepEqual(questionIdsWithAnsweredCoverage(reviewed), new Set(['q-g-l2-audit-3', 'q-g-l2-audit-4']))
    assert.equal(reviewed[0]?.question_coverage?.status, 'answers')
    assert.equal(reviewed[1]?.question_coverage?.status, 'answers')
  })

  it('finalizer keeps comparison questions unanswered under defect replay (partial report)', () => {
    const reviewedAt = '2026-10-21T11:06:02.000Z'
    const findings = applySemanticSupportReview(
      [gL2OriginalDerivedFindingQ3_7f3, gL2OriginalDerivedFindingQ4_a0cf],
      gL2AuditDerivedModelReviewBothClaimingAnswers,
      reviewedAt,
      {
        plan: gL2OriginalDerivedPlan,
        passages: gL2OriginalDerivedPassages,
        sources: gL2OriginalDerivedSources,
        sourceRevisions: gL2OriginalDerivedRevisions,
      },
    )
    const mission = ResearchMissionV2Schema.parse(JSON.parse(readFileSync(gL2MissionPath, 'utf8')))
    const report = buildSynthesizedResearchReport({
      mission,
      plan: gL2OriginalDerivedPlan,
      ctx: {
        mission_id: mission.mission_id,
        plan_revision_id: gL2OriginalDerivedPlan.plan_revision_id,
        writer_generation: 1,
      },
      findings,
      passages: gL2OriginalDerivedPassages,
      sourceRevisions: gL2OriginalDerivedRevisions,
      modelOutput: {
        kind: 'synthesize_report',
        answer_summary: 'Model synthesis must not close comparison acceptance alone.',
        stopping_reason: 'original_derived_defect_replay',
      },
      generatedAt: reviewedAt,
    })
    assert.equal(report.terminal_state, 'partial')
    assert.deepEqual(report.unanswered_questions, ['q-g-l2-audit-3', 'q-g-l2-audit-4'])
    assert.ok(
      report.limitations.some((l) => l.startsWith('question_coverage_partial:q-g-l2-audit-3')),
    )
    assert.ok(
      report.limitations.some((l) => l.startsWith('question_coverage_tangential:q-g-l2-audit-4')),
    )
  })

  it('applies renamed provider slots without vendor keyword routing', () => {
    const reviewedAt = '2026-10-21T11:10:05.000Z'
    const reviewed = applySemanticSupportReview(
      [gL2RenamedSlotFindingPartial],
      gL2AuditDerivedModelReviewClaimingAnswersFor(gL2RenamedSlotFindingPartial.finding_id),
      reviewedAt,
      {
        plan: gL2RenamedSlotPlan,
        passages: gL2RenamedSlotPassages,
        sources: gL2RenamedSlotSources,
        sourceRevisions: gL2RenamedSlotRevisions,
      },
    )
    assert.equal(reviewed[0]?.question_coverage?.status, 'partial')
    assert.match(reviewed[0]?.question_coverage?.rationale ?? '', /ob-slot-a-max-age/)
  })

  it('downgrades non-cache comparative coverage when a slot lacks technical evidence', () => {
    const reviewedAt = '2026-10-21T11:12:05.000Z'
    const reviewed = applySemanticSupportReview(
      [gL2NonCacheFindingInsufficient],
      gL2AuditDerivedModelReviewClaimingAnswersFor(gL2NonCacheFindingInsufficient.finding_id),
      reviewedAt,
      {
        plan: gL2NonCachePlan,
        passages: gL2NonCachePassages,
        sources: gL2NonCacheSources,
        sourceRevisions: gL2NonCacheRevisions,
      },
    )
    assert.equal(reviewed[0]?.question_coverage?.status, 'partial')
    const rationale = reviewed[0]?.question_coverage?.rationale ?? ''
    assert.match(rationale, /ob-beta-auth-mechanism/)
    assert.match(rationale, /ob-alpha-audience/)
  })
})
