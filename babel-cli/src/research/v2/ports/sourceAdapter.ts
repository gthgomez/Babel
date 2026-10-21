import type { SourceAcquisitionDiagnostics } from '../contracts/sourceAcquisitionDiagnostics.js'
import type { PassageRecord } from '../contracts/passages.js'
import type { SourceRecord, SourceRevision } from '../contracts/sources.js'
import type { SourceClass, SourceAccessPort, SourceSearchProviderReceipt } from './sourceAccessPort.js'

export interface SourceDiscoverRequest {
  operationId: string
  query: string
  signal: AbortSignal
}

export type SourceDiscoverResult =
  | {
      operationId: string
      status: 'ok'
      candidates: SourceRecord[]
      search_provider_receipt?: SourceSearchProviderReceipt
    }
  | {
      operationId: string
      status: 'failed'
      failureCategory: string
      message: string
      acquisition_diagnostics?: SourceAcquisitionDiagnostics
      search_provider_receipt?: SourceSearchProviderReceipt
    }
  | { operationId: string; status: 'cancelled' }

export interface SourceAdapterReadRequest {
  operationId: string
  source: SourceRecord
  signal: AbortSignal
}

export interface DocumentPdfExtractionCoverage {
  pdf_page_count: number
  pages_processed: number
  pages_with_passages: number
  pages_without_extractable_text: number
  pages_with_truncated_inline_text: number
  last_page_with_passage: number | null
  page_traversal_complete: boolean
  text_extraction_complete: boolean
}

export type SourceAdapterReadResult =
  | {
      operationId: string
      status: 'ok'
      revision: SourceRevision
      passages: PassageRecord[]
      extraction_version: string
      document_pdf_extraction_coverage?: DocumentPdfExtractionCoverage
    }
  | {
      operationId: string
      status: 'failed'
      failureCategory: string
      message: string
      acquisition_diagnostics?: SourceAcquisitionDiagnostics
    }
  | { operationId: string; status: 'cancelled' }

/**
 * Profile-specific discovery and extraction. IO only through SourceAccessPort.fetchContent.
 */
export interface SourceAdapter {
  readonly adapterId: string
  readonly supportedKinds: readonly SourceClass[]
  discover(request: SourceDiscoverRequest, access: SourceAccessPort): Promise<SourceDiscoverResult>
  read(request: SourceAdapterReadRequest, access: SourceAccessPort): Promise<SourceAdapterReadResult>
}

export interface SourceAdapterRegistry {
  getAdapter(adapterId: string): SourceAdapter | undefined
  listAdapters(): readonly SourceAdapter[]
}
