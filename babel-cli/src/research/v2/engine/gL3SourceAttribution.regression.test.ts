import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import type { FindingRecord } from '../contracts/findings.js'
import { ResearchMissionV2Schema } from '../contracts/mission.js'
import { applySemanticSupportReview } from './findingsFromModelOutput.js'
import { buildSemanticSupportReviewInput } from './buildSemanticSupportReviewInput.js'
import { assessObligationCoverageHostBound } from './obligationCoverageHostBound.js'
import {
  gL3FalseAgreementModelReview,
  gL3InsufficientHonestModelReview,
  gL3OriginalDerivedFindingFalseAgreement,
  gL3OriginalDerivedFindingInsufficientHonest,
  gL3OriginalDerivedPassages,
  gL3OriginalDerivedPlan,
  gL3OriginalDerivedRevisions,
  gL3OriginalDerivedSources,
} from './testSupport/gL3OriginalDerivedRegression.js'

const gL3Mission = ResearchMissionV2Schema.parse(
  JSON.parse(
    readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../fixtures/campaign/G-L3-mission.json'),
      'utf8',
    ),
  ),
)

describe('G-L3 source attribution regression (original-derived)', () => {
  const question = gL3OriginalDerivedPlan.questions[0]!
  const passageById = new Map(gL3OriginalDerivedPassages.map((p) => [p.passage_id, p]))
  const provenanceIndex = new Map(
    gL3OriginalDerivedRevisions.map((revision) => {
      const source = gL3OriginalDerivedSources.find((s) => s.source_id === revision.source_id)!
      return [revision.revision_id, { source, revision }]
    }),
  )

  it('semantic review input carries slot fetch status and link-only signals', () => {
    const input = buildSemanticSupportReviewInput(
      [gL3OriginalDerivedFindingFalseAgreement],
      gL3OriginalDerivedPassages,
      gL3OriginalDerivedPlan,
      {
        sources: gL3OriginalDerivedSources,
        sourceRevisions: gL3OriginalDerivedRevisions,
        mission: gL3Mission,
      },
    )
    assert.ok(input.mission_source_slots)
    const slots = input.mission_source_slots!
    assert.equal(slots.length, 2)
    assert.equal(slots[0]?.fetch_status, 'admitted_fetched')
    assert.equal(slots[1]?.fetch_status, 'fetch_failed_or_missing')
    const cited = input.findings[0]?.cited_passages[0]
    assert.ok(cited && cited.content_status === 'available')
    assert.deepEqual(cited.references_unfetched_slot_urls, ['web-ref-1'])
    assert.equal(cited.source_attribution?.coverage_source_slot, 'web-ref-0')
  })

  it('host bound rejects false cross-page agreement when devguide slot unfetched', () => {
    const reviewed = applySemanticSupportReview(
      [gL3OriginalDerivedFindingFalseAgreement],
      gL3FalseAgreementModelReview(),
      '2026-10-21T13:01:00.000Z',
      {
        plan: gL3OriginalDerivedPlan,
        passages: gL3OriginalDerivedPassages,
        sources: gL3OriginalDerivedSources,
        sourceRevisions: gL3OriginalDerivedRevisions,
      },
    )
    const finding = reviewed[0]!
    assert.equal(finding.semantic_support?.status, 'supported')
    assert.equal(finding.question_coverage?.status, 'partial')
    assert.match(finding.question_coverage?.rationale ?? '', /Host bound-question coverage/)
  })

  it('host bound preserves honest partial when devguide obligation unmet', () => {
    const reviewed = applySemanticSupportReview(
      [gL3OriginalDerivedFindingInsufficientHonest],
      gL3InsufficientHonestModelReview(),
      '2026-10-21T13:01:00.000Z',
      {
        plan: gL3OriginalDerivedPlan,
        passages: gL3OriginalDerivedPassages,
        sources: gL3OriginalDerivedSources,
        sourceRevisions: gL3OriginalDerivedRevisions,
      },
    )
    assert.equal(reviewed[0]?.question_coverage?.status, 'partial')
  })

  it('obligation host bound fails devguide met claim without admitted slot fetch', () => {
    const finding: FindingRecord = {
      ...gL3OriginalDerivedFindingFalseAgreement,
      plan_obligation_coverage: [
        {
          obligation_id: 'ob-downloads-stable-version-date',
          status: 'met',
          supporting_passage_ids: ['fetch-downloads-original-derived:html:4'],
        },
        {
          obligation_id: 'ob-devguide-stable-version-date',
          status: 'met',
          supporting_passage_ids: ['fetch-downloads-original-derived:html:4'],
        },
      ],
      semantic_support: {
        status: 'supported',
        reviewer: 'test',
        reviewer_version: '0',
        rationale: 'x',
        reviewed_at: '2026-10-21T13:00:00.000Z',
      },
      question_coverage: {
        status: 'answers',
        reviewer: 'test',
        reviewer_version: '0',
        rationale: 'x',
        reviewed_at: '2026-10-21T13:00:00.000Z',
      },
    }
    const assessment = assessObligationCoverageHostBound(question, finding, {
      passageById,
      provenanceIndex,
    })
    assert.equal(assessment.satisfiesRequiredFacets, false)
    assert.ok(assessment.missingFacets.includes('ob-devguide-stable-version-date'))
  })
})
