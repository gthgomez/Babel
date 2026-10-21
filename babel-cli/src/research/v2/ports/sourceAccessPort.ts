import type { AdmittedContent } from '../contracts/admittedContent.js'
import type { SourceAcquisitionDiagnostics } from '../contracts/sourceAcquisitionDiagnostics.js'
import type { SourceClassSchema } from '../contracts/mission.js'
import type { SourceRecord } from '../contracts/sources.js'
import type { SourceAccessFailureCategory } from './sourceAccessTypes.js'
import type { z } from 'zod'

export type SourceClass = z.infer<typeof SourceClassSchema>

export type { SourceAccessFailureCategory } from './sourceAccessTypes.js'

export interface SourceSearchRequest {
  operationId: string
  query: string
  sourceClasses: SourceClass[]
  signal: AbortSignal
}

export interface SourceSearchHit {
  source: SourceRecord
  snippet: string
  completeness: 'metadata_only' | 'snippet'
}

export interface SourceSearchExaLiteDiagnosticRecord {
  code: string
  path: string | null
  message: string
  details: Record<string, string> | null
}

/** Sanitized Exa lite metadata at the search provider boundary (A propagates downstream). */
export interface SourceSearchExaLiteReceiptMetadata {
  request_id: string | null
  resolved_search_type: string | null
  warnings: SourceSearchExaLiteDiagnosticRecord[]
  notices: SourceSearchExaLiteDiagnosticRecord[]
  /** Provider-reported estimate only — not an invoice. */
  estimated_cost_dollars: number | null
  estimated_cost_detail: Record<string, number> | null
}

export type SourceSearchExaParticipation =
  | 'exa_primary_ok'
  | 'exa_primary_empty_billed'
  | 'exa_primary_failed'
  | 'exa_degraded_fallback'

/** Discovery-only provider metadata (not admitted evidence). */
export interface SourceSearchProviderReceipt {
  configured_provider_id: string
  effective_provider_id: string
  exa_participation?: SourceSearchExaParticipation
  degradation?: {
    from_provider_id: string
    to_provider_id: string
    reason: string
  }
  exa_lite?: SourceSearchExaLiteReceiptMetadata
}

export type SourceSearchResult =
  | { operationId: string; status: 'ok'; hits: SourceSearchHit[]; receipt?: SourceSearchProviderReceipt }
  | {
      operationId: string
      status: 'failed'
      failureCategory: SourceAccessFailureCategory
      message: string
      receipt?: SourceSearchProviderReceipt
    }
  | { operationId: string; status: 'cancelled' }

export interface SourceFetchRequest {
  operationId: string
  source: SourceRecord
  signal: AbortSignal
}

export type SourceFetchResult =
  | { operationId: string; status: 'ok'; admitted: AdmittedContent }
  | {
      operationId: string
      status: 'failed'
      failureCategory: SourceAccessFailureCategory
      message: string
      acquisition_diagnostics?: SourceAcquisitionDiagnostics
    }
  | { operationId: string; status: 'cancelled' }

/**
 * Admitted search/fetch boundary. Network policy and byte limits enforced here only.
 */
export interface SourceAccessPort {
  search(request: SourceSearchRequest): Promise<SourceSearchResult>
  fetchContent(request: SourceFetchRequest): Promise<SourceFetchResult>
}
