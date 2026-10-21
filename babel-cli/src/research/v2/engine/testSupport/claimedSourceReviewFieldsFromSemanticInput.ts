import type { MissionSourceSlotAttribution } from '../sourceAttributionContext.js'
import { requiredClaimedSourceReviewFields } from './requiredClaimedSourceReviewFields.js'

export interface SemanticReviewFindingInput {
  finding_id: string
  cited_passages: ReadonlyArray<{
    content_status: string
    source_attribution?: { coverage_source_slot?: string }
  }>
}

/** Mirror host-visible admitted citation slots for offline semantic review fixtures. */
export function claimedSourceReviewFieldsFromSemanticInput(
  finding: SemanticReviewFindingInput,
  missionSourceSlots?: readonly MissionSourceSlotAttribution[],
): ReturnType<typeof requiredClaimedSourceReviewFields> {
  const fromCitations: string[] = []
  for (const passage of finding.cited_passages ?? []) {
    if (passage.content_status !== 'available') continue
    const slot = passage.source_attribution?.coverage_source_slot
    if (slot) fromCitations.push(slot)
  }
  const uniqueCitationSlots = [...new Set(fromCitations)]
  if (uniqueCitationSlots.length > 0) {
    return requiredClaimedSourceReviewFields(uniqueCitationSlots, 'matches_admitted_citations')
  }
  const configured = (missionSourceSlots ?? []).map((row) => row.source_slot)
  if (configured.length === 0) {
    throw new Error(
      'semantic review fixture input lacks mission_source_slots and admitted citation slots',
    )
  }
  return requiredClaimedSourceReviewFields([configured[0]!], 'not_assessed')
}
