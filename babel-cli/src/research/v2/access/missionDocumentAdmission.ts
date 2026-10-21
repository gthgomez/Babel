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

export function documentSourceMatchesSelectedRef(
  source: SourceRecord,
  mission: ResearchMissionV2,
): boolean {
  const refs = mission.source_policy.selected_document_refs ?? []
  if (refs.length === 0) return false
  const keys = new Set([
    normalizeDocumentUrl(source.canonical_key),
    ...source.observed_urls.map(normalizeDocumentUrl),
  ])
  return refs.some((ref) => keys.has(normalizeDocumentUrl(ref)))
}
