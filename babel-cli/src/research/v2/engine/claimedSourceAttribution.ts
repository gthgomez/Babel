import type { FindingRecord } from '../contracts/findings.js'
import type { PassageRecord } from '../contracts/passages.js'
import type { PlanCoverageObligation } from '../contracts/plan.js'
import type { SourceRecord, SourceRevision } from '../contracts/sources.js'
import { buildRevisionProvenanceIndex } from './boundQuestionCoverageFromEvidence.js'
import { obligationsForQuestion } from './planCoverageObligations.js'

export const CLAIMED_SOURCE_ATTRIBUTION_REVIEWER = 'research-v2-claimed-source-attribution'
export const CLAIMED_SOURCE_ATTRIBUTION_REVIEWER_VERSION = '0.1.0-host-bound'

export type ClaimedSourceAttributionStatus =
  | 'matches_admitted_citations'
  | 'names_unfetched_or_unread_source'
  | 'not_assessed'

function citedSlotsForFinding(
  finding: FindingRecord,
  passageById: ReadonlyMap<string, PassageRecord>,
  provenanceIndex: ReturnType<typeof buildRevisionProvenanceIndex>,
): Set<string> {
  const slots = new Set<string>()
  for (const passageId of finding.passage_ids) {
    const passage = passageById.get(passageId)
    if (!passage) continue
    const provenance = provenanceIndex.get(passage.source_revision_id)
    const slot = provenance?.source.coverage_source_slot
    if (slot) slots.add(slot)
  }
  return slots
}

function obligationMetClaimsUnsupportedSlot(
  finding: FindingRecord,
  obligation: PlanCoverageObligation,
  passageById: ReadonlyMap<string, PassageRecord>,
  provenanceIndex: ReturnType<typeof buildRevisionProvenanceIndex>,
): boolean {
  const judgment = finding.plan_obligation_coverage?.find(
    (row) => row.obligation_id === obligation.obligation_id,
  )
  if (!judgment || judgment.status !== 'met') {
    return false
  }
  const supportingIds = judgment.supporting_passage_ids ?? []
  if (supportingIds.length === 0) {
    return true
  }
  const citedSlots = citedSlotsForFinding(finding, passageById, provenanceIndex)
  for (const passageId of supportingIds) {
    const passage = passageById.get(passageId)
    if (!passage) return true
    const provenance = provenanceIndex.get(passage.source_revision_id)
    if (provenance?.source.coverage_source_slot === obligation.source_slot) {
      return false
    }
  }
  return !citedSlots.has(obligation.source_slot)
}

/**
 * Host bound: assertion_support must not remain `supported` when claimed sources name unread
 * slots or when `met` obligation rows cite passages from the wrong mission slot.
 */
export function enforceSemanticSupportClaimedSourceAttribution(
  findings: readonly FindingRecord[],
  params: {
    plan: import('../contracts/plan.js').PlanRevision
    passages: readonly PassageRecord[]
    sources: readonly SourceRecord[]
    sourceRevisions: readonly SourceRevision[]
    reviewedAt: string
  },
): FindingRecord[] {
  const questionById = new Map(params.plan.questions.map((q) => [q.question_id, q]))
  const passageById = new Map(params.passages.map((p) => [p.passage_id, p]))
  const provenanceIndex = buildRevisionProvenanceIndex(params.sources, params.sourceRevisions)

  return findings.map((finding) => {
    const support = finding.semantic_support?.status
    if (support !== 'supported') {
      return finding
    }
    const question = questionById.get(finding.question_id)
    const obligations = question ? obligationsForQuestion(question) : []

    const claimedStatus = finding.claimed_source_attribution?.status
    if (claimedStatus === 'names_unfetched_or_unread_source') {
      return downgradeAssertionSupport(finding, params.reviewedAt, {
        reason:
          'Host claimed-source attribution: model reported names_unfetched_or_unread_source; assertion_support downgraded from supported.',
      })
    }

    for (const obligation of obligations) {
      if (
        obligationMetClaimsUnsupportedSlot(finding, obligation, passageById, provenanceIndex)
      ) {
        return downgradeAssertionSupport(finding, params.reviewedAt, {
          reason: `Host claimed-source attribution: obligation ${obligation.obligation_id} marked met without admitted passage from source_slot ${obligation.source_slot}.`,
        })
      }
    }

    return finding
  })
}

function downgradeAssertionSupport(
  finding: FindingRecord,
  reviewedAt: string,
  params: { reason: string },
): FindingRecord {
  const prior = finding.semantic_support?.rationale ?? ''
  return {
    ...finding,
    semantic_support: {
      status: 'insufficient',
      reviewer: CLAIMED_SOURCE_ATTRIBUTION_REVIEWER,
      reviewer_version: CLAIMED_SOURCE_ATTRIBUTION_REVIEWER_VERSION,
      rationale: `${prior} ${params.reason}`.trim(),
      reviewed_at: reviewedAt,
    },
    revised_at: reviewedAt,
  }
}

export function passageRecordsWithSourceAttribution(
  passages: readonly PassageRecord[],
  sources: readonly SourceRecord[],
  sourceRevisions: readonly SourceRevision[],
): Array<{
  passage_id: string
  text: string
  source_attribution: {
    coverage_source_slot?: string
    fetched_url?: string
    fetched_title?: string
    revision_completeness?: string
  }
}> {
  const provenanceIndex = buildRevisionProvenanceIndex(sources, sourceRevisions)
  return passages.map((passage) => {
    const text = passage.text_ref.mode === 'inline' ? passage.text_ref.text : ''
    const provenance = provenanceIndex.get(passage.source_revision_id)
    const primaryUrl = provenance?.source.observed_urls[0]
    const title =
      typeof provenance?.source.title === 'string' ? provenance.source.title : undefined
    return {
      passage_id: passage.passage_id,
      text,
      source_attribution: {
        ...(provenance?.source.coverage_source_slot
          ? { coverage_source_slot: provenance.source.coverage_source_slot }
          : {}),
        ...(primaryUrl ? { fetched_url: primaryUrl } : {}),
        ...(title ? { fetched_title: title } : {}),
        ...(provenance?.revision.completeness
          ? { revision_completeness: provenance.revision.completeness }
          : {}),
      },
    }
  })
}
