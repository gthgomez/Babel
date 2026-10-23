import { z } from 'zod'

/** Aligns with B #404 `SourceSearchExaParticipation` (`access/EXA_SEARCH_RECEIPT_HANDOFF.md`). */
export const SourceSearchExaParticipationSchema = z.enum([
  'exa_primary_ok',
  'exa_primary_empty_billed',
  'exa_primary_failed',
  'exa_degraded_fallback',
])

export type SourceSearchExaParticipation = z.infer<typeof SourceSearchExaParticipationSchema>

/** Bounded structured diagnostics (B `SourceSearchExaLiteDiagnosticRecord`; handoff add62bfc). */
export const SourceSearchExaLiteDiagnosticRecordSchema = z
  .object({
    code: z.string().min(1),
    path: z.string().nullable(),
    message: z.string().min(1),
    details: z.record(z.string(), z.string()).nullable(),
  })
  .strict()

export type SourceSearchExaLiteDiagnosticRecord = z.infer<
  typeof SourceSearchExaLiteDiagnosticRecordSchema
>

export const SourceSearchExaLiteReceiptMetadataSchema = z
  .object({
    request_id: z.string().nullable(),
    resolved_search_type: z.string().nullable(),
    warnings: z.array(SourceSearchExaLiteDiagnosticRecordSchema),
    notices: z.array(SourceSearchExaLiteDiagnosticRecordSchema),
    /** Provider-reported estimate only — not an invoice. */
    estimated_cost_dollars: z.number().nullable(),
    estimated_cost_detail: z.record(z.string(), z.number()).nullable(),
  })
  .strict()

export type SourceSearchExaLiteReceiptMetadata = z.infer<
  typeof SourceSearchExaLiteReceiptMetadataSchema
>

/** Discovery-only provider metadata (B `SourceSearchProviderReceipt`; A propagates downstream). */
export const SourceSearchProviderReceiptSchema = z
  .object({
    configured_provider_id: z.string().min(1),
    effective_provider_id: z.string().min(1),
    exa_participation: SourceSearchExaParticipationSchema.optional(),
    degradation: z
      .object({
        from_provider_id: z.string().min(1),
        to_provider_id: z.string().min(1),
        reason: z.string().min(1),
      })
      .strict()
      .optional(),
    exa_lite: SourceSearchExaLiteReceiptMetadataSchema.optional(),
  })
  .strict()

export type SourceSearchProviderReceipt = z.infer<typeof SourceSearchProviderReceiptSchema>
