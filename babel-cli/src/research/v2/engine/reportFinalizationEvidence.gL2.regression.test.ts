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
  GL2_AUDIT_DERIVED_LABEL,
  gL2AuditDerivedFindingQ3,
  gL2AuditDerivedFindingQ4WrongAspect,
  gL2AuditDerivedModelReviewBothClaimingAnswers,
  gL2AuditDerivedModelReviewClaimingAnswersFor,
  gL2AuditDerivedPassages,
  gL2AuditDerivedPlan,
  gL2AuditDerivedRevisions,
  gL2AuditDerivedSources,
} from './testSupport/gL2AuditDerivedRegression.js'

const gL2MissionPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '../fixtures/campaign/G-L2-mission.json',
)

describe(`G-L2 audit derived coverage (${GL2_AUDIT_DERIVED_LABEL})`, () => {
  it('downgrades model answers on q3 when MDN lacks relevant max-age admitted evidence', () => {
    const reviewedAt = '2026-10-21T11:06:00.000Z'
    const reviewed = applySemanticSupportReview(
      [gL2AuditDerivedFindingQ3],
      gL2AuditDerivedModelReviewClaimingAnswersFor(gL2AuditDerivedFindingQ3.finding_id),
      reviewedAt,
      {
        plan: gL2AuditDerivedPlan,
        passages: gL2AuditDerivedPassages,
        sources: gL2AuditDerivedSources,
        sourceRevisions: gL2AuditDerivedRevisions,
      },
    )
    const finding = reviewed[0]
    assert.equal(finding?.semantic_support?.status, 'supported')
    assert.equal(finding?.question_coverage?.status, 'partial')
    assert.match(finding?.question_coverage?.rationale ?? '', /mdn_max_age_relevant_evidence/)
    assert.deepEqual(questionIdsWithAnsweredCoverage(reviewed), new Set())
    assert.deepEqual(deriveUnansweredPlanQuestionIds(gL2AuditDerivedPlan, reviewed), [
      'q-g-l2-audit-3',
      'q-g-l2-audit-4',
    ])
  })

  it('downgrades model answers on q4 when admitted evidence is cache-directive not audience', () => {
    const reviewedAt = '2026-10-21T11:06:01.000Z'
    const reviewed = applySemanticSupportReview(
      [gL2AuditDerivedFindingQ4WrongAspect],
      gL2AuditDerivedModelReviewClaimingAnswersFor(gL2AuditDerivedFindingQ4WrongAspect.finding_id),
      reviewedAt,
      {
        plan: gL2AuditDerivedPlan,
        passages: gL2AuditDerivedPassages,
        sources: gL2AuditDerivedSources,
        sourceRevisions: gL2AuditDerivedRevisions,
      },
    )
    const finding = reviewed[0]
    assert.equal(finding?.question_coverage?.status, 'tangential')
    assert.match(finding?.question_coverage?.rationale ?? '', /audience_or_reader_role_evidence/)
  })

  it('finalizer keeps comparison questions unanswered under derived audit defects (partial report)', () => {
    const reviewedAt = '2026-10-21T11:06:02.000Z'
    const findings = applySemanticSupportReview(
      [gL2AuditDerivedFindingQ3, gL2AuditDerivedFindingQ4WrongAspect],
      gL2AuditDerivedModelReviewBothClaimingAnswers,
      reviewedAt,
      {
        plan: gL2AuditDerivedPlan,
        passages: gL2AuditDerivedPassages,
        sources: gL2AuditDerivedSources,
        sourceRevisions: gL2AuditDerivedRevisions,
      },
    )
    const mission = ResearchMissionV2Schema.parse(JSON.parse(readFileSync(gL2MissionPath, 'utf8')))
    const report = buildSynthesizedResearchReport({
      mission,
      plan: gL2AuditDerivedPlan,
      ctx: {
        mission_id: mission.mission_id,
        plan_revision_id: gL2AuditDerivedPlan.plan_revision_id,
        writer_generation: 1,
      },
      findings,
      passages: gL2AuditDerivedPassages,
      sourceRevisions: gL2AuditDerivedRevisions,
      modelOutput: {
        kind: 'synthesize_report',
        answer_summary: 'Model synthesis must not close comparison acceptance alone.',
        stopping_reason: 'derived_audit_regression',
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
})
