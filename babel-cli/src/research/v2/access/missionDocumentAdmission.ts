import type { ResearchMissionV2 } from '../contracts/mission.js'
import type { SourceRecord } from '../contracts/sources.js'
import { normalizeDocumentUrl } from './missionDocumentAcquisitionPolicy.js'

export function hostnameAllowed(hostname: string, mission: ResearchMissionV2): boolean {
  const allowed = mission.source_policy.allowed_web_domains
  if (!allowed || allowed.length === 0) return false
  const host = hostname.toLowerCase()
  return allowed.some(
    (domain) => host === domain.toLowerCase() || host.endsWith(`.${domain.toLowerCase()}`),
  )
}

/** Search/index admission: source must declare a mission-selected ref among its identifiers. */
export function documentSourceMatchesSelectedRef(
  source: SourceRecord,
  mission: ResearchMissionV2,
): boolean {
  const refs = mission.source_policy.selected_document_refs ?? []
  if (refs.length === 0) return false
  const selected = new Set(refs.map(normalizeDocumentUrl))
  const keys = new Set([
    normalizeDocumentUrl(source.canonical_key),
    ...source.observed_urls.map(normalizeDocumentUrl),
  ])
  for (const key of keys) {
    if (selected.has(key)) return true
  }
  return false
}

export function documentFetchUrlSelectedForMission(
  fetchUrl: string,
  mission: ResearchMissionV2,
): boolean {
  const refs = mission.source_policy.selected_document_refs ?? []
  const normalizedFetch = normalizeDocumentUrl(fetchUrl)
  return refs.some((ref) => normalizeDocumentUrl(ref) === normalizedFetch)
}

/** Pre-dispatch: actual fetch URL must be mission-selected (aliases on metadata cannot substitute). */
export function validateDocumentFetchUrlForMission(
  fetchUrl: string,
  source: SourceRecord,
  mission: ResearchMissionV2,
): string | null {
  if (source.kind !== 'document' && source.kind !== 'paper') {
    return null
  }
  const selected = mission.source_policy.selected_document_refs ?? []
  if (selected.length === 0) {
    return 'mission has no selected_document_refs for document fetch'
  }
  if (!documentFetchUrlSelectedForMission(fetchUrl, mission)) {
    return 'document fetch URL is not a mission-selected document ref'
  }
  return null
}
