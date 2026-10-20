import { z } from 'zod'
import { RecordIdSchema } from './common.js'

export const WriterOwnershipAcquireSchema = z
  .object({
    mission_id: RecordIdSchema,
    /** Must match store generation when resuming; omit only for first acquire after mission create. */
    expected_writer_generation: z.number().int().nonnegative().optional(),
  })
  .strict()

export const WriterOwnershipReplaceSchema = z
  .object({
    mission_id: RecordIdSchema,
    writer_generation: z.number().int().nonnegative(),
    rationale: z.string().min(1),
  })
  .strict()

export type WriterOwnershipAcquire = z.infer<typeof WriterOwnershipAcquireSchema>
export type WriterOwnershipReplace = z.infer<typeof WriterOwnershipReplaceSchema>
