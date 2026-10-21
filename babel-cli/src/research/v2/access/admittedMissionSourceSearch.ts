import type { ResearchMissionV2 } from '../contracts/mission.js'
import type { SourceRecord } from '../contracts/sources.js'
import type {
  SourceSearchHit,
  SourceSearchRequest,
  SourceSearchResult,
} from '../ports/sourceAccessPort.js'
import { sourceAdmittedForMission } from './missionSourceAdmission.js'

export interface AdmittedSearchIndexEntry {
  source: SourceRecord
  /** Host-admitted searchable text (title, path, excerpt metadata — not unbounded remote HTML). */
  searchableText: string
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
