import type { ResearchMissionV2 } from '../contracts/mission.js'
import type { SourceRecord } from '../contracts/sources.js'
import { normalizeDocumentUrl } from './missionDocumentAcquisitionPolicy.js'
import { sourceAdmittedForMission } from './missionSourceAdmission.js'

function sourceUrlKeys(source: SourceRecord): Set<string> {
  const keys = new Set<string>()
  keys.add(normalizeDocumentUrl(source.canonical_key))
  for (const url of source.observed_urls) {
    keys.add(normalizeDocumentUrl(url))
  }
  return keys
}

export function sourceMatchesSelectedWebRef(source: SourceRecord, ref: string): boolean {
  const normalizedRef = normalizeDocumentUrl(ref)
  return sourceUrlKeys(source).has(normalizedRef)
}

export interface MissionWebRetrievalResolvedSlot {
  slotId: string
  ref: string
  candidate: SourceRecord
}

export interface MissionWebRetrievalCandidateResolution {
  slots: MissionWebRetrievalResolvedSlot[]
  limitations: string[]
}

/**
 * When `selected_web_refs` is declared, resolve admitted discover hits in mission ref order (deduped).
 * Otherwise retain legacy behavior: first policy-admitted discover candidate only.
 */
export function resolveMissionWebRetrievalCandidates(
  discovered: readonly SourceRecord[],
  mission: ResearchMissionV2,
): MissionWebRetrievalCandidateResolution {
  const selectedRefs = mission.source_policy.selected_web_refs ?? []
  if (selectedRefs.length === 0) {
    const first = discovered[0]
    return {
      slots: first
        ? [{ slotId: 'discover-primary', ref: first.observed_urls[0] ?? first.canonical_key, candidate: first }]
        : [],
      limitations: [],
    }
  }

  const admitted = discovered.filter((candidate) => sourceAdmittedForMission(candidate, mission))
  const limitations: string[] = []
  const slots: MissionWebRetrievalResolvedSlot[] = []
  const usedSourceIds = new Set<string>()
  for (const [index, ref] of selectedRefs.entries()) {
    const match = admitted.find(
      (candidate) =>
        !usedSourceIds.has(candidate.source_id) && sourceMatchesSelectedWebRef(candidate, ref),
    )
    if (!match) {
      limitations.push(`retrieval_web_ref_missing:${normalizeDocumentUrl(ref)}`)
      continue
    }
    usedSourceIds.add(match.source_id)
    slots.push({
      slotId: `web-ref-${index}`,
      ref,
      candidate: match,
    })
  }
  return { slots, limitations }
}
