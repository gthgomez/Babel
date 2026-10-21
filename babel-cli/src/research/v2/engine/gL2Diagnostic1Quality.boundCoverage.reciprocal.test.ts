/**
 * B reciprocal: production obligation wiring (27512ba1+) vs immutable live diagnostic bytes.
 * Labelled original-derived fixture JSON remains for frozen passage/finding text; production
 * path exercises buildPlanRevisionFromPlanQuestions + retrieval slot stamping APIs.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { ResearchMissionV2Schema } from '../contracts/mission.js'
import type { FindingRecord } from '../contracts/findings.js'
import { buildSemanticSupportReviewInput } from './buildSemanticSupportReviewInput.js'
import { applySemanticSupportReview } from './findingsFromModelOutput.js'
import { buildPlanRevisionFromPlanQuestions } from './planFromModelOutput.js'
import {
  missionCoverageSourceSlots,
  PlanCoverageObligationValidationError,
  stampCoverageSourceSlotOnSource,
} from './missionCoverageSourceSlots.js'
import { obligationsForQuestion } from './planCoverageObligations.js'
import { buildSynthesizedResearchReport } from './buildSynthesizedResearchReport.js'
import { deriveUnansweredPlanQuestionIds, questionIdsWithAnsweredCoverage } from './researchReportFinalization.js'
import { loadGL2Diagnostic1EvidenceSubset } from './testSupport/gL2Diagnostic1EvidenceSubset.js'
import {
  gL2QualityCase1CrossSourceMaxAgeFixture,
  gL2QualityCase2AudienceVsCacheScopeFixture,
} from './testSupport/gL2QualityOriginalDerivedFixtures.js'
import {
  gL2AuditDerivedModelReviewBothClaimingAnswers,
  gL2AuditDerivedModelReviewClaimingAnswersFor,
  gL2OriginalDerivedFindingQ3_7f3,
  gL2OriginalDerivedFindingQ3Positive,
  gL2OriginalDerivedFindingQ4Positive,
  gL2OriginalDerivedFindingQ4_a0cf,
  gL2OriginalDerivedPassages,
  gL2OriginalDerivedPlan,
  gL2FixtureMissionSourceSlots,
  gL2OriginalDerivedRevisions,
  gL2OriginalDerivedSources,
  gL2PositiveControlModelReview,
} from './testSupport/gL2OriginalDerivedRegression.js'

const gL2MissionPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '../fixtures/campaign/G-L2-mission.json',
)

function loadGL2Mission() {
  return ResearchMissionV2Schema.parse(JSON.parse(readFileSync(gL2MissionPath, 'utf8')))
}

function withQuestionId(finding: FindingRecord, questionId: string): FindingRecord {
  return { ...finding, question_id: questionId }
}

/** Model plan_questions output using frozen original-derived question wording + mission web-ref slots. */
function productionPlanFromOriginalDerivedWording(mission: ReturnType<typeof loadGL2Mission>) {
  const [q3Row, q4Row] = gL2OriginalDerivedPlan.questions
  assert.ok(q3Row && q4Row)
  return buildPlanRevisionFromPlanQuestions({
    mission,
    planRevisionId: 'plan-production-reciprocal',
    revisionReason: 'model_plan_questions',
    createdAt: '2026-10-21T12:00:00.000Z',
    modelOutput: {
      kind: 'plan_questions',
      questions: [
        {
          text: q3Row.text,
          importance: q3Row.importance,
          coverage_obligations: [
            {
              obligation_id: 'ob-mdn-max-age-semantics',
              source_slot: 'web-ref-0',
              aspect: 'technical_effect',
              technical_effect: 'max_age_or_ttl_semantics',
            },
            {
              obligation_id: 'ob-cf-max-age-semantics',
              source_slot: 'web-ref-1',
              aspect: 'technical_effect',
              technical_effect: 'max_age_or_ttl_semantics',
            },
          ],
        },
        {
          text: q4Row.text,
          importance: q4Row.importance,
          coverage_obligations: [
            {
              obligation_id: 'ob-mdn-audience',
              source_slot: 'web-ref-0',
              aspect: 'audience_intent',
            },
            {
              obligation_id: 'ob-cf-audience',
              source_slot: 'web-ref-1',
              aspect: 'audience_intent',
            },
          ],
        },
      ],
    },
  })
}

function productionStampedSources(mission: ReturnType<typeof loadGL2Mission>) {
  const slots = missionCoverageSourceSlots(mission)
  assert.equal(slots[0], 'web-ref-0')
  assert.equal(slots[1], 'web-ref-1')
  return gL2OriginalDerivedSources.map((source, index) =>
    stampCoverageSourceSlotOnSource(source, slots[index]!),
  )
}

describe('G-L2 obligation API — historical live evidence (pre-host wiring)', () => {
  it('immutable live diagnostic subset plan has no coverage_obligations (frozen red evidence)', () => {
    const subset = loadGL2Diagnostic1EvidenceSubset()
    const q3 = subset.plan_revision.questions.find(
      (q) => q.question_id === gL2QualityCase1CrossSourceMaxAgeFixture.plan_question_id,
    )
    const q4 = subset.plan_revision.questions.find(
      (q) => q.question_id === gL2QualityCase2AudienceVsCacheScopeFixture.plan_question_id,
    )
    assert.ok(q3 && q4)
    assert.equal(obligationsForQuestion(q3).length, 0)
    assert.equal(obligationsForQuestion(q4).length, 0)
    assert.equal(
      subset.sources.some((s) => s.coverage_source_slot !== undefined),
      false,
      'live subset sources lack coverage_source_slot until host stamps them at retrieval',
    )
  })
})

describe('G-L2 obligation API production wiring (27512ba1 / 5d822856)', () => {
  it('buildPlanRevisionFromPlanQuestions persists validated obligations for original-derived wording', () => {
    const mission = loadGL2Mission()
    const plan = productionPlanFromOriginalDerivedWording(mission)
    assert.equal(plan.questions.length, 2)
    assert.equal(obligationsForQuestion(plan.questions[0]!).length, 2)
    assert.equal(plan.questions[0]?.coverage_obligations?.[0]?.source_slot, 'web-ref-0')
    assert.match(plan.questions[0]?.text ?? '', /max-age|Cache-Control/i)
  })

  it('rejects plan obligations that reference slots outside missionCoverageSourceSlots', () => {
    const mission = loadGL2Mission()
    assert.throws(
      () =>
        buildPlanRevisionFromPlanQuestions({
          mission,
          planRevisionId: 'plan-bad',
          revisionReason: 'test',
          createdAt: '2026-10-21T12:00:00.000Z',
          modelOutput: {
            kind: 'plan_questions',
            questions: [
              {
                text: gL2OriginalDerivedPlan.questions[0]!.text,
                importance: 'critical',
                coverage_obligations: [
                  {
                    obligation_id: 'ob-bad',
                    source_slot: 'comparison_mdn',
                    aspect: 'technical_effect',
                    technical_effect: 'max_age_or_ttl_semantics',
                  },
                ],
              },
            ],
          },
        }),
      PlanCoverageObligationValidationError,
    )
  })

  it('production-stamped sources align with selected_web_refs slot order', () => {
    const mission = loadGL2Mission()
    const sources = productionStampedSources(mission)
    assert.deepEqual(
      sources.map((s) => s.coverage_source_slot),
      ['web-ref-0', 'web-ref-1'],
    )
  })

  it('planner → stamped slots → review → host bound: q3 (7f3) partial, q4 (a0cf) tangential', () => {
    const mission = loadGL2Mission()
    const plan = productionPlanFromOriginalDerivedWording(mission)
    const sources = productionStampedSources(mission)
    const q3Id = plan.questions[0]!.question_id
    const q4Id = plan.questions[1]!.question_id

    const reviewed = applySemanticSupportReview(
      [
        withQuestionId(gL2OriginalDerivedFindingQ3_7f3, q3Id),
        withQuestionId(gL2OriginalDerivedFindingQ4_a0cf, q4Id),
      ],
      gL2AuditDerivedModelReviewBothClaimingAnswers,
      '2026-10-21T11:30:00.000Z',
      {
        plan,
        passages: gL2OriginalDerivedPassages,
        sources,
        sourceRevisions: gL2OriginalDerivedRevisions,
        missionSourceSlots: gL2FixtureMissionSourceSlots,
      },
    )
    assert.equal(reviewed[0]?.question_coverage?.status, 'partial')
    assert.match(reviewed[0]?.question_coverage?.rationale ?? '', /ob-mdn-max-age-semantics/)
    assert.equal(reviewed[1]?.question_coverage?.status, 'tangential')
    assert.match(reviewed[1]?.question_coverage?.rationale ?? '', /ob-mdn-audience/)
    assert.deepEqual(questionIdsWithAnsweredCoverage(reviewed), new Set())
  })

  it('conservative finalizer leaves comparison questions unanswered under production wiring defect replay', () => {
    const mission = loadGL2Mission()
    const plan = productionPlanFromOriginalDerivedWording(mission)
    const sources = productionStampedSources(mission)
    const q3Id = plan.questions[0]!.question_id
    const q4Id = plan.questions[1]!.question_id
    const reviewedAt = '2026-10-21T11:06:02.000Z'
    const findings = applySemanticSupportReview(
      [
        withQuestionId(gL2OriginalDerivedFindingQ3_7f3, q3Id),
        withQuestionId(gL2OriginalDerivedFindingQ4_a0cf, q4Id),
      ],
      gL2AuditDerivedModelReviewBothClaimingAnswers,
      reviewedAt,
      {
        plan,
        passages: gL2OriginalDerivedPassages,
        sources,
        sourceRevisions: gL2OriginalDerivedRevisions,
        missionSourceSlots: gL2FixtureMissionSourceSlots,
      },
    )
    const report = buildSynthesizedResearchReport({
      mission,
      plan,
      ctx: {
        mission_id: mission.mission_id,
        plan_revision_id: plan.plan_revision_id,
        writer_generation: 1,
      },
      findings,
      passages: gL2OriginalDerivedPassages,
      sourceRevisions: gL2OriginalDerivedRevisions,
      modelOutput: {
        kind: 'synthesize_report',
        answer_summary: 'Synthesis must not override host obligation bounds.',
        stopping_reason: 'production_wiring_defect_replay',
      },
      generatedAt: reviewedAt,
    })
    assert.equal(report.terminal_state, 'partial')
    assert.deepEqual(deriveUnansweredPlanQuestionIds(plan, findings), [q3Id, q4Id])
    assert.ok(report.limitations.some((l) => l.startsWith(`question_coverage_partial:${q3Id}`)))
    assert.ok(report.limitations.some((l) => l.startsWith(`question_coverage_tangential:${q4Id}`)))
  })

  it('positive control keeps answers when obligations + judgments are complete', () => {
    const mission = loadGL2Mission()
    const plan = productionPlanFromOriginalDerivedWording(mission)
    const sources = productionStampedSources(mission)
    const reviewed = applySemanticSupportReview(
      [
        withQuestionId(gL2OriginalDerivedFindingQ3Positive, plan.questions[0]!.question_id),
        withQuestionId(gL2OriginalDerivedFindingQ4Positive, plan.questions[1]!.question_id),
      ],
      gL2PositiveControlModelReview(),
      '2026-10-21T11:06:01.500Z',
      {
        plan,
        passages: gL2OriginalDerivedPassages,
        sources,
        sourceRevisions: gL2OriginalDerivedRevisions,
        missionSourceSlots: gL2FixtureMissionSourceSlots,
      },
    )
    assert.deepEqual(
      questionIdsWithAnsweredCoverage(reviewed),
      new Set([plan.questions[0]!.question_id, plan.questions[1]!.question_id]),
    )
  })

  it('labelled fixture still feeds buildSemanticSupportReviewInput rubric (byte-frozen obligations)', () => {
    const input = buildSemanticSupportReviewInput(
      [gL2OriginalDerivedFindingQ3_7f3],
      gL2OriginalDerivedPassages,
      gL2OriginalDerivedPlan,
      {
        sources: gL2OriginalDerivedSources,
        sourceRevisions: gL2OriginalDerivedRevisions,
      },
    )
    const rubric = input.findings[0]?.coverage_rubric
    assert.ok(rubric)
    assert.ok((rubric?.coverage_obligations?.length ?? 0) >= 2)
    assert.ok(
      rubric?.coverage_obligations?.some(
        (o) => o.technical_effect === 'max_age_or_ttl_semantics',
      ),
    )
    assert.match(rubric?.guidance ?? '', /obligation_coverage/)
  })

  it('applySemanticSupportReview on labelled plan: model answers → partial (7f3)', () => {
    const reviewed = applySemanticSupportReview(
      [gL2OriginalDerivedFindingQ3_7f3],
      gL2AuditDerivedModelReviewClaimingAnswersFor(gL2OriginalDerivedFindingQ3_7f3.finding_id),
      '2026-10-21T11:30:00.000Z',
      {
        plan: gL2OriginalDerivedPlan,
        passages: gL2OriginalDerivedPassages,
        sources: gL2OriginalDerivedSources,
        sourceRevisions: gL2OriginalDerivedRevisions,
        missionSourceSlots: gL2FixtureMissionSourceSlots,
      },
    )
    assert.equal(reviewed[0]?.question_coverage?.status, 'partial')
  })
})
