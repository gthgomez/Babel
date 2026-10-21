import { z } from 'zod'
import { ContentHashSchema, RecordIdSchema } from './common.js'

export const TrustedPassageVerificationStatusSchema = z.enum([
  'verified_whole_source_complete',
  'mismatch_text',
  'mismatch_hash',
  'mismatch_locator',
  'mismatch_source',
  'mismatch_attempt',
  'truncated_partial',
  'legacy_not_checked',
])

export const TrustedPassageVerificationOutcomeSchema = z
  .object({
    status: TrustedPassageVerificationStatusSchema,
    passage_id: RecordIdSchema,
    source_revision_id: RecordIdSchema,
    operation_id: RecordIdSchema,
    attempt_id: RecordIdSchema,
    observed_text_hash: ContentHashSchema.optional(),
    expected_text_hash: ContentHashSchema.optional(),
    detail: z.string().max(512).optional(),
  })
  .strict()

export type TrustedPassageVerificationOutcome = z.infer<
  typeof TrustedPassageVerificationOutcomeSchema
>
