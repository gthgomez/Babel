/**
 * B reciprocal: production obligation wiring vs labelled original-derived fixture bytes.
 * Desired q3/q4 partial/tangential behavior is asserted in reportFinalizationEvidence.gL2.regression.test.ts
 * using g-l2-original-derived-regression.fixture.json (frozen diagnostic wording + obligations).
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildSemanticSupportReviewInput } from './buildSemanticSupportReviewInput.js'
import { applySemanticSupportReview } from './findingsFromModelOutput.js'
import { buildPlanRevisionFromPlanQuestions } from './planFromModelOutput.js'
import { obligationsForQuestion } from './planCoverageObligations.js'
import { exampleTechnicalMissionFixture } from '../fixtures/exampleMission.js'
import { loadGL2Diagnostic1EvidenceSubset } from './testSupport/gL2Diagnostic1EvidenceSubset.js'
import {
  gL2QualityCase1CrossSourceMaxAgeFixture,
  gL2QualityCase2AudienceVsCacheScopeFixture,
} from './testSupport/gL2QualityOriginalDerivedFixtures.js'
import {
  gL2OriginalDerivedFindingQ3_7f3,
  gL2OriginalDerivedPassages,
  gL2OriginalDerivedPlan,
  gL2OriginalDerivedRevisions,
  gL2OriginalDerivedSources,
} from './testSupport/gL2OriginalDerivedRegression.js'

describe('G-L2 obligation API production wiring (95a87054)', () => {
  it('immutable live diagnostic subset plan has no coverage_obligations (host planner gap)', () => {
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

  it('buildPlanRevisionFromPlanQuestions does not inject coverage_obligations (await host/mission policy)', () => {
    const plan = buildPlanRevisionFromPlanQuestions({
      mission: exampleTechnicalMissionFixture,
      planRevisionId: 'plan-model-only',
      revisionReason: 'model_plan_questions',
      createdAt: '2026-10-21T12:00:00.000Z',
      modelOutput: {
        kind: 'plan_questions',
        questions: [
          {
            text:
              'On which dimensions do MDN and Cloudflare agree or differ regarding max-age semantics?',
            importance: 'critical',
          },
        ],
      },
    })
    assert.equal(obligationsForQuestion(plan.questions[0]!).length, 0)
  })

  it('labelled original-derived fixture supplies obligations to buildSemanticSupportReviewInput rubric', () => {
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
    assert.match(rubric?.guidance ?? '', /max_age_or_ttl_semantics/)
    assert.ok(
      gL2OriginalDerivedSources.every((s) => typeof s.coverage_source_slot === 'string'),
    )
  })

  it('applySemanticSupportReview uses plan obligations when review context is provided (7f3 → partial)', () => {
    const reviewed = applySemanticSupportReview(
      [gL2OriginalDerivedFindingQ3_7f3],
      {
        kind: 'semantic_support_review',
        judgments: [
          {
            finding_id: gL2OriginalDerivedFindingQ3_7f3.finding_id,
            status: 'supported',
            rationale: 'model claims answers',
            question_coverage: 'answers',
          },
        ],
      },
      '2026-10-21T11:30:00.000Z',
      {
        plan: gL2OriginalDerivedPlan,
        passages: gL2OriginalDerivedPassages,
        sources: gL2OriginalDerivedSources,
        sourceRevisions: gL2OriginalDerivedRevisions,
      },
    )
    assert.equal(reviewed[0]?.question_coverage?.status, 'partial')
  })
})
