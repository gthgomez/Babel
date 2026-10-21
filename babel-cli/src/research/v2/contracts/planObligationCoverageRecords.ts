import { z } from 'zod'
import { RecordIdSchema } from './common.js'

export const PlanObligationCoverageStatusSchema = z.enum([
  'met',
  'unmet',
  'wrong_aspect',
  'not_assessed',
])

export const PlanObligationCoverageRecordSchema = z
  .object({
    obligation_id: z.string().min(1),
    status: PlanObligationCoverageStatusSchema,
    supporting_passage_ids: z.array(RecordIdSchema).optional(),
  })
  .strict()

export type PlanObligationCoverageRecord = z.infer<typeof PlanObligationCoverageRecordSchema>
