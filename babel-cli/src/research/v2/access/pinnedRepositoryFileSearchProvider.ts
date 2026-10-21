import type { ResearchMissionV2 } from '../contracts/mission.js'
import type { AdmittedSourceSearchProvider } from '../ports/admittedSourceSearchProvider.js'
import type { SourceSearchRequest, SourceSearchResult } from '../ports/sourceAccessPort.js'
import { admittedHttpGet } from './admittedHttpGet.js'
import {
  missionPinnedRepositories,
  repositoryFileSourceFromPinnedPath,
} from './missionPinnedRepositories.js'

export interface GitHubTreeEntry {
  path: string
  type: 'blob' | 'tree' | string
}

export type FetchPinnedRepositoryTree = (params: {
  apiUrl: string
  signal: AbortSignal
}) => Promise<{ ok: boolean; status: number; entries: GitHubTreeEntry[]; message?: string }>

const DEFAULT_MAX_HITS = 25

export async function defaultFetchPinnedRepositoryTree(params: {
  apiUrl: string
  signal: AbortSignal
}): Promise<{ ok: boolean; status: number; entries: GitHubTreeEntry[]; message?: string }> {
  const response = await admittedHttpGet({
    url: params.apiUrl,
    maxBytes: 4_000_000,
    signal: params.signal,
  })
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      entries: [],
      message: `GitHub tree API HTTP ${response.status}`,
    }
  }
  try {
    const body = JSON.parse(response.buffer.toString('utf8')) as { tree?: GitHubTreeEntry[] }
    return { ok: true, status: response.status, entries: body.tree ?? [] }
  } catch {
    return {
      ok: false,
      status: response.status,
      entries: [],
      message: 'GitHub tree API returned non-JSON payload',
    }
  }
}

/**
 * Technical discovery: list commit-pinned repository paths via GitHub git trees API, then token-match.
 */
export function createPinnedRepositoryFileSearchProvider(options?: {
  fetchTree?: FetchPinnedRepositoryTree
  maxHits?: number
}): AdmittedSourceSearchProvider {
  const fetchTree = options?.fetchTree ?? defaultFetchPinnedRepositoryTree
  const maxHits = options?.maxHits ?? DEFAULT_MAX_HITS

  return {
    async search(request: SourceSearchRequest, mission: ResearchMissionV2): Promise<SourceSearchResult> {
      if (request.signal.aborted) {
        return { operationId: request.operationId, status: 'cancelled' }
      }
      if (!request.sourceClasses.includes('repository_file')) {
        return {
          operationId: request.operationId,
          status: 'failed',
          failureCategory: 'search_provider_unavailable',
          message: 'pinned repository search only supports repository_file source class',
        }
      }
      const pins = missionPinnedRepositories(mission)
      if (pins.length === 0) {
        return {
          operationId: request.operationId,
          status: 'failed',
          failureCategory: 'search_provider_unavailable',
          message: 'mission has no declared repository pins for repository_file discovery',
        }
      }
      const terms = request.query.toLowerCase().split(/\s+/).filter(Boolean)
      const hits = []
      for (const pin of pins) {
        const apiUrl = `https://api.github.com/repos/${pin.full_name}/git/trees/${pin.commit_sha}?recursive=1`
        const listed = await fetchTree({ apiUrl, signal: request.signal })
        if (request.signal.aborted) {
          return { operationId: request.operationId, status: 'cancelled' }
        }
        if (!listed.ok) {
          return {
            operationId: request.operationId,
            status: 'failed',
            failureCategory: 'network_error',
            message: listed.message ?? `GitHub tree listing failed (${listed.status})`,
          }
        }
        for (const entry of listed.entries) {
          if (entry.type !== 'blob') continue
          const hay = entry.path.toLowerCase()
          if (terms.length > 0 && !terms.every((t) => hay.includes(t))) continue
          const source = repositoryFileSourceFromPinnedPath(pin, entry.path)
          if (!source) continue
          hits.push({
            source,
            snippet: entry.path,
            completeness: 'metadata_only' as const,
          })
          if (hits.length >= maxHits) break
        }
        if (hits.length >= maxHits) break
      }
      return { operationId: request.operationId, status: 'ok', hits }
    },
  }
}
