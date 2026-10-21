import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseValidatedModelOutput, SemanticSupportReviewOutputSchema } from '../contracts/modelOutputs.js'
import { buildSynthesizeReportModelInput } from './buildSynthesizeReportModelInput.js'
import { applySemanticSupportReview } from './findingsFromModelOutput.js'
import { requiredClaimedSourceReviewFields } from './testSupport/requiredClaimedSourceReviewFields.js'
import {
  gL3Ba45FindingDownloadsOnly,
  gL3Ba45FindingFalseDevguideClaim,
  gL3Ba45HistoricalFindings,
  gL3Ba45ReviewContext,
  SYNTHETIC_REVIEW_LABEL,
} from './testSupport/gL3Ba45DerivedRegression.js'

function syntheticReviewFromHistorical(
  historical: typeof gL3Ba45HistoricalFindings,
  claimedSlotsForFinding: (findingId: string) => string[],
) {
  return {
    kind: 'semantic_support_review' as const,
    judgments: historical.map((row) => ({
      finding_id: row.finding_id,
      status: row.semantic_support?.status ?? 'not_checked',
      rationale: `[${SYNTHETIC_REVIEW_LABEL}] ${row.semantic_support?.rationale ?? 'derived replay'}`,
      question_coverage: row.question_coverage?.status ?? 'partial',
      ...requiredClaimedSourceReviewFields(
        claimedSlotsForFinding(row.finding_id),
        'matches_admitted_citations',
      ),
      ...(row.plan_obligation_coverage
        ? {
            obligation_coverage: row.plan_obligation_coverage.map((entry) => ({
              obligation_id: entry.obligation_id,
              status: entry.status,
              ...(entry.supporting_passage_ids
                ? { supporting_passage_ids: [...entry.supporting_passage_ids] }
                : {}),
            })),
          }
        : {}),
    })),
  }
}

describe('G-L3 ba45 derived claimed-source attribution (original evidence)', () => {
  const ctx = gL3Ba45ReviewContext()

  it('rejects semantic review output missing fresh claimed_source_attribution fields', () => {
    assert.throws(() =>
      SemanticSupportReviewOutputSchema.parse({
        kind: 'semantic_support_review',
        judgments: [
          {
            finding_id: gL3Ba45FindingDownloadsOnly.finding_id,
            status: 'supported',
            rationale: 'x',
            question_coverage: 'partial',
          },
        ],
      }),
    )
  })

  it('not_assessed attribution becomes effective insufficient', () => {
    const reviewed = applySemanticSupportReview(
      [gL3Ba45FindingDownloadsOnly],
      {
        kind: 'semantic_support_review',
        judgments: [
          {
            finding_id: gL3Ba45FindingDownloadsOnly.finding_id,
            status: 'supported',
            rationale: 'Synthetic not_assessed attribution probe.',
            question_coverage: 'partial',
            ...requiredClaimedSourceReviewFields(['web-ref-0'], 'not_assessed'),
            obligation_coverage: [
              {
                obligation_id: 'q1-oblig-web-ref-0',
                status: 'met',
                supporting_passage_ids: gL3Ba45FindingDownloadsOnly.passage_ids,
              },
              { obligation_id: 'q1-oblig-web-ref-1', status: 'unmet' },
            ],
          },
        ],
      },
      '2026-10-21T14:45:00.000Z',
      ctx,
    )
    assert.equal(reviewed[0]?.semantic_support?.status, 'insufficient')
    assert.match(reviewed[0]?.semantic_support?.rationale ?? '', /lacks assessed attribution/)
  })

  it('false devguide table claim with claimed [web-ref-1] becomes insufficient', () => {
    const reviewed = applySemanticSupportReview(
      [gL3Ba45FindingFalseDevguideClaim],
      {
        kind: 'semantic_support_review',
        judgments: [
          {
            finding_id: gL3Ba45FindingFalseDevguideClaim.finding_id,
            status: 'supported',
            rationale: 'Synthetic mis-attribution to unread devguide slot.',
            question_coverage: 'partial',
            ...requiredClaimedSourceReviewFields(['web-ref-1']),
            obligation_coverage: [
              {
                obligation_id: 'q1-oblig-web-ref-0',
                status: 'met',
                supporting_passage_ids: gL3Ba45FindingFalseDevguideClaim.passage_ids,
              },
              { obligation_id: 'q1-oblig-web-ref-1', status: 'unmet' },
            ],
          },
        ],
      },
      '2026-10-21T14:45:00.000Z',
      ctx,
    )
    assert.equal(reviewed[0]?.semantic_support?.status, 'insufficient')
    assert.match(
      reviewed[0]?.semantic_support?.rationale ?? '',
      /not resolved through cited passages/,
    )
    assert.equal(reviewed[0]?.question_coverage?.status, 'partial')
  })

  it('downloads-only positive with claimed [web-ref-0] stays supported with partial comparison coverage', () => {
    const reviewed = applySemanticSupportReview(
      [gL3Ba45FindingDownloadsOnly],
      {
        kind: 'semantic_support_review',
        judgments: [
          {
            finding_id: gL3Ba45FindingDownloadsOnly.finding_id,
            status: 'supported',
            rationale: 'Synthetic honest single-source attribution.',
            question_coverage: 'partial',
            ...requiredClaimedSourceReviewFields(['web-ref-0']),
            obligation_coverage: [
              {
                obligation_id: 'q1-oblig-web-ref-0',
                status: 'met',
                supporting_passage_ids: gL3Ba45FindingDownloadsOnly.passage_ids,
              },
              { obligation_id: 'q1-oblig-web-ref-1', status: 'unmet' },
            ],
          },
        ],
      },
      '2026-10-21T14:45:00.000Z',
      ctx,
    )
    assert.equal(reviewed[0]?.semantic_support?.status, 'supported')
    assert.equal(reviewed[0]?.question_coverage?.status, 'partial')
    assert.deepEqual(reviewed[0]?.claimed_source_attribution?.source_slots, ['web-ref-0'])
  })

  it('original G-L3 replay with uniform false [web-ref-0] slots shows model-semantic limit (seven supported)', () => {
    const extractBase = gL3Ba45HistoricalFindings.map((h) => ({
      finding_id: h.finding_id,
      question_id: h.question_id,
      assertion_text: h.assertion_text,
      assertion_kind: h.assertion_kind,
      passage_ids: h.passage_ids,
      source_integrity: h.source_integrity,
      created_at: h.created_at,
    }))
    // Deliberately false annotation: every finding gets [web-ref-0]; host scoped-source GO does not fix this.
    const modelOutput = syntheticReviewFromHistorical(gL3Ba45HistoricalFindings, () => ['web-ref-0'])
    parseValidatedModelOutput('semantic_support_review', modelOutput)
    const reviewed = applySemanticSupportReview(
      extractBase,
      modelOutput,
      '2026-10-21T14:45:00.000Z',
      ctx,
    )
    const supported = reviewed.filter((f) => f.semantic_support?.status === 'supported')
    assert.equal(supported.length, 7)
    const falseDevguide = reviewed.find(
      (f) => f.finding_id === gL3Ba45FindingFalseDevguideClaim.finding_id,
    )
    assert.equal(falseDevguide?.semantic_support?.status, 'supported')
  })

  it('synthesis input carries mission slots, passages, and per-finding attribution fields', () => {
    const reviewed = applySemanticSupportReview(
      [gL3Ba45FindingDownloadsOnly],
      {
        kind: 'semantic_support_review',
        judgments: [
          {
            finding_id: gL3Ba45FindingDownloadsOnly.finding_id,
            status: 'supported',
            rationale: 'Synthetic synthesis wiring probe.',
            question_coverage: 'partial',
            ...requiredClaimedSourceReviewFields(['web-ref-0']),
            obligation_coverage: [
              {
                obligation_id: 'q1-oblig-web-ref-0',
                status: 'met',
                supporting_passage_ids: gL3Ba45FindingDownloadsOnly.passage_ids,
              },
              { obligation_id: 'q1-oblig-web-ref-1', status: 'unmet' },
            ],
          },
        ],
      },
      '2026-10-21T14:45:00.000Z',
      ctx,
    )
    const input = buildSynthesizeReportModelInput(reviewed, {
      mission_source_slots: ctx.missionSourceSlots,
      passages: ctx.passages,
      sources: ctx.sources,
      sourceRevisions: ctx.sourceRevisions,
    })
    assert.equal(input.mission_source_slots?.length, 2)
    assert.equal(input.mission_source_slots?.[1]?.fetch_status, 'fetch_failed_or_missing')
    assert.ok(input.passages?.some((p) => p.passage_id.includes('html:4')))
    assert.deepEqual(input.findings[0]?.passage_ids, gL3Ba45FindingDownloadsOnly.passage_ids)
    assert.deepEqual(input.findings[0]?.claimed_source_slots, ['web-ref-0'])
  })
})
