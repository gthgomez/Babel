import { createHash } from 'node:crypto'
import type { ResearchMissionV2 } from '../contracts/mission.js'
import type { SourceRecord } from '../contracts/sources.js'
import { normalizeDocumentUrl } from './missionDocumentAcquisitionPolicy.js'
import { sourceAdmittedForMission } from './missionSourceAdmission.js'

export function normalizedWebTargetKey(url: string): string {
  return normalizeDocumentUrl(url)
}

export function primaryObservedWebUrl(source: SourceRecord): string | undefined {
  if (source.kind !== 'web') return undefined
  return source.observed_urls[0]
}

/** Mission fetch identity uses the primary observed URL only (not canonical aliases). */
export function sourcePrimaryUrlMatchesSelectedWebRef(source: SourceRecord, ref: string): boolean {
  const primary = primaryObservedWebUrl(source)
  if (!primary) return false
  return normalizedWebTargetKey(primary) === normalizedWebTargetKey(ref)
}

/** Discover/index matching may still consult secondary observed URLs. */
export function sourceObservedUrlsIncludeSelectedWebRef(source: SourceRecord, ref: string): boolean {
  const key = normalizedWebTargetKey(ref)
  for (const url of source.observed_urls) {
    if (normalizedWebTargetKey(url) === key) return true
  }
  return normalizedWebTargetKey(source.canonical_key) === key
}

export function buildMissionSelectedWebSourceRecord(ref: string): SourceRecord {
  const normalizedRef = normalizedWebTargetKey(ref)
  const sourceId = `web-mission-ref-${createHash('sha256').update(normalizedRef).digest('hex').slice(0, 20)}`
  return {
    source_id: sourceId,
    kind: 'web',
    canonical_key: normalizedRef,
    observed_urls: [normalizedRef],
    title: normalizedRef,
  }
}

/** Rebind discover hit so fetch dispatches on the mission-selected URL as observed_urls[0]. */
export function bindWebSourceToMissionRef(source: SourceRecord, ref: string): SourceRecord {
  const normalizedRef = normalizedWebTargetKey(ref)
  const rest = source.observed_urls.filter((u) => normalizedWebTargetKey(u) !== normalizedRef)
  return {
    ...source,
    canonical_key: normalizedRef,
    observed_urls: [normalizedRef, ...rest],
  }
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
 * When `selected_web_refs` is set: dedupe by normalized fetch target, bind each ref to
 * observed_urls[0], and synthesize direct-acquisition sources when discover omits a ref.
 * Legacy (no refs): first discover candidate only.
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
  const usedTargetKeys = new Set<string>()
  const usedSourceIds = new Set<string>()

  for (const [index, ref] of selectedRefs.entries()) {
    const targetKey = normalizedWebTargetKey(ref)
    if (usedTargetKeys.has(targetKey)) {
      limitations.push(`retrieval_web_ref_duplicate:${targetKey}`)
      continue
    }

    let match =
      admitted.find(
        (candidate) =>
          !usedSourceIds.has(candidate.source_id) &&
          sourcePrimaryUrlMatchesSelectedWebRef(candidate, ref),
      ) ??
      admitted.find(
        (candidate) =>
          !usedSourceIds.has(candidate.source_id) &&
          sourceObservedUrlsIncludeSelectedWebRef(candidate, ref),
      )

    if (!match) {
      const direct = buildMissionSelectedWebSourceRecord(ref)
      if (!sourceAdmittedForMission(direct, mission)) {
        limitations.push(`retrieval_web_ref_missing:${targetKey}`)
        continue
      }
      match = direct
    } else {
      match = bindWebSourceToMissionRef(match, ref)
    }

    const fetchKey = normalizedWebTargetKey(match.observed_urls[0] ?? ref)
    if (usedTargetKeys.has(fetchKey)) {
      limitations.push(`retrieval_web_ref_duplicate:${fetchKey}`)
      continue
    }

    usedTargetKeys.add(fetchKey)
    usedSourceIds.add(match.source_id)
    slots.push({
      slotId: `web-ref-${index}`,
      ref,
      candidate: match,
    })
  }
  return { slots, limitations }
}
