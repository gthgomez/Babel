import type { FindingRecord } from '../contracts/findings.js'
import type { PassageRecord } from '../contracts/passages.js'
import type { SourceRecord, SourceRevision } from '../contracts/sources.js'
import { buildRevisionProvenanceIndex } from './boundQuestionCoverageFromEvidence.js'
import {
  type MissionSourceSlotAttribution,
  revisionRepresentsAdmittedFetch,
} from './sourceAttributionContext.js'

export const CLAIMED_SOURCE_ATTRIBUTION_REVIEWER = 'research-v2-claimed-source-attribution'
export const CLAIMED_SOURCE_ATTRIBUTION_REVIEWER_VERSION = '0.2.0-slot-resolution'

export type ClaimedSourceAttributionStatus =
  | 'matches_admitted_citations'
  | 'names_unfetched_or_unread_source'
  | 'not_assessed'

function admittedSlotResolvedThroughCitedPassages(
  finding: FindingRecord,
  sourceSlot: string,
  passageById: ReadonlyMap<string, PassageRecord>,
  provenanceIndex: ReturnType<typeof buildRevisionProvenanceIndex>,
): boolean {
  for (const passageId of finding.passage_ids) {
    const passage = passageById.get(passageId)
    if (!passage) continue
    const provenance = provenanceIndex.get(passage.source_revision_id)
    if (provenance?.source.coverage_source_slot !== sourceSlot) continue
    if (!revisionRepresentsAdmittedFetch(provenance.revision)) continue
    if (passage.text_ref.mode !== 'inline') continue
    if (passage.text_ref.text.trim().length === 0) continue
    return true
  }
  return false
}

function slotKnownInMissionDirectory(
  sourceSlot: string,
  missionSourceSlots: readonly MissionSourceSlotAttribution[],
): boolean {
  return missionSourceSlots.some((row) => row.source_slot === sourceSlot)
}

/**
 * Host bound: effective assertion_support must not remain `supported` when attribution is
 * missing/not_assessed, when the model reports unread claimed sources, or when attributed
 * slots do not resolve through this finding's cited passages to admitted fetches.
 */
export function enforceSemanticSupportClaimedSourceAttribution(
  findings: readonly FindingRecord[],
  params: {
    passages: readonly PassageRecord[]
    sources: readonly SourceRecord[]
    sourceRevisions: readonly SourceRevision[]
    missionSourceSlots: readonly MissionSourceSlotAttribution[]
    reviewedAt: string
  },
): FindingRecord[] {
  const passageById = new Map(params.passages.map((p) => [p.passage_id, p]))
  const provenanceIndex = buildRevisionProvenanceIndex(params.sources, params.sourceRevisions)

  return findings.map((finding) => {
    const support = finding.semantic_support?.status
    if (support !== 'supported') {
      return finding
    }

    const attribution = finding.claimed_source_attribution
    if (!attribution || attribution.status === 'not_assessed') {
      return downgradeAssertionSupport(finding, params.reviewedAt, {
        reason:
          'Host claimed-source attribution: supported finding lacks assessed attribution; assertion_support treated as insufficient.',
      })
    }

    if (attribution.status === 'names_unfetched_or_unread_source') {
      return downgradeAssertionSupport(finding, params.reviewedAt, {
        reason:
          'Host claimed-source attribution: model reported names_unfetched_or_unread_source; assertion_support downgraded from supported.',
      })
    }

    const claimedSlots = attribution.source_slots ?? []
    if (claimedSlots.length === 0) {
      return downgradeAssertionSupport(finding, params.reviewedAt, {
        reason:
          'Host claimed-source attribution: matches_admitted_citations requires nonempty claimed source_slots.',
      })
    }
    const unique = new Set(claimedSlots)
    if (unique.size !== claimedSlots.length) {
      return downgradeAssertionSupport(finding, params.reviewedAt, {
        reason:
          'Host claimed-source attribution: claimed source_slots must be unique.',
      })
    }

    for (const slot of claimedSlots) {
      if (!slotKnownInMissionDirectory(slot, params.missionSourceSlots)) {
        return downgradeAssertionSupport(finding, params.reviewedAt, {
          reason: `Host claimed-source attribution: unknown claimed source_slot ${slot}.`,
        })
      }
      if (
        !admittedSlotResolvedThroughCitedPassages(
          finding,
          slot,
          passageById,
          provenanceIndex,
        )
      ) {
        return downgradeAssertionSupport(finding, params.reviewedAt, {
          reason: `Host claimed-source attribution: claimed source_slot ${slot} not resolved through cited passages to an admitted fetch.`,
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
