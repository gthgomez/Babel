/**
 * Bounded negatives for production obligation_coverage host bound (5d822856 wiring).
 * Uses planner + slot stamping; does not decorate fixtures with manual plan rows.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { ResearchMissionV2Schema } from '../contracts/mission.js'
import type { FindingRecord } from '../contracts/findings.js'
import { applySemanticSupportReview } from './findingsFromModelOutput.js'
import { assessObligationCoverageHostBound } from './obligationCoverageHostBound.js'
import { buildPlanRevisionFromPlanQuestions } from './planFromModelOutput.js'
import {
  missionCoverageSourceSlots,
  stampCoverageSourceSlotOnSource,
} from './missionCoverageSourceSlots.js'
import { passageSupportsObligationCompleteness } from './planCoverageObligations.js'
import { questionIdsWithAnsweredCoverage } from './researchReportFinalization.js'
import {
  gL2OriginalDerivedFindingQ3Positive,
  gL2OriginalDerivedFindingQ4Positive,
  gL2OriginalDerivedPassages,
  gL2OriginalDerivedPlan,
  gL2OriginalDerivedRevisions,
  gL2OriginalDerivedSources,
  gL2PositiveControlModelReview,
} from './testSupport/gL2OriginalDerivedRegression.js'

const gL2MissionPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '../fixtures/campaign/G-L2-mission.json',
)

function loadGL2Mission() {
  return ResearchMissionV2Schema.parse(JSON.parse(readFileSync(gL2MissionPath, 'utf8')))
}

function productionPlanQ3Only(mission: ReturnType<typeof loadGL2Mission>) {
  const q3Row = gL2OriginalDerivedPlan.questions[0]!
  return buildPlanRevisionFromPlanQuestions({
    mission,
    planRevisionId: 'plan-integrity-q3',
    revisionReason: 'model_plan_questions',
    createdAt: '2026-10-21T12:00:00.000Z',
    modelOutput: {
      kind: 'plan_questions',
      questions: [
        {
          text: q3Row.text,
          importance: q3Row.importance,
          coverage_obligations: [
            {
              obligation_id: 'ob-mdn-max-age-semantics',
              source_slot: 'web-ref-0',
              aspect: 'technical_effect',
              technical_effect: 'max_age_or_ttl_semantics',
            },
            {
              obligation_id: 'ob-cf-max-age-semantics',
              source_slot: 'web-ref-1',
              aspect: 'technical_effect',
              technical_effect: 'max_age_or_ttl_semantics',
            },
          ],
        },
      ],
    },
  })
}

function productionSources(mission: ReturnType<typeof loadGL2Mission>) {
  const slots = missionCoverageSourceSlots(mission)
  return gL2OriginalDerivedSources.map((source, index) =>
    stampCoverageSourceSlotOnSource(source, slots[index]!),
  )
}

function withQuestionId(finding: FindingRecord, questionId: string): FindingRecord {
  return { ...finding, question_id: questionId }
}

describe('G-L2 obligation_coverage judgment integrity (production wiring)', () => {
  const mission = loadGL2Mission()
  const plan = productionPlanQ3Only(mission)
  const sources = productionSources(mission)
  const q3Id = plan.questions[0]!.question_id
  const baseFinding = withQuestionId(gL2OriginalDerivedFindingQ3Positive, q3Id)

  function reviewWithObligationCoverage(
    obligation_coverage: Record<string, unknown>[],
  ): FindingRecord[] {
    return applySemanticSupportReview(
      [baseFinding],
      {
        kind: 'semantic_support_review',
        judgments: [
          {
            finding_id: baseFinding.finding_id,
            status: 'supported',
            rationale: 'model claims answers',
            question_coverage: 'answers',
            obligation_coverage,
          },
        ],
      },
      '2026-10-21T12:10:00.000Z',
      {
        plan,
        passages: gL2OriginalDerivedPassages,
        sources,
        sourceRevisions: gL2OriginalDerivedRevisions,
      },
    )
  }

  it('downgrades answers when met judgment cites absent passage id (valid + DOES-NOT-EXIST)', () => {
    const reviewed = reviewWithObligationCoverage([
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
    ])
    assert.equal(reviewed[0]?.question_coverage?.status, 'partial')
    assert.match(reviewed[0]?.question_coverage?.rationale ?? '', /absent_passage_id:DOES-NOT-EXIST/)
    assert.deepEqual(questionIdsWithAnsweredCoverage(reviewed), new Set())
  })

  it('downgrades answers when duplicate obligation_id rows disagree (met then unmet)', () => {
    const reviewed = reviewWithObligationCoverage([
      {
        obligation_id: 'ob-mdn-max-age-semantics',
        status: 'met',
        supporting_passage_ids: ['fetch-mdn-original-derived:html:max-age'],
      },
      {
        obligation_id: 'ob-mdn-max-age-semantics',
        status: 'unmet',
      },
      {
        obligation_id: 'ob-cf-max-age-semantics',
        status: 'met',
        supporting_passage_ids: ['fetch-cf-original-derived:html:max-age'],
      },
    ])
    assert.equal(reviewed[0]?.question_coverage?.status, 'partial')
    assert.match(
      reviewed[0]?.question_coverage?.rationale ?? '',
      /duplicate_obligation_id:ob-mdn-max-age-semantics/,
    )
  })

  it('downgrades answers when judgment references unknown obligation_id', () => {
    const reviewed = reviewWithObligationCoverage([
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
      {
        obligation_id: 'ob-UNKNOWN-obligation',
        status: 'met',
        supporting_passage_ids: ['fetch-mdn-original-derived:html:max-age'],
      },
    ])
    assert.equal(reviewed[0]?.question_coverage?.status, 'partial')
    assert.match(
      reviewed[0]?.question_coverage?.rationale ?? '',
      /unknown_obligation_id:ob-UNKNOWN-obligation/,
    )
  })

  it('downgrades answers when supporting passage is foreign to finding.passage_ids', () => {
    const reviewed = reviewWithObligationCoverage([
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
    ])
    assert.equal(reviewed[0]?.question_coverage?.status, 'partial')
    assert.match(
      reviewed[0]?.question_coverage?.rationale ?? '',
      /foreign_passage_id:fetch-mdn-original-derived:html:overview/,
    )
  })

  it('keeps complete positive control when judgments and passage ids are valid', () => {
    const fullPlan = buildPlanRevisionFromPlanQuestions({
      mission,
      planRevisionId: 'plan-positive-integrity',
      revisionReason: 'model_plan_questions',
      createdAt: '2026-10-21T12:00:00.000Z',
      modelOutput: {
        kind: 'plan_questions',
        questions: gL2OriginalDerivedPlan.questions.map((q) => ({
          text: q.text,
          importance: q.importance,
          coverage_obligations: q.coverage_obligations?.map((o) => ({
            ...o,
            source_slot: o.source_slot === 'comparison_mdn' ? 'web-ref-0' : 'web-ref-1',
          })),
        })),
      },
    })
    const reviewed = applySemanticSupportReview(
      [
        withQuestionId(gL2OriginalDerivedFindingQ3Positive, fullPlan.questions[0]!.question_id),
        withQuestionId(gL2OriginalDerivedFindingQ4Positive, fullPlan.questions[1]!.question_id),
      ],
      gL2PositiveControlModelReview(),
      '2026-10-21T12:11:00.000Z',
      {
        plan: fullPlan,
        passages: gL2OriginalDerivedPassages,
        sources,
        sourceRevisions: gL2OriginalDerivedRevisions,
      },
    )
    assert.deepEqual(
      questionIdsWithAnsweredCoverage(reviewed),
      new Set([fullPlan.questions[0]!.question_id, fullPlan.questions[1]!.question_id]),
    )
  })

  it('documents host bound still applies passageSupportsObligationCompleteness regex (A replaces with semantic judgments)', () => {
    const overviewPassage = gL2OriginalDerivedPassages.find(
      (p) => p.passage_id === 'fetch-mdn-original-derived:html:overview',
    )
    assert.ok(overviewPassage)
    const text =
      overviewPassage.text_ref.mode === 'inline' ? overviewPassage.text_ref.text : ''
    assert.equal(
      passageSupportsObligationCompleteness(text, {
        obligation_id: 'ob-mdn-max-age-semantics',
        source_slot: 'web-ref-0',
        aspect: 'technical_effect',
        technical_effect: 'max_age_or_ttl_semantics',
      }),
      false,
    )
    const question = plan.questions[0]!
    const passageById = new Map(gL2OriginalDerivedPassages.map((p) => [p.passage_id, p]))
    const provenanceIndex = new Map(
      gL2OriginalDerivedRevisions.map((revision) => {
        const source = sources.find((s) => s.source_id === revision.source_id)!
        return [revision.revision_id, { source, revision }]
      }),
    )
    const onlyOverview = assessObligationCoverageHostBound(
      question,
      {
        ...baseFinding,
        passage_ids: [
          'fetch-mdn-original-derived:html:overview',
          'fetch-cf-original-derived:html:max-age',
        ],
        plan_obligation_coverage: [
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
      { passageById, provenanceIndex },
    )
    assert.equal(onlyOverview.satisfiesRequiredFacets, false)
    assert.ok(onlyOverview.missingFacets.includes('ob-mdn-max-age-semantics'))
  })
})
