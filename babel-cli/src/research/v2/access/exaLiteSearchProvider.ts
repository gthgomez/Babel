import { createHash } from 'node:crypto'
import type { ResearchMissionV2 } from '../contracts/mission.js'
import type { SourceRecord } from '../contracts/sources.js'
import type { AdmittedSourceSearchProvider } from '../ports/admittedSourceSearchProvider.js'
import type {
  SourceSearchProviderReceipt,
  SourceSearchRequest,
  SourceSearchResult,
} from '../ports/sourceAccessPort.js'
import { admittedExaLiteHttpsPost, type AdmittedExaLiteHttpsPostDispatch } from './admittedExaLiteHttpsPost.js'
import { exaApiKeyConfigured } from './exaLiteSearchCredentials.js'
import { parseAdmittedHttpUrl } from './admittedHttpGet.js'
import {
  createDuckDuckGoHtmlFallbackSearchProvider,
  type BabelWebSearchTransport,
} from './babelConfiguredWebSearch.js'

export const EXA_LITE_SEARCH_PROVIDER_ID = 'exa_lite'

export const EXA_LITE_SEARCH_LIMITATIONS = [
  'exa_lite_cached_content_only_no_live_freshness',
  'highlights_are_discovery_snippets_not_verified_passages',
  'direct_fetch_and_ledger_remain_evidence_authority',
] as const

const DEFAULT_MAX_RESULTS = 5

export interface ExaLiteSearchTransport {
  /** Fake transport for tests; production uses governed default POST when omitted. */
  post?: AdmittedExaLiteHttpsPostDispatch
}

export interface ExaLiteNormalizedMetadata {
  requestId?: unknown
  resolvedSearchType?: unknown
  warnings?: unknown
  notices?: unknown
  costDollars?: unknown
}

function hostnameAllowed(hostname: string, mission: ResearchMissionV2): boolean {
  const allowed = mission.source_policy.allowed_web_domains
  if (!allowed || allowed.length === 0) return false
  const host = hostname.toLowerCase()
  return allowed.some((domain) => host === domain.toLowerCase() || host.endsWith(`.${domain.toLowerCase()}`))
}

function missionIncludeDomains(mission: ResearchMissionV2): string[] {
  return (mission.source_policy.allowed_web_domains ?? []).map((d) => d.toLowerCase())
}

function webSourceFromUrl(title: string, url: string): SourceRecord | null {
  try {
    const parsed = parseAdmittedHttpUrl(url)
    return {
      source_id: `src-web-${createHash('sha256').update(url).digest('hex').slice(0, 24)}`,
      kind: 'web',
      canonical_key: url,
      observed_urls: [parsed.href],
      title,
      syndication_notes: 'exa_lite_discovery_snippet_not_admitted_evidence',
    }
  } catch {
    return null
  }
}

function excerptFromHighlights(row: Record<string, unknown>): string {
  const highlights = row.highlights
  if (Array.isArray(highlights)) {
    return highlights.filter((h) => typeof h === 'string').join(' ')
  }
  const contents = row.contents
  if (contents && typeof contents === 'object') {
    const inner = (contents as { highlights?: unknown }).highlights
    if (Array.isArray(inner)) {
      return inner.filter((h) => typeof h === 'string').join(' ')
    }
  }
  return typeof row.text === 'string' ? row.text : ''
}

export function parseExaLiteSearchResponse(bodyText: string): {
  results: Record<string, unknown>[]
  metadata: ExaLiteNormalizedMetadata
} {
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(bodyText) as Record<string, unknown>
  } catch {
    return { results: [], metadata: {} }
  }
  const results = Array.isArray(parsed.results)
    ? parsed.results.filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null)
    : []
  return {
    results,
    metadata: {
      requestId: parsed.requestId ?? parsed.request_id,
      resolvedSearchType: parsed.resolvedSearchType ?? parsed.resolved_search_type,
      warnings: parsed.warnings,
      notices: parsed.notices,
      costDollars: parsed.costDollars ?? parsed.cost_dollars,
    },
  }
}

function exaFailureMessage(status: number): string {
  if (status === 401 || status === 403) {
    return 'configured search provider rejected the request'
  }
  if (status === 429) {
    return 'configured search provider rate limited the request'
  }
  if (status >= 500) {
    return 'configured search provider server error'
  }
  return `configured search provider HTTP ${status}`
}

export function createExaLiteSearchProvider(options: {
  resolveApiKey: (env: NodeJS.ProcessEnv) => string | null
  transport: ExaLiteSearchTransport
  maxResults?: number
  env?: NodeJS.ProcessEnv
}): AdmittedSourceSearchProvider & {
  providerId: typeof EXA_LITE_SEARCH_PROVIDER_ID
  limitations: readonly string[]
} {
  const maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS
  const env = options.env ?? process.env

  return {
    providerId: EXA_LITE_SEARCH_PROVIDER_ID,
    limitations: EXA_LITE_SEARCH_LIMITATIONS,
    async search(request: SourceSearchRequest, mission: ResearchMissionV2): Promise<SourceSearchResult> {
      if (request.signal.aborted) {
        return { operationId: request.operationId, status: 'cancelled' }
      }
      if (!request.sourceClasses.includes('web')) {
        return {
          operationId: request.operationId,
          status: 'failed',
          failureCategory: 'search_provider_unavailable',
          message: 'exa_lite only supports web source class',
        }
      }
      const apiKey = options.resolveApiKey(env)
      if (!apiKey) {
        return {
          operationId: request.operationId,
          status: 'failed',
          failureCategory: 'search_provider_unavailable',
          message: 'exa_lite requires EXA_API_KEY',
        }
      }

      const includeDomains = missionIncludeDomains(mission)
      const body = {
        type: 'lite',
        query: request.query,
        numResults: maxResults,
        ...(includeDomains.length > 0 ? { includeDomains } : {}),
        contents: {
          highlights: { maxCharacters: 4000 },
        },
      }

      try {
        const response = await admittedExaLiteHttpsPost({
          apiKey,
          jsonBody: body,
          signal: request.signal,
          env,
          ...(options.transport.post ? { dispatch: options.transport.post } : {}),
        })
        if (request.signal.aborted) {
          return { operationId: request.operationId, status: 'cancelled' }
        }
        if (!response.ok) {
          const failureCategory = response.status === 429 ? 'rate_limited' : 'network_error'
          return {
            operationId: request.operationId,
            status: 'failed',
            failureCategory,
            message: exaFailureMessage(response.status),
          }
        }
        const { results, metadata } = parseExaLiteSearchResponse(response.bodyText)
        const hits = []
        for (const row of results) {
          const url = typeof row.url === 'string' ? row.url : ''
          const title = typeof row.title === 'string' ? row.title : url
          if (!url) continue
          const source = webSourceFromUrl(title, url)
          if (!source) continue
          try {
            const host = new URL(source.observed_urls[0]!).hostname
            if (!hostnameAllowed(host, mission)) continue
          } catch {
            continue
          }
          const snippet = excerptFromHighlights(row).trim() || title
          hits.push({
            source,
            snippet,
            completeness: 'snippet' as const,
          })
        }
        const receipt: SourceSearchProviderReceipt = {
          configured_provider_id: EXA_LITE_SEARCH_PROVIDER_ID,
          effective_provider_id: EXA_LITE_SEARCH_PROVIDER_ID,
          exa_lite: metadata,
        }
        return { operationId: request.operationId, status: 'ok', hits, receipt }
      } catch (err: unknown) {
        if (request.signal.aborted) {
          return { operationId: request.operationId, status: 'cancelled' }
        }
        const message = err instanceof Error ? err.message : 'search transport failed'
        if (/aborted/i.test(message)) {
          return { operationId: request.operationId, status: 'cancelled' }
        }
        return {
          operationId: request.operationId,
          status: 'failed',
          failureCategory: 'network_error',
          message: 'configured search provider transport failed',
        }
      }
    },
  }
}

export function createExaLiteWithDuckDuckGoFallbackSearchProvider(options: {
  resolveApiKey: (env: NodeJS.ProcessEnv) => string | null
  exaTransport: ExaLiteSearchTransport
  duckTransport: BabelWebSearchTransport
  maxResults?: number
  env?: NodeJS.ProcessEnv
}): AdmittedSourceSearchProvider & {
  providerId: typeof EXA_LITE_SEARCH_PROVIDER_ID
  limitations: readonly string[]
} {
  const exa = createExaLiteSearchProvider({
    resolveApiKey: options.resolveApiKey,
    transport: options.exaTransport,
    maxResults: options.maxResults,
    env: options.env,
  })
  const duck = createDuckDuckGoHtmlFallbackSearchProvider({
    transport: options.duckTransport,
    maxResults: options.maxResults,
  })

  return {
    providerId: EXA_LITE_SEARCH_PROVIDER_ID,
    limitations: [...EXA_LITE_SEARCH_LIMITATIONS, 'degrades_to_duckduckgo_html_fallback_on_exa_failure'],
    async search(request, mission) {
      const primary = await exa.search(request, mission)
      if (primary.status === 'cancelled') {
        return primary
      }
      if (primary.status === 'ok' && primary.hits.length > 0) {
        return primary
      }
      const reason =
        primary.status === 'failed'
          ? `exa_failed:${primary.failureCategory}`
          : 'exa_zero_hits'
      const fallback = await duck.search(request, mission)
      if (fallback.status !== 'ok') {
        return fallback
      }
      const receipt: SourceSearchProviderReceipt = {
        configured_provider_id: EXA_LITE_SEARCH_PROVIDER_ID,
        effective_provider_id: duck.providerId,
        degradation: {
          from_provider_id: EXA_LITE_SEARCH_PROVIDER_ID,
          to_provider_id: duck.providerId,
          reason,
        },
      }
      if (primary.status === 'ok' && primary.receipt?.exa_lite) {
        receipt.exa_lite = primary.receipt.exa_lite
      }
      return { ...fallback, receipt }
    },
  }
}
