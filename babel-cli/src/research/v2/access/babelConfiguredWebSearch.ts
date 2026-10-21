import { createHash } from 'node:crypto'
import type { ResearchMissionV2 } from '../contracts/mission.js'
import type { SourceRecord } from '../contracts/sources.js'
import type { AdmittedSourceSearchProvider } from '../ports/admittedSourceSearchProvider.js'
import type { SourceSearchRequest, SourceSearchResult } from '../ports/sourceAccessPort.js'
import { parseDuckDuckGoHtml } from '../../../tools/webContext.js'
import { admittedHttpGet } from './admittedHttpGet.js'
import { parseAdmittedHttpUrl } from './admittedHttpGet.js'
import {
  createExaLiteWithDuckDuckGoFallbackSearchProvider,
  EXA_LITE_SEARCH_PROVIDER_ID,
  type ExaLiteSearchTransport,
} from './exaLiteSearchProvider.js'

export { EXA_LITE_SEARCH_PROVIDER_ID } from './exaLiteSearchProvider.js'

/** Matches {@link handleWebSearch} in tools/webContext.ts — the only configured production provider today. */
export const DUCKDUCKGO_HTML_FALLBACK_PROVIDER_ID = 'duckduckgo_html_fallback'

export const DUCKDUCKGO_HTML_FALLBACK_LIMITATIONS = [
  'same_unofficial_html_endpoint_as_babel_web_search_tool',
  'no_paid_api_key_and_no_result_sla',
  'html_parser_fragile_coverage_incomplete',
  'may_return_zero_hits_without_distinct_error',
] as const

export type BabelConfiguredSearchProviderId =
  | typeof DUCKDUCKGO_HTML_FALLBACK_PROVIDER_ID
  | typeof EXA_LITE_SEARCH_PROVIDER_ID

export type BabelWebSearchTransport = (params: {
  searchUrl: string
  signal: AbortSignal
}) => Promise<{ ok: boolean; status: number; html: string }>

const DEFAULT_MAX_RESULTS = 5

export function resolveProductionSearchProviderId(
  env: NodeJS.ProcessEnv = process.env,
): BabelConfiguredSearchProviderId | null {
  const explicit = env.BABEL_WEB_SEARCH_PROVIDER?.trim()
  if (!explicit || explicit === DUCKDUCKGO_HTML_FALLBACK_PROVIDER_ID) {
    return DUCKDUCKGO_HTML_FALLBACK_PROVIDER_ID
  }
  if (explicit === EXA_LITE_SEARCH_PROVIDER_ID) {
    return EXA_LITE_SEARCH_PROVIDER_ID
  }
  return null
}

function resolveExaApiKey(env: NodeJS.ProcessEnv): string | null {
  const value = env.EXA_API_KEY?.trim()
  return value ? value : null
}

export interface CreateBabelConfiguredWebSearchProviderOptions {
  providerId: BabelConfiguredSearchProviderId
  webSearchTransport?: BabelWebSearchTransport
  exaLiteTransport?: ExaLiteSearchTransport
  env?: NodeJS.ProcessEnv
}

export function createBabelConfiguredWebSearchProvider(
  options: CreateBabelConfiguredWebSearchProviderOptions,
): AdmittedSourceSearchProvider & {
  providerId: BabelConfiguredSearchProviderId
  limitations: readonly string[]
} {
  const env = options.env ?? process.env
  const duckTransport = options.webSearchTransport ?? defaultBabelWebSearchTransport()
  if (options.providerId === EXA_LITE_SEARCH_PROVIDER_ID) {
    return createExaLiteWithDuckDuckGoFallbackSearchProvider({
      resolveApiKey: resolveExaApiKey,
      exaTransport: options.exaLiteTransport ?? {},
      duckTransport,
      env,
    })
  }
  return createDuckDuckGoHtmlFallbackSearchProvider({ transport: duckTransport })
}

export function buildDuckDuckGoHtmlSearchUrl(query: string): string {
  const searchUrl = new URL('https://duckduckgo.com/html/')
  searchUrl.searchParams.set('q', query)
  return searchUrl.href
}

function hostnameAllowed(hostname: string, mission: ResearchMissionV2): boolean {
  const allowed = mission.source_policy.allowed_web_domains
  if (!allowed || allowed.length === 0) return false
  const host = hostname.toLowerCase()
  return allowed.some((domain) => host === domain.toLowerCase() || host.endsWith(`.${domain.toLowerCase()}`))
}

function webSourceFromResult(title: string, url: string): SourceRecord | null {
  try {
    const parsed = parseAdmittedHttpUrl(url)
    return {
      source_id: `src-web-${createHash('sha256').update(url).digest('hex').slice(0, 24)}`,
      kind: 'web',
      canonical_key: url,
      observed_urls: [parsed.href],
      title,
    }
  } catch {
    return null
  }
}

export function defaultBabelWebSearchTransport(maxBytes = 400_000): BabelWebSearchTransport {
  return async ({ searchUrl, signal }) => {
    const response = await admittedHttpGet({
      url: searchUrl,
      maxBytes,
      signal,
    })
    return {
      ok: response.ok,
      status: response.status,
      html: response.buffer.toString('utf8'),
    }
  }
}

export function createDuckDuckGoHtmlFallbackSearchProvider(options: {
  transport: BabelWebSearchTransport
  maxResults?: number
}): AdmittedSourceSearchProvider & {
  providerId: BabelConfiguredSearchProviderId
  limitations: readonly string[]
} {
  const maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS
  return {
    providerId: DUCKDUCKGO_HTML_FALLBACK_PROVIDER_ID,
    limitations: DUCKDUCKGO_HTML_FALLBACK_LIMITATIONS,
    async search(request: SourceSearchRequest, mission: ResearchMissionV2): Promise<SourceSearchResult> {
      if (request.signal.aborted) {
        return { operationId: request.operationId, status: 'cancelled' }
      }
      if (!request.sourceClasses.includes('web')) {
        return {
          operationId: request.operationId,
          status: 'failed',
          failureCategory: 'search_provider_unavailable',
          message: 'duckduckgo_html_fallback only supports web source class',
        }
      }
      const searchUrl = buildDuckDuckGoHtmlSearchUrl(request.query)
      try {
        const response = await options.transport({ searchUrl, signal: request.signal })
        if (request.signal.aborted) {
          return { operationId: request.operationId, status: 'cancelled' }
        }
        if (!response.ok) {
          return {
            operationId: request.operationId,
            status: 'failed',
            failureCategory: 'network_error',
            message: `web search HTTP ${response.status}`,
          }
        }
        const parsed = parseDuckDuckGoHtml(response.html, maxResults)
        const hits = []
        for (const row of parsed) {
          const source = webSourceFromResult(row.title, row.url)
          if (!source) continue
          try {
            const host = new URL(source.observed_urls[0]!).hostname
            if (!hostnameAllowed(host, mission)) continue
          } catch {
            continue
          }
          hits.push({
            source,
            snippet: row.title,
            completeness: 'metadata_only' as const,
          })
        }
        return { operationId: request.operationId, status: 'ok', hits }
      } catch (err: unknown) {
        return {
          operationId: request.operationId,
          status: 'failed',
          failureCategory: 'network_error',
          message: err instanceof Error ? err.message : String(err),
        }
      }
    },
  }
}
