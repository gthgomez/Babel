import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  assessBoundQuestionCoverageFromAdmittedEvidence,
  buildRevisionProvenanceIndex,
  citedPassageEvidenceSignals,
  inferQuestionCoverageProfile,
} from './boundQuestionCoverageFromEvidence.js'
import {
  gL2AuditDerivedPassages,
  gL2AuditDerivedPlan,
  gL2AuditDerivedRevisions,
  gL2AuditDerivedSources,
} from './testSupport/gL2AuditDerivedRegression.js'

describe('boundQuestionCoverageFromEvidence', () => {
  it('classifies q3 as cross-source max-age comparison', () => {
    const q3 = gL2AuditDerivedPlan.questions[0]!
    const profile = inferQuestionCoverageProfile(q3.text, q3.evidence_requirement)
    assert.equal(profile.crossSourceComparison, true)
    assert.equal(profile.aspect, 'cache_control_max_age')
  })

  it('classifies q4 as audience intent (distinct from cache directives)', () => {
    const q4 = gL2AuditDerivedPlan.questions[1]!
    const profile = inferQuestionCoverageProfile(q4.text, q4.evidence_requirement)
    assert.equal(profile.aspect, 'audience_browser_vs_edge')
  })

  it('flags missing MDN max-age facet for derived q3 citations', () => {
    const index = buildRevisionProvenanceIndex(gL2AuditDerivedSources, gL2AuditDerivedRevisions)
    const signals = gL2AuditDerivedPassages.map((p) =>
      citedPassageEvidenceSignals(p, index.get(p.source_revision_id)),
    )
    const q3 = gL2AuditDerivedPlan.questions[0]!
    const profile = inferQuestionCoverageProfile(q3.text, q3.evidence_requirement)
    const assessment = assessBoundQuestionCoverageFromAdmittedEvidence(profile, signals)
    assert.equal(assessment.satisfiesRequiredFacets, false)
    assert.ok(assessment.missingFacets.includes('mdn_max_age_relevant_evidence'))
  })
})
