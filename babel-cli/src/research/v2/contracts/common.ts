import { z } from 'zod'

/** Opaque stable identifiers issued by the host store. */
export const RecordIdSchema = z.string().min(1).max(128)
export type RecordId = z.infer<typeof RecordIdSchema>

export const IsoDateTimeSchema = z.string().datetime({ offset: true })

/** Explicit unknown sentinel — never infer from source prose. */
export const UnknownValueSchema = z.union([z.string().min(1), z.literal('unknown')])
export type UnknownValue = z.infer<typeof UnknownValueSchema>

export const JurisdictionSchema = UnknownValueSchema

export const TimeRangeSchema = z
  .object({
    start: UnknownValueSchema,
    end: UnknownValueSchema,
  })
  .strict()

export const ContentHashSchema = z.string().regex(/^[a-f0-9]{64}$/i, 'expected sha256 hex')

/** Required on every store append after the initial mission write. */
export const MissionWriteContextSchema = z
  .object({
    mission_id: RecordIdSchema,
    plan_revision_id: RecordIdSchema,
    /** Monotonic owner generation; stale writes fail closed. */
    writer_generation: z.number().int().nonnegative(),
  })
  .strict()
export type MissionWriteContext = z.infer<typeof MissionWriteContextSchema>

export const CostProvenanceSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('reported'),
      amount_usd: z.number().nonnegative(),
      currency: z.literal('USD'),
    })
    .strict(),
  z
    .object({
      status: z.literal('estimated'),
      amount_usd: z.number().nonnegative(),
      method: z.string().min(1),
      as_of: IsoDateTimeSchema,
    })
    .strict(),
  z.object({ status: z.literal('unknown') }).strict(),
])
export type CostProvenance = z.infer<typeof CostProvenanceSchema>

export const UsageSettlementSchema = z
  .object({
    input_tokens: z.number().int().nonnegative().optional(),
    output_tokens: z.number().int().nonnegative().optional(),
    cache_read_tokens: z.number().int().nonnegative().optional(),
    reasoning_tokens: z.number().int().nonnegative().optional(),
    cost: CostProvenanceSchema,
    attempt_id: RecordIdSchema,
  })
  .strict()
export type UsageSettlement = z.infer<typeof UsageSettlementSchema>

export const ModelRouteReferenceSchema = z
  .object({
    backend_key: z.string().min(1),
    provider: z.string().min(1),
    provider_model_id: z.string().min(1).optional(),
    /** True for corpus/fixture routes — not a live selected backend. */
    fixture_route: z.boolean().optional(),
  })
  .strict()

export const ModelRouteReceiptSchema = z
  .object({
    operation_id: RecordIdSchema,
    backend_key: z.string().min(1),
    provider: z.string().min(1),
    provider_model_id: z.string().min(1),
    resolved_at: IsoDateTimeSchema,
    usage_settlement: UsageSettlementSchema,
  })
  .strict()

export const HostEffortPolicySchema = z
  .object({
    preset_name: z.enum(['low', 'normal', 'deep']).optional(),
    resolved_budget_label: z.string().min(1),
  })
  .strict()

export const VisibilityRetentionPolicySchema = z
  .object({
    source_visibility: z.enum(['public', 'authorized_local', 'mission_private']),
    retention: z.enum(['excerpt_only', 'passage_blob', 'metadata_only']),
    export_may_omit_bytes: z.boolean(),
  })
  .strict()

export const PinnedRepositoryRefSchema = z
  .object({
    provider: z.literal('github'),
    repo_id: z.string().min(1),
    full_name: z.string().min(1),
    commit_sha: z.string().regex(/^[a-f0-9]{40}$/i),
  })
  .strict()
