import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  assessBoundQuestionCoverageFromAdmittedEvidence,
  buildRevisionProvenanceIndex,
  citedPassageEvidenceSignals,
  enforceBoundQuestionCoverageOnFindings,
} from './boundQuestionCoverageFromEvidence.js'
import { applySemanticSupportReview } from './findingsFromModelOutput.js'
import { requiredClaimedSourceReviewFields } from './testSupport/requiredClaimedSourceReviewFields.js'
import {
  gL2FixtureMissionSourceSlots,
  gL2OriginalDerivedFindingQ3_7f3,
  gL2OriginalDerivedPassages,
  gL2OriginalDerivedPlan,
  gL2OriginalDerivedRevisions,
  gL2OriginalDerivedSources,
  gL2OriginalDerivedFindingQ3Positive,
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

  it('rejects model met claims when host completeness fails (7f3 replay)', () => {
    const index = buildRevisionProvenanceIndex(gL2OriginalDerivedSources, gL2OriginalDerivedRevisions)
    const passageById = new Map(gL2OriginalDerivedPassages.map((p) => [p.passage_id, p]))
    const q3 = gL2OriginalDerivedPlan.questions.find((q) => q.question_id === 'q-g-l2-audit-3')!
    const reviewed = applySemanticSupportReview(
      [gL2OriginalDerivedFindingQ3_7f3],
      {
        kind: 'semantic_support_review',
        judgments: [
          {
            finding_id: gL2OriginalDerivedFindingQ3_7f3.finding_id,
            status: 'supported',
            rationale: 'model claims met',
            question_coverage: 'answers',
            ...requiredClaimedSourceReviewFields(['comparison_mdn', 'comparison_cloudflare']),
            obligation_coverage: [
              {
                obligation_id: 'ob-mdn-max-age-semantics',
                status: 'met',
                supporting_passage_ids: ['fetch-mdn-original-derived:html:overview'],
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
      '2026-10-21T12:00:00.000Z',
      {
        plan: gL2OriginalDerivedPlan,
        passages: gL2OriginalDerivedPassages,
        sources: gL2OriginalDerivedSources,
        sourceRevisions: gL2OriginalDerivedRevisions,
        missionSourceSlots: gL2FixtureMissionSourceSlots,
      },
    )
    assert.equal(reviewed[0]?.question_coverage?.status, 'partial')
    const assessment = assessBoundQuestionCoverageFromAdmittedEvidence(q3, reviewed[0]!, {
      passageById,
      provenanceIndex: index,
    })
    assert.equal(assessment.satisfiesRequiredFacets, false)
    assert.ok(assessment.missingFacets.includes('ob-mdn-max-age-semantics'))
  })

  it('accepts positive control when obligation judgments and slots align', () => {
    const reviewed = applySemanticSupportReview(
      [gL2OriginalDerivedFindingQ3Positive],
      {
        kind: 'semantic_support_review',
        judgments: [
          {
            finding_id: gL2OriginalDerivedFindingQ3Positive.finding_id,
            status: 'supported',
            rationale: 'Both slots document max-age semantics in admitted excerpts.',
            question_coverage: 'answers',
            ...requiredClaimedSourceReviewFields(['comparison_mdn', 'comparison_cloudflare']),
            obligation_coverage: [
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
          },
        ],
      },
      '2026-10-21T12:00:01.000Z',
      {
        plan: gL2OriginalDerivedPlan,
        passages: gL2OriginalDerivedPassages,
        sources: gL2OriginalDerivedSources,
        sourceRevisions: gL2OriginalDerivedRevisions,
        missionSourceSlots: gL2FixtureMissionSourceSlots,
      },
    )
    assert.equal(reviewed[0]?.question_coverage?.status, 'answers')
  })

  it('downgrades model answers when plan question has no coverage_obligations', () => {
    const plan = {
      ...gL2OriginalDerivedPlan,
      questions: [
        {
          ...gL2OriginalDerivedPlan.questions[0]!,
          question_id: 'q-legacy',
          coverage_obligations: undefined,
        },
      ],
    }
    const finding = { ...gL2OriginalDerivedFindingQ3_7f3, question_id: 'q-legacy' }
    const enforced = enforceBoundQuestionCoverageOnFindings(
      [
        {
          ...finding,
          semantic_support: {
            status: 'supported',
            reviewer: 't',
            reviewer_version: 't',
            rationale: 'x',
            reviewed_at: '2026-10-21T12:00:00.000Z',
          },
          question_coverage: {
            status: 'answers',
            reviewer: 't',
            reviewer_version: 't',
            rationale: 'x',
            reviewed_at: '2026-10-21T12:00:00.000Z',
          },
        },
      ],
      {
        plan,
        passages: gL2OriginalDerivedPassages,
        sources: gL2OriginalDerivedSources,
        sourceRevisions: gL2OriginalDerivedRevisions,
        reviewedAt: '2026-10-21T12:00:02.000Z',
      },
    )
    assert.equal(enforced[0]?.question_coverage?.status, 'partial')
  })
})
