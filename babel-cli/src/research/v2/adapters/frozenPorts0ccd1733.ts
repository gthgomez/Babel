/**
 * TEMPORARY structural aliases — NOT integrated acceptance.
 * Shapes mirror Agent A `0ccd1733` for branch-only compile until `ports/` + `contracts/` exist here.
 * Integrated tests must import real frozen A modules and delete this file (see documents/INTEGRATION_BINDING.md).
 */
export type SourceClass = 'document' | 'web' | 'paper' | 'dataset' | 'code' | 'other'

export interface SourceRecord {
  source_id: string
  kind: SourceClass
  canonical_key: string
  observed_urls: string[]
}

export interface SourceRevision {
  revision_id: string
  source_id: string
  content_hash: string
  retrieved_at: string
  completeness_status: 'complete' | 'truncated' | 'metadata_only' | 'extraction_failed'
}

export interface PassageLocatorLineRange {
  kind: 'line_range'
  start_line: number
  end_line: number
}

export interface PassageRecord {
  passage_id: string
  source_id: string
  revision_id: string
  locator: PassageLocatorLineRange
  text: string
  extraction_version: string
}

export interface AdmittedContentPayload {
  mode: 'inline_bytes'
  bytes_base64: string
  byte_length: number
  content_hash: string
}

export interface AdmittedContent {
  operation_id: string
  revision: SourceRevision
  media_type: string
  provenance: {
    requested_url: string
    final_url: string
    redirect_chain: string[]
  }
  payload: AdmittedContentPayload
  truncation?: {
    reason: string
    bytes_received: number
    bytes_limit: number
  }
}

export type SourceFetchResult =
  | { operationId: string; status: 'ok'; admitted: AdmittedContent }
  | { operationId: string; status: 'failed'; failureCategory: string; message: string }
  | { operationId: string; status: 'cancelled' }

export interface SourceFetchRequest {
  operationId: string
  source: SourceRecord
  signal: AbortSignal
}

export interface SourceAccessPort {
  fetchContent(request: SourceFetchRequest): Promise<SourceFetchResult>
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
  | { operationId: string; status: 'failed'; failureCategory: string; message: string }
  | { operationId: string; status: 'cancelled' }

export interface SourceAdapter {
  readonly adapterId: string
  readonly supportedKinds: readonly SourceClass[]
  read(
    request: SourceAdapterReadRequest,
    access: SourceAccessPort,
  ): Promise<SourceAdapterReadResult>
}
