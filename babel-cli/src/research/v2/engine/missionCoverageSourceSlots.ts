import type { ResearchMissionV2 } from '../contracts/mission.js'
import type { PlanCoverageObligation } from '../contracts/plan.js'
import type { SourceRecord } from '../contracts/sources.js'
import { resolveMissionWebRetrievalCandidates } from '../access/missionWebRetrievalSelection.js'
import { planTechnicalRetrievalSlots } from './technicalRetrievalComposition.js'

/** Stable `coverage_source_slot` / plan `source_slot` ids for this mission's retrieval topology. */
export function missionCoverageSourceSlots(mission: ResearchMissionV2): readonly string[] {
  const slots: string[] = []
  const selectedWebRefs = mission.source_policy.selected_web_refs ?? []
  if (selectedWebRefs.length > 0) {
    for (let index = 0; index < selectedWebRefs.length; index++) {
      slots.push(`web-ref-${index}`)
    }
  } else if (mission.source_policy.allowed_source_classes.includes('web')) {
    slots.push('discover-primary')
  }
  for (const slot of planTechnicalRetrievalSlots(mission, '')) {
    if (slot.kind !== 'unsupported_source_class') {
      slots.push(slot.slotId)
    }
  }
  return slots
}

export class PlanCoverageObligationValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PlanCoverageObligationValidationError'
  }
}

export function validateQuestionCoverageObligations(
  obligations: readonly PlanCoverageObligation[],
  mission: ResearchMissionV2,
): void {
  const allowedSlots = new Set(missionCoverageSourceSlots(mission))
  const seenIds = new Set<string>()
  for (const obligation of obligations) {
    if (seenIds.has(obligation.obligation_id)) {
      throw new PlanCoverageObligationValidationError(
        `duplicate obligation_id ${obligation.obligation_id}`,
      )
    }
    seenIds.add(obligation.obligation_id)
    if (!allowedSlots.has(obligation.source_slot)) {
      throw new PlanCoverageObligationValidationError(
        `coverage obligation source_slot ${obligation.source_slot} is not a mission retrieval slot`,
      )
    }
  }
}

export function stampCoverageSourceSlotOnSource(
  source: SourceRecord,
  slotId: string,
): SourceRecord {
  return { ...source, coverage_source_slot: slotId }
}
