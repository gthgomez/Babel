import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { applySemanticSupportReview } from './findingsFromModelOutput.js'
import { requiredClaimedSourceReviewFields } from './testSupport/requiredClaimedSourceReviewFields.js'
import {
  gL3FalseAgreementModelReview,
  gL3OriginalDerivedFindingFalseAgreement,
  gL3OriginalDerivedFindingSingleSource,
  gL3OriginalDerivedReviewContext,
} from './testSupport/gL3OriginalDerivedRegression.js'

describe('claimed source attribution host bound', () => {
  const ctx = gL3OriginalDerivedReviewContext()

  it('downgrades assertion_support when claimed slots name unread devguide source', () => {
    const reviewed = applySemanticSupportReview(
      [gL3OriginalDerivedFindingFalseAgreement],
      gL3FalseAgreementModelReview(),
      '2026-10-21T14:20:00.000Z',
      ctx,
    )
    assert.equal(reviewed[0]?.semantic_support?.status, 'insufficient')
    assert.match(reviewed[0]?.semantic_support?.rationale ?? '', /not resolved through cited passages/)
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
            ...requiredClaimedSourceReviewFields(['web-ref-0']),
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
      ctx,
    )
    assert.equal(reviewed[0]?.semantic_support?.status, 'supported')
    assert.equal(reviewed[0]?.claimed_source_attribution?.status, 'matches_admitted_citations')
  })
})
