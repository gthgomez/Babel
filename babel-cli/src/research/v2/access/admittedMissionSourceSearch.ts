import type { ResearchMissionV2 } from '../contracts/mission.js'
import type { SourceRecord } from '../contracts/sources.js'
import type {
  SourceSearchHit,
  SourceSearchRequest,
  SourceSearchResult,
} from '../ports/sourceAccessPort.js'
import { parseAdmittedHttpUrl } from './admittedHttpGet.js'

export interface AdmittedSearchIndexEntry {
  source: SourceRecord
  /** Host-admitted searchable text (title, path, excerpt metadata — not unbounded remote HTML). */
  searchableText: string
}

function hostnameAllowed(hostname: string, mission: ResearchMissionV2): boolean {
  const allowed = mission.source_policy.allowed_web_domains
  if (!allowed || allowed.length === 0) return false
  const host = hostname.toLowerCase()
  return allowed.some((domain) => host === domain.toLowerCase() || host.endsWith(`.${domain.toLowerCase()}`))
}

function sourceAdmittedForMission(source: SourceRecord, mission: ResearchMissionV2): boolean {
  if (!mission.source_policy.allowed_source_classes.includes(source.kind)) {
    return false
  }
  if (source.kind === 'repository_file' && mission.pinned_target_repository) {
    const repoId = source.canonical_identifiers?.github_repo_id
    if (repoId && repoId !== mission.pinned_target_repository.repo_id) {
      return false
    }
    const sha = source.canonical_identifiers?.github_commit_sha
    if (sha && sha !== mission.pinned_target_repository.commit_sha) {
      return false
    }
  }
  if (source.kind === 'web') {
    const url = source.observed_urls[0]
    if (!url) return false
    try {
      const parsed = parseAdmittedHttpUrl(url)
      if (!hostnameAllowed(parsed.hostname, mission)) return false
    } catch {
      return false
    }
  }
  return true
}

/**
 * **Declared-index corpus search** — token match over a host-provided manifest/index with mission admission checks.
 * Not open-web discovery. Open-web admitted search is supplied by a separate
 * {@link import('../ports/admittedSourceSearchProvider.js').AdmittedSourceSearchProvider} (B-owned web catalog/adapter).
 */
export function admittedMissionSourceSearch(
  request: SourceSearchRequest,
  mission: ResearchMissionV2,
  index: readonly AdmittedSearchIndexEntry[],
): SourceSearchResult {
  if (request.signal.aborted) {
    return { operationId: request.operationId, status: 'cancelled' }
  }
  const terms = request.query.toLowerCase().split(/\s+/).filter(Boolean)
  const hits: SourceSearchHit[] = []
  for (const entry of index) {
    if (!request.sourceClasses.includes(entry.source.kind)) continue
    if (!sourceAdmittedForMission(entry.source, mission)) continue
    const hay = `${entry.source.title ?? ''} ${entry.searchableText}`.toLowerCase()
    if (terms.length > 0 && !terms.every((t) => hay.includes(t))) continue
    hits.push({
      source: entry.source,
      snippet: entry.searchableText.slice(0, 240),
      completeness: 'snippet',
    })
  }
  if (request.signal.aborted) {
    return { operationId: request.operationId, status: 'cancelled' }
  }
  return { operationId: request.operationId, status: 'ok', hits }
}
