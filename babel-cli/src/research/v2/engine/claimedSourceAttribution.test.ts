import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { applySemanticSupportReview } from './findingsFromModelOutput.js'
import {
  gL3OriginalDerivedFindingFalseAgreement,
  gL3OriginalDerivedFindingSingleSource,
  gL3FalseAgreementModelReview,
  gL3OriginalDerivedPassages,
  gL3OriginalDerivedPlan,
  gL3OriginalDerivedRevisions,
  gL3OriginalDerivedSources,
} from './testSupport/gL3OriginalDerivedRegression.js'

describe('claimed source attribution host bound', () => {
  it('downgrades assertion_support when cross-source met obligations cite wrong slot', () => {
    const reviewed = applySemanticSupportReview(
      [gL3OriginalDerivedFindingFalseAgreement],
      gL3FalseAgreementModelReview(),
      '2026-10-21T14:20:00.000Z',
      {
        plan: gL3OriginalDerivedPlan,
        passages: gL3OriginalDerivedPassages,
        sources: gL3OriginalDerivedSources,
        sourceRevisions: gL3OriginalDerivedRevisions,
      },
    )
    assert.equal(reviewed[0]?.semantic_support?.status, 'insufficient')
    assert.equal(reviewed[0]?.question_coverage?.status, 'partial')
  })

  it('preserves supported single-source observation on downloads-only admission', () => {
    const reviewed = applySemanticSupportReview(
      [gL3OriginalDerivedFindingSingleSource],
      {
        kind: 'semantic_support_review',
        judgments: [
          {
            finding_id: gL3OriginalDerivedFindingSingleSource.finding_id,
            status: 'supported',
            rationale: 'Link label present in admitted downloads excerpt.',
            question_coverage: 'partial',
            claimed_source_attribution: 'matches_admitted_citations',
            obligation_coverage: [
              {
                obligation_id: 'ob-downloads-stable-version-date',
                status: 'met',
                supporting_passage_ids: ['fetch-downloads-original-derived:html:4'],
              },
              {
                obligation_id: 'ob-devguide-stable-version-date',
                status: 'unmet',
              },
            ],
          },
        ],
      },
      '2026-10-21T14:20:00.000Z',
      {
        plan: gL3OriginalDerivedPlan,
        passages: gL3OriginalDerivedPassages,
        sources: gL3OriginalDerivedSources,
        sourceRevisions: gL3OriginalDerivedRevisions,
      },
    )
    assert.equal(reviewed[0]?.semantic_support?.status, 'supported')
    assert.equal(reviewed[0]?.claimed_source_attribution?.status, 'matches_admitted_citations')
  })
})
