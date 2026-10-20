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

export const ModelRouteReferenceSchema = z
  .object({
    /** Host config key or explicit backend name; not a secret. */
    backend_key: z.string().min(1),
    provider: z.string().min(1),
    /** Resolved upstream model slug when known. */
    provider_model_id: z.string().min(1).optional(),
  })
  .strict()

/** Non-secret routing receipt bound to a single admitted invocation. */
export const ModelRouteReceiptSchema = z
  .object({
    operation_id: RecordIdSchema,
    backend_key: z.string().min(1),
    provider: z.string().min(1),
    provider_model_id: z.string().min(1),
    resolved_at: IsoDateTimeSchema,
    /** Host-native usage fields; never API keys or raw env. */
    usage: z
      .object({
        input_tokens: z.number().int().nonnegative().optional(),
        output_tokens: z.number().int().nonnegative().optional(),
        total_cost_usd: z.number().nonnegative().optional(),
        cost_status: z.enum(['reported', 'estimated', 'unknown']),
      })
      .strict()
      .optional(),
  })
  .strict()

export const HostEffortPolicySchema = z
  .object({
    /** Resolved by host from mission + global policy; models cannot raise these. */
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
