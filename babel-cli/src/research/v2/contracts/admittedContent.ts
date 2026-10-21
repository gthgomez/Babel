import { z } from 'zod'
import { ContentHashSchema, RecordIdSchema } from './common.js'
import { SourceRevisionSchema } from './sources.js'

export const RepositoryFilePinProvenanceSchema = z
  .object({
    /** Commit-pinned github.com/.../blob/{sha}/... URL from source observed_urls (not transport). */
    pinned_blob_url: z.string().url(),
  })
  .strict()

export const HttpContentCodingProvenanceSchema = z
  .object({
    content_encodings: z.array(z.string().min(1)),
    encoded_byte_length: z.number().int().nonnegative(),
    decoded_byte_length: z.number().int().nonnegative(),
    admitted_representation: z.literal('decoded_bytes'),
  })
  .strict()

export const RedirectProvenanceSchema = z
  .object({
    requested_url: z.string().url(),
    final_url: z.string().url(),
    redirect_chain: z.array(z.string().url()),
    repository_file_pin: RepositoryFilePinProvenanceSchema.optional(),
    http_content_coding: HttpContentCodingProvenanceSchema.optional(),
  })
  .strict()

/** Inline bytes only for V2 contract MVP — hosts must not emit unresolved blob_ref admissions. */
export const AdmittedContentPayloadSchema = z
  .object({
    mode: z.literal('inline_bytes'),
    bytes_base64: z.string().min(1),
    byte_length: z.number().int().positive(),
    content_hash: ContentHashSchema,
  })
  .strict()

export const AdmittedContentSchema = z
  .object({
    operation_id: RecordIdSchema,
    revision: SourceRevisionSchema,
    media_type: z.string().min(1),
    provenance: RedirectProvenanceSchema,
    payload: AdmittedContentPayloadSchema,
    truncation: z
      .object({
        reason: z.string().min(1),
        bytes_received: z.number().int().nonnegative(),
        bytes_limit: z.number().int().positive(),
      })
      .strict()
      .optional(),
  })
  .strict()

export type AdmittedContent = z.infer<typeof AdmittedContentSchema>
