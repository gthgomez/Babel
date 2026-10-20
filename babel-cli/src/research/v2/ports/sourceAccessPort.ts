import type { SourceClassSchema } from '../contracts/mission.js'
import type { SourceRecord, SourceRevision } from '../contracts/sources.js'
import type { PassageRecord } from '../contracts/passages.js'
import type { z } from 'zod'

export type SourceClass = z.infer<typeof SourceClassSchema>

export type SourceAccessFailureCategory =
  | 'policy_denied'
  | 'network_error'
  | 'timeout'
  | 'not_found'
  | 'rate_limited'
  | 'truncated'
  | 'extraction_failed'
  | 'unsupported_media'
  | 'private_address_blocked'
  | 'cancelled'

export interface SourceSearchRequest {
  operationId: string
  query: string
  sourceClasses: SourceClass[]
  signal: AbortSignal
}

export interface SourceSearchHit {
  source: SourceRecord
  snippet: string
  /** Discovery evidence only until a primary read succeeds. */
  completeness: 'metadata_only' | 'snippet'
}

export interface SourceSearchResult {
  operationId: string
  hits: SourceSearchHit[]
}

export interface SourceReadRequest {
  operationId: string
  source: SourceRecord
  signal: AbortSignal
}

export type SourceReadResult =
  | {
      status: 'ok'
      operationId: string
      revision: SourceRevision
      passages: PassageRecord[]
    }
  | {
      status: 'partial'
      operationId: string
      revision: SourceRevision
      passages: PassageRecord[]
      failureCategory: SourceAccessFailureCategory
      message: string
    }
  | {
      status: 'failed'
      operationId: string
      failureCategory: SourceAccessFailureCategory
      message: string
    }

/**
 * Admitted search/fetch/read boundary. Enforces network policy and size limits.
 * Adapters receive this port; they do not perform ambient fetch or shell access.
 */
export interface SourceAccessPort {
  search(request: SourceSearchRequest): Promise<SourceSearchResult>
  read(request: SourceReadRequest): Promise<SourceReadResult>
}
