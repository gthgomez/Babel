import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  assessBoundQuestionCoverageFromAdmittedEvidence,
  buildRevisionProvenanceIndex,
  citedPassageEvidenceSignals,
} from './boundQuestionCoverageFromEvidence.js'
import { buildCitedPassageProvenance } from './planCoverageObligations.js'
import {
  gL2OriginalDerivedFindingQ3_7f3,
  gL2OriginalDerivedPassages,
  gL2OriginalDerivedPlan,
  gL2OriginalDerivedRevisions,
  gL2OriginalDerivedSources,
} from './testSupport/gL2OriginalDerivedRegression.js'

describe('boundQuestionCoverageFromEvidence', () => {
  it('exposes neutral signals: Cache-Control without max-age TTL substance', () => {
    const index = buildRevisionProvenanceIndex(gL2OriginalDerivedSources, gL2OriginalDerivedRevisions)
    const mdnOverview = gL2OriginalDerivedPassages.find(
      (p) => p.passage_id === 'fetch-mdn-original-derived:html:overview',
    )!
    const signals = citedPassageEvidenceSignals(mdnOverview, index.get(mdnOverview.source_revision_id))
    assert.equal(signals.mentions_cache_control_header_only, true)
    assert.equal(signals.supports_max_age_or_ttl_semantics, false)
  })

  it('flags missing MDN max-age obligation for original-derived q3 citations (7f3 replay)', () => {
    const index = buildRevisionProvenanceIndex(gL2OriginalDerivedSources, gL2OriginalDerivedRevisions)
    const q3 = gL2OriginalDerivedPlan.questions.find((q) => q.question_id === 'q-g-l2-audit-3')!
    const cited = buildCitedPassageProvenance(
      gL2OriginalDerivedFindingQ3_7f3.passage_ids,
      new Map(gL2OriginalDerivedPassages.map((p) => [p.passage_id, p])),
      index,
    )
    const assessment = assessBoundQuestionCoverageFromAdmittedEvidence(q3, cited)
    assert.equal(assessment.satisfiesRequiredFacets, false)
    assert.ok(assessment.missingFacets.includes('ob-mdn-max-age-semantics'))
    assert.equal(assessment.wrongAspectEvidenceOnly, false)
  })

  it('satisfies q3 obligations for positive control citations', () => {
    const index = buildRevisionProvenanceIndex(gL2OriginalDerivedSources, gL2OriginalDerivedRevisions)
    const q3 = gL2OriginalDerivedPlan.questions.find((q) => q.question_id === 'q-g-l2-audit-3')!
    const cited = buildCitedPassageProvenance(
      ['fetch-cf-original-derived:html:max-age', 'fetch-mdn-original-derived:html:max-age'],
      new Map(gL2OriginalDerivedPassages.map((p) => [p.passage_id, p])),
      index,
    )
    const assessment = assessBoundQuestionCoverageFromAdmittedEvidence(q3, cited)
    assert.equal(assessment.satisfiesRequiredFacets, true)
    assert.deepEqual(assessment.missingFacets, [])
  })
})
