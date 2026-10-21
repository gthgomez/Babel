import type { AdmittedHttpGetResult } from './admittedHttpGet.js'
import { sanitizedHttpFailureMetadataFromGet } from './sanitizedHttpFailureMetadata.js'
import {
  type SourceAcquisitionDiagnostics,
  SourceAcquisitionDiagnosticsSchema,
  sanitizeAcquisitionUrl,
} from '../contracts/sourceAcquisitionDiagnostics.js'

function headerValue(header: string | string[] | undefined): string | undefined {
  if (header === undefined) return undefined
  return Array.isArray(header) ? header.join(', ') : header
}

function buildRawPayload(
  response: AdmittedHttpGetResult,
  params: { attemptedUrl: string; sourceId?: string; truncationReason?: string },
): SourceAcquisitionDiagnostics {
  const coding = response.transportCoding
  return {
    evidence_role: 'attempted_source',
    attempted_url: sanitizeAcquisitionUrl(params.attemptedUrl),
    final_url: sanitizeAcquisitionUrl(response.finalUrl),
    http_status: response.status,
    content_type: response.contentType,
    content_encoding: headerValue(response.responseHeaders?.['content-encoding']),
    wire_bytes_received: response.bytesReceived,
    ...(params.sourceId ? { source_id: params.sourceId } : {}),
    ...(coding
      ? {
          decoded_byte_length: coding.decoded_byte_length,
          admitted_decoded_byte_length:
            coding.admitted_decoded_byte_length ?? response.buffer.byteLength,
          ...(coding.decoded_truncated === true ? { decoded_truncated: true } : {}),
        }
      : { admitted_decoded_byte_length: response.buffer.byteLength }),
    ...(params.truncationReason ? { truncation_reason: params.truncationReason } : {}),
    ...(response.ok
      ? {}
      : (() => {
          const httpFailure = sanitizedHttpFailureMetadataFromGet(response)
          return httpFailure ? { http_failure: httpFailure } : {}
        })()),
  }
}

/**
 * Parse acquisition diagnostics through the contract schema. Preserves `http_status` (and
 * transport scalars) even when bounded `http_failure` metadata fails validation.
 */
export function parseAcquisitionDiagnosticsFromHttpGet(
  response: AdmittedHttpGetResult,
  params: { attemptedUrl: string; sourceId?: string; truncationReason?: string },
): SourceAcquisitionDiagnostics {
  const raw = buildRawPayload(response, params)
  const parsed = SourceAcquisitionDiagnosticsSchema.safeParse(raw)
  if (parsed.success) {
    return parsed.data
  }
  const { http_failure: _dropped, ...withoutHttpFailure } = raw
  const fallback = SourceAcquisitionDiagnosticsSchema.safeParse(withoutHttpFailure)
  if (fallback.success) {
    return fallback.data
  }
  return SourceAcquisitionDiagnosticsSchema.parse({
    evidence_role: 'attempted_source',
    attempted_url: sanitizeAcquisitionUrl(params.attemptedUrl),
    http_status: response.status,
  })
}
