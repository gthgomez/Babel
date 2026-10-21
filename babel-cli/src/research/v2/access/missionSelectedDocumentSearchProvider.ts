import { createHash } from 'node:crypto'
import type { ResearchMissionV2 } from '../contracts/mission.js'
import type { SourceRecord } from '../contracts/sources.js'
import type { AdmittedSourceSearchProvider } from '../ports/admittedSourceSearchProvider.js'
import type { SourceSearchRequest, SourceSearchResult } from '../ports/sourceAccessPort.js'
import { sourceAdmittedForMission } from './missionSourceAdmission.js'

function documentSourceFromRef(ref: string): SourceRecord {
  const url = ref.startsWith('http://') || ref.startsWith('https://') ? ref : `https://example.invalid/${ref}`
  return {
    source_id: `src-doc-${createHash('sha256').update(ref).digest('hex').slice(0, 24)}`,
    kind: 'document',
    canonical_key: ref,
    observed_urls: [url],
    title: ref,
  }
}

/**
 * Production document discovery: mission-declared `selected_document_refs` only (no open-web crawl).
 */
export function createMissionSelectedDocumentSearchProvider(): AdmittedSourceSearchProvider {
  return {
    async search(request: SourceSearchRequest, mission: ResearchMissionV2): Promise<SourceSearchResult> {
      if (request.signal.aborted) {
        return { operationId: request.operationId, status: 'cancelled' }
      }
      if (!request.sourceClasses.includes('document')) {
        return {
          operationId: request.operationId,
          status: 'failed',
          failureCategory: 'search_provider_unavailable',
          message: 'mission document search only supports document source class',
        }
      }
      const refs = mission.source_policy.selected_document_refs ?? []
      if (refs.length === 0) {
        return { operationId: request.operationId, status: 'ok', hits: [] }
      }
      const terms = request.query.toLowerCase().split(/\s+/).filter(Boolean)
      const hits = []
      for (const ref of refs) {
        const source = documentSourceFromRef(ref)
        if (!sourceAdmittedForMission(source, mission)) continue
        const hay = `${ref} ${source.title ?? ''}`.toLowerCase()
        if (terms.length > 0 && !terms.every((t) => hay.includes(t))) continue
        hits.push({
          source,
          snippet: ref.slice(0, 240),
          completeness: 'metadata_only' as const,
        })
      }
      if (request.signal.aborted) {
        return { operationId: request.operationId, status: 'cancelled' }
      }
      return { operationId: request.operationId, status: 'ok', hits }
    },
  }
}
