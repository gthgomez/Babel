import type { PassageRecord } from '../contracts/passages.js'
import type { SourceRecord, SourceRevision } from '../contracts/sources.js'
import type { SourceClass, SourceAccessPort } from './sourceAccessPort.js'

export interface SourceDiscoverRequest {
  operationId: string
  query: string
  signal: AbortSignal
}

export interface SourceDiscoverResult {
  operationId: string
  candidates: SourceRecord[]
}

export interface SourceAdapterReadRequest {
  operationId: string
  source: SourceRecord
  signal: AbortSignal
}

export type SourceAdapterReadResult =
  | {
      operationId: string
      status: 'ok'
      revision: SourceRevision
      passages: PassageRecord[]
      extraction_version: string
    }
  | {
      operationId: string
      status: 'failed'
      failureCategory: string
      message: string
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
