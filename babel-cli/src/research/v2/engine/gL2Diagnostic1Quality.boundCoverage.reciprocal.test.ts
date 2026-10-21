/**
 * Verifies A da3b1f5 bound question coverage on immutable diagnostic-1 wording (labeled fixtures).
 * Uses production helpers only — no duplicate rubric implementation in testSupport.
 *
 * Characterization history: keyword/heuristic gaps below are not product acceptance. Reconcile
 * assertions to A general evidence-obligation API when published (expect partial/insufficient
 * on original q3/q4; keep renamed/non-cache negatives and complete positive control).
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { PassageRecord } from '../contracts/passages.js'
import type { SourceRecord, SourceRevision } from '../contracts/sources.js'
import {
  assessBoundQuestionCoverageFromAdmittedEvidence,
  buildRevisionProvenanceIndex,
  citedPassageEvidenceSignals,
  enforceBoundQuestionCoverageOnFindings,
  inferQuestionCoverageProfile,
} from './boundQuestionCoverageFromEvidence.js'
import { applySemanticSupportReview } from './findingsFromModelOutput.js'
import { questionIdsWithAnsweredCoverage } from './researchReportFinalization.js'
import { loadGL2Diagnostic1EvidenceSubset } from './testSupport/gL2Diagnostic1EvidenceSubset.js'
import {
  gL2QualityCase1CrossSourceMaxAgeFixture,
  gL2QualityCase2AudienceVsCacheScopeFixture,
} from './testSupport/gL2QualityOriginalDerivedFixtures.js'
import {
  GL2_BOUND_COVERAGE_CONTROLS_LABEL,
  gL2CompleteMaxAgePositivePassages,
  gL2CompleteMaxAgePositiveRevisions,
  gL2CompleteMaxAgePositiveSources,
  gL2NonCacheComparisonQuestion,
  gL2RenamedProviderPassages,
  gL2RenamedProviderRevisions,
  gL2RenamedProviderSources,
} from './testSupport/gL2OriginalDerivedBoundCoverageControls.js'
import {
  gL2AuditDerivedPassages,
  gL2AuditDerivedPlan,
  gL2AuditDerivedRevisions,
  gL2AuditDerivedSources,
} from './testSupport/gL2AuditDerivedRegression.js'

const REVIEWED_AT = '2026-10-21T11:22:00.000Z'

function planQuestion(subset: ReturnType<typeof loadGL2Diagnostic1EvidenceSubset>, questionId: string) {
  const q = subset.plan_revision.questions.find((row) => row.question_id === questionId)
  assert.ok(q, `missing plan question ${questionId}`)
  return q
}

function passagesForFinding(
  subset: ReturnType<typeof loadGL2Diagnostic1EvidenceSubset>,
  findingId: string,
) {
  const finding = subset.findings.find((f) => f.finding_id === findingId)
  assert.ok(finding, `missing finding ${findingId}`)
  const byId = new Map(subset.passages.map((p) => [p.passage_id, p]))
  return finding.passage_ids.map((id) => {
    const passage = byId.get(id)
    assert.ok(passage, `missing passage ${id}`)
    return passage
  })
}

function signalsForPassages(
  passages: readonly PassageRecord[],
  sources: readonly SourceRecord[],
  revisions: readonly SourceRevision[],
) {
  const index = buildRevisionProvenanceIndex(sources, revisions)
  return passages.map((p) => citedPassageEvidenceSignals(p, index.get(p.source_revision_id)))
}

describe('G-L2 diagnostic-1 bound coverage (original-derived, da3b1f5 helpers)', () => {
  const subset = loadGL2Diagnostic1EvidenceSubset()
  const q3 = planQuestion(subset, gL2QualityCase1CrossSourceMaxAgeFixture.plan_question_id)
  const q4 = planQuestion(subset, gL2QualityCase2AudienceVsCacheScopeFixture.plan_question_id)

  it('routes original q3 to cross-source cache_control_max_age profile', () => {
    const profile = inferQuestionCoverageProfile(q3.text, q3.evidence_requirement)
    assert.equal(profile.aspect, 'cache_control_max_age')
    assert.equal(profile.crossSourceComparison, true)
    assert.deepEqual(profile.requiredSourceClasses, ['mdn', 'cloudflare'])
  })

  it('routes original q4 to cache comparison first (max-age in question text), not audience profile', () => {
    const profile = inferQuestionCoverageProfile(q4.text, q4.evidence_requirement)
    assert.equal(profile.aspect, 'cache_control_max_age')
    assert.equal(profile.crossSourceComparison, true)
    assert.notEqual(profile.aspect, 'audience_browser_vs_edge')
  })

  it('native replay: original MDN excerpt mentions Cache-Control so facet check passes for q3 citations', () => {
    const passages = passagesForFinding(subset, gL2QualityCase1CrossSourceMaxAgeFixture.finding_id)
    const index = buildRevisionProvenanceIndex(subset.sources, subset.revisions)
    const signals = passages.map((p) => citedPassageEvidenceSignals(p, index.get(p.source_revision_id)))
    const mdnSignal = signals.find((s) => s.web_source_class === 'mdn')
    assert.ok(mdnSignal)
    assert.equal(mdnSignal.mentions_max_age_or_cache_control, true)
    const profile = inferQuestionCoverageProfile(q3.text, q3.evidence_requirement)
    const assessment = assessBoundQuestionCoverageFromAdmittedEvidence(profile, signals)
    assert.equal(assessment.satisfiesRequiredFacets, true)
    assert.deepEqual(assessment.missingFacets, [])
  })

  it('contrast: A synthetic derived MDN overview omits Cache-Control trigger and fails mdn facet', () => {
    const qDerived = gL2AuditDerivedPlan.questions[0]!
    const profile = inferQuestionCoverageProfile(qDerived.text, qDerived.evidence_requirement)
    const index = buildRevisionProvenanceIndex(gL2AuditDerivedSources, gL2AuditDerivedRevisions)
    const signals = gL2AuditDerivedPassages.map((p) =>
      citedPassageEvidenceSignals(p, index.get(p.source_revision_id)),
    )
    const assessment = assessBoundQuestionCoverageFromAdmittedEvidence(profile, signals)
    assert.equal(assessment.satisfiesRequiredFacets, false)
    assert.ok(assessment.missingFacets.includes('mdn_max_age_relevant_evidence'))
  })

  it('host bound does not downgrade stored answers on original finding-7f3 under keyword heuristic', () => {
    const finding = subset.findings.find(
      (f) => f.finding_id === gL2QualityCase1CrossSourceMaxAgeFixture.finding_id,
    )!
    const reviewed = applySemanticSupportReview(
      [finding],
      {
        kind: 'semantic_support_review',
        judgments: [
          {
            finding_id: finding.finding_id,
            status: 'supported',
            rationale: 'model claims answers (replay)',
            question_coverage: 'answers',
          },
        ],
      },
      REVIEWED_AT,
      {
        plan: subset.plan_revision,
        passages: subset.passages,
        sources: subset.sources,
        sourceRevisions: subset.revisions,
      },
    )
    assert.equal(reviewed[0]?.question_coverage?.status, 'answers')
    assert.ok(questionIdsWithAnsweredCoverage(reviewed).has(q3.question_id))
  })

  it('host bound keeps finding-a0cf answers when q4 profile is cache comparison (same keyword path)', () => {
    const finding = subset.findings.find(
      (f) => f.finding_id === gL2QualityCase2AudienceVsCacheScopeFixture.finding_id,
    )!
    const passages = passagesForFinding(subset, finding.finding_id)
    const index = buildRevisionProvenanceIndex(subset.sources, subset.revisions)
    const signals = passages.map((p) => citedPassageEvidenceSignals(p, index.get(p.source_revision_id)))
    const profile = inferQuestionCoverageProfile(q4.text, q4.evidence_requirement)
    const assessment = assessBoundQuestionCoverageFromAdmittedEvidence(profile, signals)
    assert.equal(assessment.satisfiesRequiredFacets, true)
    const reviewed = applySemanticSupportReview(
      [finding],
      {
        kind: 'semantic_support_review',
        judgments: [
          {
            finding_id: finding.finding_id,
            status: 'supported',
            rationale: 'model claims answers (replay)',
            question_coverage: 'answers',
          },
        ],
      },
      REVIEWED_AT,
      {
        plan: subset.plan_revision,
        passages: subset.passages,
        sources: subset.sources,
        sourceRevisions: subset.revisions,
      },
    )
    assert.equal(reviewed[0]?.question_coverage?.status, 'answers')
  })

  it(`${GL2_BOUND_COVERAGE_CONTROLS_LABEL}: renamed MDN host is not mdn class — missing facet`, () => {
    const profile = inferQuestionCoverageProfile(q3.text, q3.evidence_requirement)
    const signals = signalsForPassages(
      gL2RenamedProviderPassages,
      gL2RenamedProviderSources,
      gL2RenamedProviderRevisions,
    )
    const assessment = assessBoundQuestionCoverageFromAdmittedEvidence(profile, signals)
    assert.equal(assessment.satisfiesRequiredFacets, false)
    assert.ok(assessment.missingFacets.includes('mdn_max_age_relevant_evidence'))
  })

  it(`${GL2_BOUND_COVERAGE_CONTROLS_LABEL}: non-cache comparison question stays general aspect`, () => {
    const profile = inferQuestionCoverageProfile(
      gL2NonCacheComparisonQuestion.text,
      gL2NonCacheComparisonQuestion.evidence_requirement,
    )
    assert.equal(profile.aspect, 'general')
    assert.equal(profile.crossSourceComparison, false)
    const assessment = assessBoundQuestionCoverageFromAdmittedEvidence(profile, [])
    assert.equal(assessment.satisfiesRequiredFacets, true)
  })

  it(`${GL2_BOUND_COVERAGE_CONTROLS_LABEL}: complete per-source max-age excerpts satisfy cross-source facets`, () => {
    const profile = inferQuestionCoverageProfile(q3.text, q3.evidence_requirement)
    const signals = signalsForPassages(
      gL2CompleteMaxAgePositivePassages,
      gL2CompleteMaxAgePositiveSources,
      gL2CompleteMaxAgePositiveRevisions,
    )
    const assessment = assessBoundQuestionCoverageFromAdmittedEvidence(profile, signals)
    assert.equal(assessment.satisfiesRequiredFacets, true)
    assert.deepEqual(assessment.missingFacets, [])

    const syntheticFinding = {
      finding_id: 'finding-positive-control-max-age',
      question_id: q3.question_id,
      assertion_text: 'Both sources document max-age for static assets.',
      assertion_kind: 'source_observation' as const,
      passage_ids: gL2CompleteMaxAgePositivePassages.map((p) => p.passage_id),
      source_integrity: 'valid' as const,
      created_at: REVIEWED_AT,
      semantic_support: {
        status: 'supported' as const,
        reviewer: 'research-v2-semantic-review',
        reviewer_version: '0.1.0-offline',
        rationale: 'positive control',
        reviewed_at: REVIEWED_AT,
      },
      question_coverage: {
        status: 'answers' as const,
        reviewer: 'research-v2-semantic-review',
        reviewer_version: '0.1.0-question-coverage',
        rationale: 'positive control',
        reviewed_at: REVIEWED_AT,
      },
    }
    const bound = enforceBoundQuestionCoverageOnFindings([syntheticFinding], {
      plan: subset.plan_revision,
      passages: gL2CompleteMaxAgePositivePassages,
      sources: gL2CompleteMaxAgePositiveSources,
      sourceRevisions: gL2CompleteMaxAgePositiveRevisions,
      reviewedAt: REVIEWED_AT,
    })
    assert.equal(bound[0]?.question_coverage?.status, 'answers')
  })
})
