/**
 * Shared contract constants for B reciprocal tests (Agent A implements transport).
 * Attempt2 live store retained no wire bytes; refetch lengths/hashes are not original-response proof.
 */

/** Default admitted decode cap (matches FetchSourceAccessPort wire limit today). */
export const DEFAULT_MAX_DECODED_ADMISSION_BYTES = 200_000

/**
 * Bounded replay decompressed length for python.org/downloads HTML (refetch @ ec7).
 * Not byte-identical to the unknown original attempt2 response.
 */
export const G_L1_ATTEMPT2_REFETCH_DECOMPRESSED_LENGTH = 218_649

/**
 * Refetch-only SHA-256 of full decompressed python.org/downloads HTML (diagnostic v2).
 * Use for documentation cross-checks only — synthetic regression bodies use their own hashes.
 */
export const G_L1_ATTEMPT2_REFETCH_DECOMPRESSED_SHA256 =
  '722e474c17e2ede4ae61c2c69fc8331fc26b3aa4a116ba033ff0727f6e9f5d9b'

export type GzipWireAdmissionResult =
  | {
      status: 'ok'
      body: Buffer
      /** True when decoded plaintext exceeded maxDecodedBytes and was bounded. */
      truncated: boolean
      contentEncodingApplied: string | null
    }
  | { status: 'failed'; failureCategory: 'extraction_failed'; message: string }
  | { status: 'cancelled' }

export interface ExpandGzipWireAdmissionParams {
  wireBytes: Buffer
  contentEncodingHeader: string | null | undefined
  maxDecodedBytes: number
  signal: AbortSignal
  responseHeaders?: Record<string, string | string[] | undefined>
}

export type ExpandGzipWireAdmission = (
  params: ExpandGzipWireAdmissionParams,
) => GzipWireAdmissionResult

export function contentEncodingIncludesGzip(contentEncodingHeader: string | null | undefined): boolean {
  if (!contentEncodingHeader) return false
  return contentEncodingHeader
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .some((token) => token === 'gzip' || token.endsWith('.gzip'))
}
