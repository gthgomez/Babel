import type { ResearchMissionV2 } from '../contracts/mission.js'
import type { PlanCoverageObligation } from '../contracts/plan.js'
import type { SourceRecord, SourceRevision } from '../contracts/sources.js'
import { missionCoverageSourceSlots } from './missionCoverageSourceSlots.js'

export type MissionSourceSlotFetchStatus =
  | 'admitted_fetched'
  | 'fetch_failed_or_missing'
  | 'not_configured'

export interface MissionSourceSlotAttribution {
  source_slot: string
  configured_url?: string
  fetch_status: MissionSourceSlotFetchStatus
  admitted_source_id?: string
  admitted_title?: string
  admitted_canonical_url?: string
  revision_completeness?: SourceRevision['completeness']
}

const NON_ADMITTED_COMPLETENESS: ReadonlySet<SourceRevision['completeness']> = new Set([
  'unavailable',
  'extraction_failed',
  'metadata_only',
])

export function isCriterionBasedPlanObligation(
  obligation: PlanCoverageObligation,
): boolean {
  return obligation.criterion_id !== undefined && obligation.criterion_id.length > 0
}

export function revisionRepresentsAdmittedFetch(
  revision?: SourceRevision,
): boolean {
  if (!revision) return false
  return !NON_ADMITTED_COMPLETENESS.has(revision.completeness)
}

export function buildMissionSourceSlotAttribution(
  mission: ResearchMissionV2,
  sources: readonly SourceRecord[],
  sourceRevisions: readonly SourceRevision[],
): MissionSourceSlotAttribution[] {
  const slots = missionCoverageSourceSlots(mission)
  const selectedWebRefs = mission.source_policy.selected_web_refs ?? []
  const sourcesBySlot = new Map<string, SourceRecord>()
  for (const source of sources) {
    if (source.coverage_source_slot) {
      sourcesBySlot.set(source.coverage_source_slot, source)
    }
  }
  const revisionsBySourceId = new Map<string, SourceRevision[]>()
  for (const revision of sourceRevisions) {
    const list = revisionsBySourceId.get(revision.source_id) ?? []
    list.push(revision)
    revisionsBySourceId.set(revision.source_id, list)
  }

  return slots.map((slotId, index) => {
    const configuredUrl = selectedWebRefs[index]
    const source = sourcesBySlot.get(slotId)
    if (!source) {
      return {
        source_slot: slotId,
        ...(configuredUrl ? { configured_url: configuredUrl } : {}),
        fetch_status: 'fetch_failed_or_missing',
      }
    }
    const revisions = revisionsBySourceId.get(source.source_id) ?? []
    const latest = revisions[revisions.length - 1]
    const admitted = revisionRepresentsAdmittedFetch(latest)
    const primaryUrl = source.observed_urls[0]
    const title =
      typeof source.title === 'string' && source.title.length > 0 ? source.title : undefined
    return {
      source_slot: slotId,
      ...(configuredUrl ? { configured_url: configuredUrl } : {}),
      fetch_status: admitted ? 'admitted_fetched' : 'fetch_failed_or_missing',
      admitted_source_id: source.source_id,
      ...(title ? { admitted_title: title } : {}),
      ...(primaryUrl ? { admitted_canonical_url: primaryUrl } : {}),
      ...(latest ? { revision_completeness: latest.completeness } : {}),
    }
  })
}

export function slotFetchStatusById(
  directory: readonly MissionSourceSlotAttribution[],
): Map<string, MissionSourceSlotFetchStatus> {
  return new Map(directory.map((row) => [row.source_slot, row.fetch_status]))
}

export function slotHasAdmittedFetch(
  sourceSlot: string,
  provenanceIndex: ReadonlyMap<string, { source: SourceRecord; revision: SourceRevision }>,
): boolean {
  for (const { source, revision } of provenanceIndex.values()) {
    if (source.coverage_source_slot !== sourceSlot) continue
    if (revisionRepresentsAdmittedFetch(revision)) {
      return true
    }
  }
  return false
}

/** Passage text references a mission slot URL whose fetch is not admitted (link-only evidence). */
export function passageReferencesUnfetchedConfiguredSlot(
  passageText: string,
  directory: readonly MissionSourceSlotAttribution[],
): string[] {
  const unfetched: string[] = []
  for (const row of directory) {
    if (row.fetch_status === 'admitted_fetched') continue
    const url = row.configured_url ?? row.admitted_canonical_url
    if (!url) continue
    if (passageText.includes(url)) {
      unfetched.push(row.source_slot)
    }
  }
  return unfetched
}
