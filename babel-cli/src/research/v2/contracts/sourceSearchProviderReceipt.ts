import { z } from 'zod'

/** Sanitized discovery-only provider metadata (compatible with B #404 handoff). */
export const SourceSearchProviderReceiptSchema = z
  .object({
    configured_provider_id: z.string().min(1),
    effective_provider_id: z.string().min(1),
    degradation: z
      .object({
        from_provider_id: z.string().min(1),
        to_provider_id: z.string().min(1),
        reason: z.string().min(1),
      })
      .strict()
      .optional(),
    exa_lite: z
      .object({
        requestId: z.unknown().optional(),
        resolvedSearchType: z.unknown().optional(),
        warnings: z.unknown().optional(),
        notices: z.unknown().optional(),
        costDollars: z.unknown().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()

export type SourceSearchProviderReceipt = z.infer<typeof SourceSearchProviderReceiptSchema>
