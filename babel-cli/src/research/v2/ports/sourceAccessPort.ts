import type { AdmittedContent } from '../contracts/admittedContent.js'
import type { SourceSearchProviderReceipt } from '../contracts/sourceSearchProviderReceipt.js'
import type { SourceAcquisitionDiagnostics } from '../contracts/sourceAcquisitionDiagnostics.js'
import type { SourceClassSchema } from '../contracts/mission.js'
import type { SourceRecord } from '../contracts/sources.js'
import type { SourceAccessFailureCategory } from './sourceAccessTypes.js'
import type { z } from 'zod'

export type {
  SourceSearchExaLiteDiagnosticRecord,
  SourceSearchExaLiteReceiptMetadata,
  SourceSearchExaParticipation,
  SourceSearchProviderReceipt,
} from '../contracts/sourceSearchProviderReceipt.js'

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

export type SourceSearchResult =
  | { operationId: string; status: 'ok'; hits: SourceSearchHit[]; receipt?: SourceSearchProviderReceipt }
  | {
      operationId: string
      status: 'failed'
      failureCategory: SourceAccessFailureCategory
      message: string
      acquisition_diagnostics?: SourceAcquisitionDiagnostics
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
