/**
 * B reconciliation candidate only — NOT wired into FetchSourceAccessPort.
 * Agent A owns the shared Content-Encoding decoder; reconcile or replace this module
 * when integrating. See review-artifacts/b-gzip-transport-reconciliation.md
 */
import { gunzipSync } from 'node:zlib'

export interface ExpandAdmittedTransportBodyParams {
  wireBytes: Buffer
  contentEncodingHeader: string | null | undefined
  maxDecompressedBytes: number
  signal: AbortSignal
}

export type ExpandAdmittedTransportBodyResult =
  | { status: 'ok'; body: Buffer; contentEncodingApplied: string | null }
  | { status: 'failed'; failureCategory: 'extraction_failed'; message: string }
  | { status: 'cancelled' }

function headerValue(
  headers: Record<string, string | string[] | undefined> | undefined,
  name: string,
): string | null {
  if (!headers) return null
  const raw = headers[name.toLowerCase()]
  if (raw === undefined) return null
  return Array.isArray(raw) ? raw.join(', ') : raw
}

/** Returns true when the header lists gzip (single coding token or comma-separated). */
export function contentEncodingIncludesGzip(contentEncodingHeader: string | null | undefined): boolean {
  if (!contentEncodingHeader) return false
  return contentEncodingHeader
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .some((token) => token === 'gzip' || token.endsWith('.gzip'))
}

/**
 * Expand compressed wire bytes before inline admission (transport boundary).
 * Only decompresses when the response Content-Encoding header lists gzip.
 */
export function expandAdmittedTransportBody(
  params: ExpandAdmittedTransportBodyParams,
  responseHeaders?: Record<string, string | string[] | undefined>,
): ExpandAdmittedTransportBodyResult {
  if (params.signal.aborted) {
    return { status: 'cancelled' }
  }
  const encoding =
    params.contentEncodingHeader ?? headerValue(responseHeaders, 'content-encoding')
  if (!contentEncodingIncludesGzip(encoding)) {
    return { status: 'ok', body: params.wireBytes, contentEncodingApplied: null }
  }
  if (params.signal.aborted) {
    return { status: 'cancelled' }
  }
  try {
    const body = gunzipSync(params.wireBytes, {
      maxOutputLength: params.maxDecompressedBytes,
    })
    if (params.signal.aborted) {
      return { status: 'cancelled' }
    }
    return { status: 'ok', body, contentEncodingApplied: 'gzip' }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
    if (code === 'ERR_BUFFER_TOO_LARGE' || /maxOutputLength|output length/i.test(message)) {
      return {
        status: 'failed',
        failureCategory: 'extraction_failed',
        message: 'decompressed body exceeds admitted size limit',
      }
    }
    return {
      status: 'failed',
      failureCategory: 'extraction_failed',
      message: 'gzip body could not be decompressed',
    }
  }
}
