import { z } from 'zod'
import { IsoDateTimeSchema, RecordIdSchema, UsageSettlementSchema } from './common.js'
import { SourceAcquisitionDiagnosticsSchema } from './sourceAcquisitionDiagnostics.js'
import { ProviderInvokeDiagnosticsSchema } from './providerInvokeDiagnostics.js'
import { SourceSearchProviderReceiptSchema } from './sourceSearchProviderReceipt.js'

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
    mission_id: RecordIdSchema,
    operation_id: RecordIdSchema,
    attempt_id: RecordIdSchema,
    operation_kind: ExternalOperationKindSchema,
    dispatched_at: IsoDateTimeSchema,
    idempotency_key: z.string().min(1),
  })
  .strict()

export const ExternalOperationCompletionSchema = z
  .object({
    mission_id: RecordIdSchema,
    operation_id: RecordIdSchema,
    attempt_id: RecordIdSchema,
    completed_at: IsoDateTimeSchema,
    settlement: OperationSettlementStateSchema,
    usage_settlement: UsageSettlementSchema.optional(),
    failure_category: z.string().optional(),
    message: z.string().optional(),
    acquisition_diagnostics: SourceAcquisitionDiagnosticsSchema.optional(),
    provider_invoke_diagnostics: ProviderInvokeDiagnosticsSchema.optional(),
    search_provider_receipt: SourceSearchProviderReceiptSchema.optional(),
  })
  .strict()

export const ExternalOperationReconciliationSchema = z
  .object({
    mission_id: RecordIdSchema,
    operation_id: RecordIdSchema,
    attempt_id: RecordIdSchema,
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
