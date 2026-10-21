import { z } from 'zod'
import { ContentHashSchema, RecordIdSchema } from './common.js'
import { PassageLocatorSchema } from './passageLocator.js'

export const PASSAGE_INTEGRITY_RECORD_VERSION = 'passage-integrity-v1'
export const PASSAGE_INTEGRITY_VERIFIER = 'babel-admitted-extraction'
export const PASSAGE_INTEGRITY_VERIFIER_VERSION = '1.0.0'

const SUPPORTED_PASSAGE_INTEGRITY_VERIFIER_VERSIONS: ReadonlySet<string> = new Set([
  PASSAGE_INTEGRITY_VERIFIER_VERSION,
])

export function isSupportedPassageIntegrityVerifierVersion(version: string): boolean {
  return SUPPORTED_PASSAGE_INTEGRITY_VERIFIER_VERSIONS.has(version)
}
export const PASSAGE_INTEGRITY_VERIFICATION_SCOPE = 'admitted_representation'
export const PASSAGE_INTEGRITY_RETENTION = 'verification_receipt_and_excerpt'

export const PassageIntegrityVerificationSchema = z
  .object({
    version: z.literal(PASSAGE_INTEGRITY_RECORD_VERSION),
    verifier: z.literal(PASSAGE_INTEGRITY_VERIFIER),
    verifier_version: z.string().min(1),
    source_id: RecordIdSchema,
    source_revision_id: RecordIdSchema,
    source_content_hash: ContentHashSchema,
    admitted_byte_length: z.number().int().nonnegative(),
    extraction_version: z.string().min(1),
    passage_id: RecordIdSchema,
    locator: PassageLocatorSchema,
    passage_text_hash: ContentHashSchema,
    verification_scope: z.literal(PASSAGE_INTEGRITY_VERIFICATION_SCOPE),
    retention: z.literal(PASSAGE_INTEGRITY_RETENTION),
  })
  .strict()

export type PassageIntegrityVerification = z.infer<typeof PassageIntegrityVerificationSchema>
