import { createHash } from 'node:crypto'
import type { AdmittedContent } from '../contracts/admittedContent.js'
import type { SourceRevision } from '../contracts/sources.js'
import type {
  SourceAccessPort,
  SourceFetchRequest,
  SourceFetchResult,
  SourceSearchRequest,
  SourceSearchResult,
} from '../ports/sourceAccessPort.js'

export type FetchLike = (
  input: string,
  init?: { signal?: AbortSignal; headers?: Record<string, string> },
) => Promise<{
  ok: boolean
  status: number
  headers: { get(name: string): string | null }
  arrayBuffer(): Promise<ArrayBuffer>
}>

export interface FetchSourceAccessPortOptions {
  fetch: FetchLike
  maxAdmittedBytes?: number
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function issueRevisionId(sourceId: string, contentHash: string): string {
  return `rev-${sourceId}-${contentHash.slice(0, 16)}`
}

/**
 * Network {@link SourceAccessPort} for admitted byte fetch (GET). Search is not implemented here;
 * profile adapters perform discover via registry + delegated search policies.
 */
export class FetchSourceAccessPort implements SourceAccessPort {
  constructor(private readonly options: FetchSourceAccessPortOptions) {}

  async search(request: SourceSearchRequest): Promise<SourceSearchResult> {
    if (request.signal.aborted) {
      return { operationId: request.operationId, status: 'cancelled' }
    }
    return {
      operationId: request.operationId,
      status: 'failed',
      failureCategory: 'search_provider_unavailable',
      message: 'FetchSourceAccessPort does not implement search; use profile adapters + registry',
    }
  }

  async fetchContent(request: SourceFetchRequest): Promise<SourceFetchResult> {
    if (request.signal.aborted) {
      return { operationId: request.operationId, status: 'cancelled' }
    }
    const url = request.source.observed_urls[0]
    if (!url) {
      return {
        operationId: request.operationId,
        status: 'failed',
        failureCategory: 'not_found',
        message: 'source has no observed URL',
      }
    }
    try {
      const response = await this.options.fetch(url, { signal: request.signal })
      if (!response.ok) {
        return {
          operationId: request.operationId,
          status: 'failed',
          failureCategory: 'network_error',
          message: `HTTP ${response.status}`,
        }
      }
      const buf = Buffer.from(await response.arrayBuffer())
      if (buf.length === 0) {
        return {
          operationId: request.operationId,
          status: 'failed',
          failureCategory: 'empty_body',
          message: 'source has no retrievable bytes',
        }
      }
      const limit = this.options.maxAdmittedBytes
      const truncated = typeof limit === 'number' && limit > 0 && buf.byteLength > limit
      const admittedBytes = truncated ? buf.subarray(0, limit) : buf
      const contentHash = sha256(admittedBytes)
      const mediaType = response.headers.get('content-type')?.split(';')[0]?.trim() ?? 'application/octet-stream'
      const revision: SourceRevision = {
        revision_id: issueRevisionId(request.source.source_id, contentHash),
        source_id: request.source.source_id,
        content_hash: contentHash,
        retrieved_at: new Date().toISOString(),
        extraction_version: 'fetch-source-access-1',
        media_type: mediaType,
        completeness: truncated ? 'truncated' : 'complete',
        byte_length_received: admittedBytes.byteLength,
        truncation_reason: truncated ? 'host_byte_limit' : undefined,
      }
      const admitted: AdmittedContent = {
        operation_id: request.operationId,
        revision,
        media_type: mediaType,
        provenance: {
          requested_url: url,
          final_url: url,
          redirect_chain: [url],
        },
        payload: {
          mode: 'inline_bytes',
          bytes_base64: admittedBytes.toString('base64'),
          byte_length: admittedBytes.byteLength,
          content_hash: contentHash,
        },
        ...(truncated && typeof limit === 'number'
          ? {
              truncation: {
                reason: 'host_byte_limit',
                bytes_received: buf.byteLength,
                bytes_limit: limit,
              },
            }
          : {}),
      }
      if (request.signal.aborted) {
        return { operationId: request.operationId, status: 'cancelled' }
      }
      return { operationId: request.operationId, status: 'ok', admitted }
    } catch (err: unknown) {
      if (request.signal.aborted) {
        return { operationId: request.operationId, status: 'cancelled' }
      }
      return {
        operationId: request.operationId,
        status: 'failed',
        failureCategory: 'network_error',
        message: err instanceof Error ? err.message : String(err),
      }
    }
  }
}
