import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { validateSemanticObligationCoverageResponse } from './semanticObligationCoverageValidation.js'
import { applySemanticSupportReview } from './findingsFromModelOutput.js'
import { requiredClaimedSourceReviewFields } from './testSupport/requiredClaimedSourceReviewFields.js'
import {
  gL2OriginalDerivedFindingQ3Positive,
  gL2OriginalDerivedPassages,
  gL2OriginalDerivedPlan,
  gL2OriginalDerivedRevisions,
  gL2OriginalDerivedSources,
} from './testSupport/gL2OriginalDerivedRegression.js'

const planObligations = gL2OriginalDerivedPlan.questions.find(
  (q) => q.question_id === 'q-g-l2-audit-3',
)!.coverage_obligations!

const admitted = new Set(gL2OriginalDerivedPassages.map((p) => p.passage_id))

describe('validateSemanticObligationCoverageResponse', () => {
  it('accepts valid complete obligation_coverage with cited passages only', () => {
    const result = validateSemanticObligationCoverageResponse(
      [
        {
          obligation_id: 'ob-mdn-max-age-semantics',
          status: 'met',
          supporting_passage_ids: ['fetch-mdn-original-derived:html:max-age'],
        },
        {
          obligation_id: 'ob-cf-max-age-semantics',
          status: 'met',
          supporting_passage_ids: ['fetch-cf-original-derived:html:max-age'],
        },
      ],
      {
        planObligations,
        findingPassageIds: [
          'fetch-mdn-original-derived:html:max-age',
          'fetch-cf-original-derived:html:max-age',
        ],
        admittedPassageIds: admitted,
      },
    )
    assert.equal(result.valid, true)
    if (result.valid) {
      assert.equal(result.records.length, 2)
    }
  })

  it('rejects unknown passage_id (DOES-NOT-EXIST) before filtering', () => {
    const result = validateSemanticObligationCoverageResponse(
      [
        {
          obligation_id: 'ob-mdn-max-age-semantics',
          status: 'met',
          supporting_passage_ids: [
            'fetch-mdn-original-derived:html:max-age',
            'DOES-NOT-EXIST',
          ],
        },
        {
          obligation_id: 'ob-cf-max-age-semantics',
          status: 'met',
          supporting_passage_ids: ['fetch-cf-original-derived:html:max-age'],
        },
      ],
      {
        planObligations,
        findingPassageIds: [
          'fetch-mdn-original-derived:html:max-age',
          'fetch-cf-original-derived:html:max-age',
        ],
        admittedPassageIds: admitted,
      },
    )
    assert.equal(result.valid, false)
    if (!result.valid) {
      assert.equal(result.violation, 'absent_passage_id')
    }
  })

  it('rejects duplicate obligation_id judgments in one response', () => {
    const result = validateSemanticObligationCoverageResponse(
      [
        {
          obligation_id: 'ob-mdn-max-age-semantics',
          status: 'met',
          supporting_passage_ids: ['fetch-mdn-original-derived:html:max-age'],
        },
        {
          obligation_id: 'ob-mdn-max-age-semantics',
          status: 'unmet',
        },
      ],
      {
        planObligations,
        findingPassageIds: ['fetch-mdn-original-derived:html:max-age'],
        admittedPassageIds: admitted,
      },
    )
    assert.equal(result.valid, false)
    if (!result.valid) {
      assert.equal(result.violation, 'duplicate_obligation_id')
    }
  })

  it('rejects unknown obligation_id (UNKNOWN)', () => {
    const result = validateSemanticObligationCoverageResponse(
      [
        {
          obligation_id: 'ob-mdn-max-age-semantics',
          status: 'met',
          supporting_passage_ids: ['fetch-mdn-original-derived:html:max-age'],
        },
        {
          obligation_id: 'UNKNOWN-OBLIGATION',
          status: 'met',
          supporting_passage_ids: ['fetch-cf-original-derived:html:max-age'],
        },
      ],
      {
        planObligations,
        findingPassageIds: [
          'fetch-mdn-original-derived:html:max-age',
          'fetch-cf-original-derived:html:max-age',
        ],
        admittedPassageIds: admitted,
      },
    )
    assert.equal(result.valid, false)
    if (!result.valid) {
      assert.equal(result.violation, 'unknown_obligation_id')
    }
  })
})

describe('applySemanticSupportReview obligation_coverage response validation', () => {
  it('downgrades answers to partial when response cites unknown passage_id', () => {
    const reviewed = applySemanticSupportReview(
      [gL2OriginalDerivedFindingQ3Positive],
      {
        kind: 'semantic_support_review',
        judgments: [
          {
            finding_id: gL2OriginalDerivedFindingQ3Positive.finding_id,
            status: 'supported',
            rationale: 'model claims complete coverage',
            question_coverage: 'answers',
            ...requiredClaimedSourceReviewFields(['comparison_mdn', 'comparison_cloudflare']),
            obligation_coverage: [
              {
                obligation_id: 'ob-mdn-max-age-semantics',
                status: 'met',
                supporting_passage_ids: [
                  'fetch-mdn-original-derived:html:max-age',
                  'DOES-NOT-EXIST',
                ],
              },
              {
                obligation_id: 'ob-cf-max-age-semantics',
                status: 'met',
                supporting_passage_ids: ['fetch-cf-original-derived:html:max-age'],
              },
            ],
          },
        ],
      },
      '2026-10-21T12:10:00.000Z',
      {
        plan: gL2OriginalDerivedPlan,
        passages: gL2OriginalDerivedPassages,
        sources: gL2OriginalDerivedSources,
        sourceRevisions: gL2OriginalDerivedRevisions,
        missionSourceSlots: [
          { source_slot: 'comparison_mdn', fetch_status: 'admitted_fetched' },
          { source_slot: 'comparison_cloudflare', fetch_status: 'admitted_fetched' },
        ],
      },
    )
    assert.equal(reviewed[0]?.question_coverage?.status, 'partial')
    assert.match(reviewed[0]?.question_coverage?.rationale ?? '', /absent_passage_id:DOES-NOT-EXIST/)
    assert.equal(reviewed[0]?.plan_obligation_coverage, undefined)
  })
})
