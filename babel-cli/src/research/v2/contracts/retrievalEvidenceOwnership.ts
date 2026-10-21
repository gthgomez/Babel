import { z } from 'zod'
import { RecordIdSchema } from './common.js'

/** Mission + source_fetch operation + attempt that admitted revision/passage bytes. */
export const SourceFetchEvidenceOwnerSchema = z
  .object({
    mission_id: RecordIdSchema,
    operation_id: RecordIdSchema,
    attempt_id: RecordIdSchema,
  })
  .strict()

export type SourceFetchEvidenceOwner = z.infer<typeof SourceFetchEvidenceOwnerSchema>

export function sourceFetchEvidenceOwnerKey(owner: SourceFetchEvidenceOwner): string {
  return `${owner.mission_id}\0${owner.operation_id}\0${owner.attempt_id}`
}
