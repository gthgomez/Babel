import { createHash } from 'node:crypto'
import type { ResearchMissionV2 } from '../contracts/mission.js'
import type { SourceRecord } from '../contracts/sources.js'
import type { AdmittedSourceSearchProvider } from '../ports/admittedSourceSearchProvider.js'
import type {
  SourceSearchExaLiteReceiptMetadata,
  SourceSearchProviderReceipt,
  SourceSearchRequest,
  SourceSearchResult,
} from '../ports/sourceAccessPort.js'
import type { SourceAccessFailureCategory } from '../ports/sourceAccessTypes.js'
import {
  admittedExaLiteHttpsPost,
  DEFAULT_EXA_LITE_RESPONSE_MAX_BYTES,
  type AdmittedExaLiteHttpsPostDispatch,
} from './admittedExaLiteHttpsPost.js'
import { AdmittedNetworkPolicyError } from './admittedHttpGet.js'
import { parseAdmittedHttpUrl } from './admittedHttpGet.js'
import {
  createDuckDuckGoHtmlFallbackSearchProvider,
  type BabelWebSearchTransport,
} from './babelConfiguredWebSearch.js'
import {
  ExaLiteResponseValidationError,
  mapExaLiteHttpStatusToFailure,
  validateExaLiteSearchResponseBody,
  type SanitizedExaLiteReceiptMetadata,
} from './exaLiteSearchResponseValidation.js'

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

export function toSourceSearchExaLiteReceipt(
  metadata: SanitizedExaLiteReceiptMetadata,
): SourceSearchExaLiteReceiptMetadata {
  return {
    request_id: metadata.request_id,
    resolved_search_type: metadata.resolved_search_type,
    warnings: [...metadata.warnings],
    notices: [...metadata.notices],
    estimated_cost_dollars: metadata.estimated_cost_dollars,
    estimated_cost_detail: metadata.estimated_cost_detail
      ? { ...metadata.estimated_cost_detail }
      : null,
  }
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

function buildExaReceipt(
  metadata: SanitizedExaLiteReceiptMetadata,
  participation: SourceSearchProviderReceipt['exa_participation'],
  effectiveProviderId: string,
): SourceSearchProviderReceipt {
  return {
    configured_provider_id: EXA_LITE_SEARCH_PROVIDER_ID,
    effective_provider_id: effectiveProviderId,
    exa_participation: participation,
    exa_lite: toSourceSearchExaLiteReceipt(metadata),
  }
}

function mapTransportError(err: unknown): {
  failureCategory: SourceAccessFailureCategory
  message: string
} {
  const text = err instanceof Error ? err.message : String(err)
  if (/aborted/i.test(text)) {
    return { failureCategory: 'cancelled', message: 'search cancelled' }
  }
  if (/timed out|deadline exceeded/i.test(text)) {
    return { failureCategory: 'timeout', message: 'configured search provider request timed out' }
  }
  if (/exceeds configured maxBytes/i.test(text)) {
    return { failureCategory: 'truncated', message: 'configured search provider response exceeded size limit' }
  }
  if (err instanceof AdmittedNetworkPolicyError) {
    return { failureCategory: 'policy_denied', message: 'configured search provider network policy blocked request' }
  }
  return { failureCategory: 'network_error', message: 'configured search provider transport failed' }
}

function isBilledEmptyExa(metadata: SanitizedExaLiteReceiptMetadata, hitCount: number): boolean {
  if (hitCount > 0) return false
  return (
    metadata.request_id !== null ||
    metadata.estimated_cost_dollars !== null ||
    metadata.estimated_cost_detail !== null
  )
}

export function createExaLiteSearchProvider(options: {
  resolveApiKey: (env: NodeJS.ProcessEnv) => string | null
  transport: ExaLiteSearchTransport
  maxResults?: number
  maxResponseBytes?: number
  env?: NodeJS.ProcessEnv
}): AdmittedSourceSearchProvider & {
  providerId: typeof EXA_LITE_SEARCH_PROVIDER_ID
  limitations: readonly string[]
} {
  const maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_EXA_LITE_RESPONSE_MAX_BYTES
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
          maxBytes: maxResponseBytes,
          ...(options.transport.post ? { dispatch: options.transport.post } : {}),
        })
        if (request.signal.aborted) {
          return { operationId: request.operationId, status: 'cancelled' }
        }
        if (!response.ok) {
          const mapped = mapExaLiteHttpStatusToFailure(response.status)
          return {
            operationId: request.operationId,
            status: 'failed',
            failureCategory: mapped.failureCategory,
            message: mapped.message,
          }
        }
        const validated = validateExaLiteSearchResponseBody(response.bodyText)
        const hits = []
        for (const row of validated.results) {
          const source = webSourceFromUrl(row.title, row.url)
          if (!source) continue
          try {
            const host = new URL(source.observed_urls[0]!).hostname
            if (!hostnameAllowed(host, mission)) continue
          } catch {
            continue
          }
          const snippet = row.highlights.join(' ').trim() || row.title
          hits.push({
            source,
            snippet,
            completeness: 'snippet' as const,
          })
        }
        const participation =
          hits.length > 0 ? 'exa_primary_ok' : isBilledEmptyExa(validated.metadata, hits.length)
            ? 'exa_primary_empty_billed'
            : 'exa_primary_ok'
        const receipt = buildExaReceipt(
          validated.metadata,
          participation,
          EXA_LITE_SEARCH_PROVIDER_ID,
        )
        return { operationId: request.operationId, status: 'ok', hits, receipt }
      } catch (err: unknown) {
        if (request.signal.aborted) {
          return { operationId: request.operationId, status: 'cancelled' }
        }
        if (err instanceof ExaLiteResponseValidationError) {
          return {
            operationId: request.operationId,
            status: 'failed',
            failureCategory: err.failureCategory,
            message: err.message,
          }
        }
        const mapped = mapTransportError(err)
        if (mapped.failureCategory === 'cancelled') {
          return { operationId: request.operationId, status: 'cancelled' }
        }
        return {
          operationId: request.operationId,
          status: 'failed',
          failureCategory: mapped.failureCategory,
          message: mapped.message,
        }
      }
    },
  }
}

function mergeDegradedReceipt(
  primary: SourceSearchResult,
  fallbackProviderId: string,
  reason: string,
): SourceSearchProviderReceipt {
  const base =
    primary.status === 'ok' && primary.receipt
      ? primary.receipt
      : buildExaReceipt(
          {
            request_id: null,
            resolved_search_type: null,
            warnings: [],
            notices: [],
            estimated_cost_dollars: null,
            estimated_cost_detail: null,
          },
          'exa_primary_failed',
          EXA_LITE_SEARCH_PROVIDER_ID,
        )
  return {
    ...base,
    effective_provider_id: fallbackProviderId,
    exa_participation: 'exa_degraded_fallback',
    degradation: {
      from_provider_id: EXA_LITE_SEARCH_PROVIDER_ID,
      to_provider_id: fallbackProviderId,
      reason,
    },
  }
}

export function createExaLiteWithDuckDuckGoFallbackSearchProvider(options: {
  resolveApiKey: (env: NodeJS.ProcessEnv) => string | null
  exaTransport: ExaLiteSearchTransport
  duckTransport: BabelWebSearchTransport
  maxResults?: number
  maxResponseBytes?: number
  env?: NodeJS.ProcessEnv
}): AdmittedSourceSearchProvider & {
  providerId: typeof EXA_LITE_SEARCH_PROVIDER_ID
  limitations: readonly string[]
} {
  const exa = createExaLiteSearchProvider({
    resolveApiKey: options.resolveApiKey,
    transport: options.exaTransport,
    maxResults: options.maxResults,
    maxResponseBytes: options.maxResponseBytes,
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
          : primary.receipt?.exa_participation === 'exa_primary_empty_billed'
            ? 'exa_empty_billed'
            : 'exa_zero_hits'
      const fallback = await duck.search(request, mission)
      const receipt = mergeDegradedReceipt(primary, duck.providerId, reason)
      if (fallback.status === 'ok') {
        return { ...fallback, receipt }
      }
      return { ...fallback, receipt }
    },
  }
}
