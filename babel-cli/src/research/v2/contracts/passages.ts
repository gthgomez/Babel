import { z } from 'zod'
import { ContentHashSchema, RecordIdSchema } from './common.js'
import { PassageIntegrityVerificationSchema } from './passageIntegrity.js'
import { PassageLocatorSchema } from './passageLocator.js'
import { SourceFetchEvidenceOwnerSchema } from './retrievalEvidenceOwnership.js'

export { PassageLocatorSchema } from './passageLocator.js'

export const PassageTextRefSchema = z.discriminatedUnion('mode', [
  z
    .object({
      mode: z.literal('inline'),
      text: z.string().min(1).max(32_000),
      text_hash: ContentHashSchema,
    })
    .strict(),
  z
    .object({
      mode: z.literal('blob_ref'),
      blob_ref: z.string().min(1),
      text_hash: ContentHashSchema,
    })
    .strict(),
])

export const PassageRecordSchema = z
  .object({
    passage_id: RecordIdSchema,
    source_revision_id: RecordIdSchema,
    locator: PassageLocatorSchema,
    text_ref: PassageTextRefSchema,
    heading_path: z.array(z.string()).optional(),
    extraction_notes: z.array(z.string()).optional(),
    source_fetch_owner: SourceFetchEvidenceOwnerSchema.optional(),
    integrity_verification: PassageIntegrityVerificationSchema.optional(),
  })
  .strict()

export type PassageRecord = z.infer<typeof PassageRecordSchema>
