import { z } from 'zod'
import { RecordIdSchema } from './common.js'
import type { AdmittedContent } from './admittedContent.js'

/**
 * Sanitized transport metadata for a failed or pre-citation acquisition attempt.
 * `attempted_source` is discover/fetch/read — not confirmed cited evidence (passages/findings).
 */
export const SourceAcquisitionDiagnosticsSchema = z
  .object({
    evidence_role: z.literal('attempted_source'),
    source_id: RecordIdSchema.optional(),
    attempted_url: z.string().url(),
    final_url: z.string().url().optional(),
    http_status: z.number().int().optional(),
    content_type: z.string().optional(),
    content_encoding: z.string().optional(),
    wire_bytes_received: z.number().int().nonnegative().optional(),
    decoded_byte_length: z.number().int().nonnegative().optional(),
    admitted_decoded_byte_length: z.number().int().nonnegative().optional(),
    decoded_truncated: z.boolean().optional(),
    truncation_reason: z.string().optional(),
    http_failure: z
      .object({
        public_message: z.string().max(512).optional(),
        public_message_qualifier: z
          .literal('unverified_github_json_message_field')
          .optional(),
        request_id: z.string().max(128).optional(),
        retry_after: z.string().max(64).optional(),
        rate_limit_remaining: z.string().max(32).optional(),
        rate_limit_reset: z.string().max(32).optional(),
        rate_limit_resource: z.string().max(64).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()

export type SourceAcquisitionDiagnostics = z.infer<typeof SourceAcquisitionDiagnosticsSchema>

export function sanitizeAcquisitionUrl(raw: string): string {
  try {
    const url = new URL(raw)
    if (url.username || url.password) {
      url.username = ''
      url.password = ''
    }
    return url.href
  } catch {
    return raw
  }
}

export function acquisitionDiagnosticsFromAdmitted(
  admitted: AdmittedContent,
  params?: { httpStatus?: number; contentEncoding?: string; wireBytesReceived?: number },
): SourceAcquisitionDiagnostics {
  const coding = admitted.provenance.http_content_coding
  const payload: SourceAcquisitionDiagnostics = {
    evidence_role: 'attempted_source',
    source_id: admitted.revision.source_id,
    attempted_url: sanitizeAcquisitionUrl(admitted.provenance.requested_url),
    final_url: sanitizeAcquisitionUrl(admitted.provenance.final_url),
    content_type: admitted.media_type,
    ...(params?.httpStatus !== undefined ? { http_status: params.httpStatus } : {}),
    ...(params?.contentEncoding
      ? { content_encoding: params.contentEncoding }
      : coding?.content_encodings.length
        ? { content_encoding: coding.content_encodings.join(', ') }
        : {}),
    ...(params?.wireBytesReceived !== undefined
      ? { wire_bytes_received: params.wireBytesReceived }
      : {}),
    ...(coding
      ? {
          decoded_byte_length: coding.decoded_byte_length,
          admitted_decoded_byte_length:
            coding.admitted_decoded_byte_length ?? admitted.payload.byte_length,
          ...(coding.decoded_truncated === true ? { decoded_truncated: true } : {}),
        }
      : { admitted_decoded_byte_length: admitted.payload.byte_length }),
    ...(admitted.revision.truncation_reason
      ? { truncation_reason: admitted.revision.truncation_reason }
      : {}),
  }
  return SourceAcquisitionDiagnosticsSchema.parse(payload)
}
