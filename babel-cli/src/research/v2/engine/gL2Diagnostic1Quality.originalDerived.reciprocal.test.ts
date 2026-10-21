/**
 * Original-derived G-L2 quality fixtures for A's canonical reviewer (diagnostic-1 subset).
 * Immutable stored judgments characterize the comparison-acceptance gap; expected rubric is
 * applied only via production review + finalization helpers (no duplicate semantics).
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { FindingRecord } from '../contracts/findings.js'
import { buildSemanticSupportReviewInput } from './buildSemanticSupportReviewInput.js'
import { applySemanticSupportReview } from './findingsFromModelOutput.js'
import {
  deriveQuestionCoverageLimitations,
  deriveUnansweredPlanQuestionIds,
  questionIdsWithAnsweredCoverage,
} from './researchReportFinalization.js'
import { loadGL2Diagnostic1EvidenceSubset } from './testSupport/gL2Diagnostic1EvidenceSubset.js'
import {
  gL2QualityCase1CrossSourceMaxAgeFixture,
  gL2QualityCase2AudienceVsCacheScopeFixture,
  type GL2QualityOriginalDerivedFixture,
} from './testSupport/gL2QualityOriginalDerivedFixtures.js'

const REVIEWED_AT = '2026-10-21T12:00:00.000Z'
const SYNTHETIC_RATIONALE = 'synthetic canonical reviewer rubric from labeled original-derived fixture'

function findingFromSubset(
  findings: readonly FindingRecord[],
  fixture: GL2QualityOriginalDerivedFixture,
): FindingRecord {
  const finding = findings.find((f) => f.finding_id === fixture.finding_id)
  assert.ok(finding, `subset missing finding ${fixture.finding_id}`)
  return finding
}

function rejudgedFindingWithExpectedRubric(
  finding: FindingRecord,
  fixture: GL2QualityOriginalDerivedFixture,
): FindingRecord {
  const rubric = fixture.expected_canonical_reviewer_rubric
  const [rejudged] = applySemanticSupportReview(
    [finding],
    {
      kind: 'semantic_support_review',
      judgments: [
        {
          finding_id: finding.finding_id,
          status: rubric.semantic_support,
          rationale: SYNTHETIC_RATIONALE,
          question_coverage: rubric.question_coverage,
        },
      ],
    },
    REVIEWED_AT,
  )
  assert.ok(rejudged)
  return rejudged
}

function mergeRejudgedFinding(
  findings: readonly FindingRecord[],
  rejudged: FindingRecord,
): FindingRecord[] {
  return findings.map((f) => (f.finding_id === rejudged.finding_id ? rejudged : f))
}

describe('G-L2 diagnostic-1 quality (original-derived reciprocal)', () => {
  const subset = loadGL2Diagnostic1EvidenceSubset()

  it('fixtures pin immutable subset snapshot and synthetic test identity', () => {
    for (const fixture of [
      gL2QualityCase1CrossSourceMaxAgeFixture,
      gL2QualityCase2AudienceVsCacheScopeFixture,
    ]) {
      assert.equal(fixture.schema, 'research-v2-g-l2-quality-original-derived/v1')
      assert.equal(fixture.subset_snapshot_sha256, subset.provenance.source_store_snapshot_sha256)
      assert.equal(fixture.campaign_attempt, subset.campaign_attempt)
      assert.ok(fixture.synthetic_test_id.startsWith('g-l2-quality-case'))
    }
  })

  it('case1: stored row marks question_coverage answers (comparison acceptance gap)', () => {
    const fixture = gL2QualityCase1CrossSourceMaxAgeFixture
    const finding = findingFromSubset(subset.findings, fixture)
    assert.equal(finding.question_id, fixture.plan_question_id)
    assert.equal(finding.semantic_support?.status, fixture.stored_original_judgment.semantic_support)
    assert.equal(
      finding.question_coverage?.status,
      fixture.stored_original_judgment.question_coverage,
    )
    assert.deepEqual(finding.passage_ids.slice().sort(), fixture.cited_passage_ids.slice().sort())
    assert.ok(questionIdsWithAnsweredCoverage(subset.findings).has(fixture.plan_question_id))
    assert.ok(
      !deriveUnansweredPlanQuestionIds(subset.plan_revision, subset.findings).includes(
        fixture.plan_question_id,
      ),
    )
  })

  it('case1: canonical rubric (supported + partial) keeps max-age question unanswered in full finding set', () => {
    const fixture = gL2QualityCase1CrossSourceMaxAgeFixture
    const original = findingFromSubset(subset.findings, fixture)
    const rejudged = rejudgedFindingWithExpectedRubric(original, fixture)
    const merged = mergeRejudgedFinding(subset.findings, rejudged)
    assert.equal(rejudged.semantic_support?.status, 'supported')
    assert.equal(rejudged.question_coverage?.status, 'partial')
    assert.ok(
      !questionIdsWithAnsweredCoverage(merged).has(fixture.plan_question_id),
      'partial coverage must not close the plan question',
    )
    assert.ok(
      deriveUnansweredPlanQuestionIds(subset.plan_revision, merged).includes(
        fixture.plan_question_id,
      ),
    )
    assert.ok(
      deriveQuestionCoverageLimitations(merged).some((l) =>
        l.startsWith(`question_coverage_partial:${fixture.plan_question_id}:${fixture.finding_id}`),
      ),
    )
  })

  it('case2: stored row marks question_coverage answers (audience vs cache-scope gap)', () => {
    const fixture = gL2QualityCase2AudienceVsCacheScopeFixture
    const finding = findingFromSubset(subset.findings, fixture)
    assert.equal(finding.question_id, fixture.plan_question_id)
    assert.equal(finding.semantic_support?.status, fixture.stored_original_judgment.semantic_support)
    assert.equal(
      finding.question_coverage?.status,
      fixture.stored_original_judgment.question_coverage,
    )
    assert.deepEqual(finding.passage_ids.slice().sort(), fixture.cited_passage_ids.slice().sort())
    assert.ok(questionIdsWithAnsweredCoverage(subset.findings).has(fixture.plan_question_id))
  })

  it('case2: canonical rubric (supported + partial) keeps citation-inventory question unanswered', () => {
    const fixture = gL2QualityCase2AudienceVsCacheScopeFixture
    const original = findingFromSubset(subset.findings, fixture)
    const rejudged = rejudgedFindingWithExpectedRubric(original, fixture)
    const merged = mergeRejudgedFinding(subset.findings, rejudged)
    assert.equal(rejudged.question_coverage?.status, 'partial')
    assert.ok(!questionIdsWithAnsweredCoverage(merged).has(fixture.plan_question_id))
    assert.ok(
      deriveUnansweredPlanQuestionIds(subset.plan_revision, merged).includes(
        fixture.plan_question_id,
      ),
    )
  })

  it('buildSemanticSupportReviewInput binds original plan question text for both cases', () => {
    for (const fixture of [
      gL2QualityCase1CrossSourceMaxAgeFixture,
      gL2QualityCase2AudienceVsCacheScopeFixture,
    ]) {
      const finding = findingFromSubset(subset.findings, fixture)
      const input = buildSemanticSupportReviewInput(
        [finding],
        subset.passages,
        subset.plan_revision,
      )
      const planQ = subset.plan_revision.questions.find(
        (q) => q.question_id === fixture.plan_question_id,
      )
      assert.ok(planQ)
      assert.equal(input.findings[0]?.question_text, planQ.text)
      assert.ok(planQ.text.includes(fixture.question_text_anchor.slice(0, 40)))
    }
  })
})
