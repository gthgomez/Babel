import { z } from 'zod'
import { IsoDateTimeSchema, RecordIdSchema, UsageSettlementSchema } from './common.js'

export const ExternalOperationKindSchema = z.enum([
  'source_search',
  'source_fetch',
  'model_invoke',
])

export const OperationSettlementStateSchema = z.enum([
  'succeeded',
  'failed',
  'cancelled',
  'uncertain',
])

export const ExternalOperationIntentSchema = z
  .object({
    operation_id: RecordIdSchema,
    operation_kind: ExternalOperationKindSchema,
    dispatched_at: IsoDateTimeSchema,
    idempotency_key: z.string().min(1),
  })
  .strict()

export const ExternalOperationCompletionSchema = z
  .object({
    operation_id: RecordIdSchema,
    completed_at: IsoDateTimeSchema,
    settlement: OperationSettlementStateSchema,
    usage_settlement: UsageSettlementSchema.optional(),
    failure_category: z.string().optional(),
    message: z.string().optional(),
  })
  .strict()

export const ExternalOperationReconciliationSchema = z
  .object({
    operation_id: RecordIdSchema,
    reconciled_at: IsoDateTimeSchema,
    prior_settlement: OperationSettlementStateSchema,
    resolved_settlement: OperationSettlementStateSchema,
    usage_settlement: UsageSettlementSchema,
    rationale: z.string().min(1),
  })
  .strict()

export type ExternalOperationIntent = z.infer<typeof ExternalOperationIntentSchema>
export type ExternalOperationCompletion = z.infer<typeof ExternalOperationCompletionSchema>
export type ExternalOperationReconciliation = z.infer<typeof ExternalOperationReconciliationSchema>
