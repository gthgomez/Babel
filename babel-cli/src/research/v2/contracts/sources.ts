import { z } from 'zod'
import {
  ContentHashSchema,
  IsoDateTimeSchema,
  RecordIdSchema,
  UnknownValueSchema,
} from './common.js'
import { SourceFetchEvidenceOwnerSchema } from './retrievalEvidenceOwnership.js'
import { SourceClassSchema } from './mission.js'

export const SourceCompletenessSchema = z.enum([
  'complete',
  'truncated',
  'extraction_failed',
  'unavailable',
  'metadata_only',
])

export const CanonicalIdentifiersSchema = z
  .object({
    doi: z.string().min(1).optional(),
    arxiv_id: z.string().min(1).optional(),
    github_repo_id: z.string().min(1).optional(),
    github_commit_sha: z.string().regex(/^[a-f0-9]{40}$/i).optional(),
  })
  .strict()

export const SourceRecordSchema = z
  .object({
    source_id: RecordIdSchema,
    kind: SourceClassSchema,
    /** Stable identity; not deduplicated by URL alone. */
    canonical_key: z.string().min(1),
    observed_urls: z.array(z.string().url()).min(1),
    canonical_identifiers: CanonicalIdentifiersSchema.optional(),
    title: UnknownValueSchema.optional(),
    language: UnknownValueSchema.optional(),
    license_observed: UnknownValueSchema.optional(),
    syndication_notes: z.string().optional(),
    /** Logical provider slot for per-source coverage obligations (not a vendor id). */
    coverage_source_slot: z.string().min(1).optional(),
  })
  .strict()

export const SourceRevisionSchema = z
  .object({
    revision_id: RecordIdSchema,
    source_id: RecordIdSchema,
    content_hash: ContentHashSchema,
    retrieved_at: IsoDateTimeSchema,
    published_at: UnknownValueSchema.optional(),
    updated_at: UnknownValueSchema.optional(),
    extraction_version: z.string().min(1),
    media_type: z.string().min(1),
    completeness: SourceCompletenessSchema,
    byte_length_received: z.number().int().nonnegative().optional(),
    truncation_reason: z.string().optional(),
    access_notes: z.string().optional(),
    source_fetch_owner: SourceFetchEvidenceOwnerSchema.optional(),
  })
  .strict()

export type SourceRecord = z.infer<typeof SourceRecordSchema>
export type SourceRevision = z.infer<typeof SourceRevisionSchema>
