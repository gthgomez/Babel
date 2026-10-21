import { z } from 'zod'
import {
  HostEffortPolicySchema,
  IsoDateTimeSchema,
  JurisdictionSchema,
  ModelRouteReferenceSchema,
  ModelRouteReceiptSchema,
  PinnedRepositoryRefSchema,
  RecordIdSchema,
  TimeRangeSchema,
  UnknownValueSchema,
  VisibilityRetentionPolicySchema,
} from './common.js'
import { RESEARCH_V2_CONTRACT_VERSION } from './version.js'

export const RESEARCH_MISSION_V2_SCHEMA_ID = 'research-mission-v2' as const

export const SourceClassSchema = z.enum([
  'web',
  'document',
  'repository_file',
  'paper',
  'structured',
])

export const MissionDocumentContentPinKindSchema = z.enum([
  'mutable_locator_content_digest',
  'immutable_versioned_source',
])

export const MissionAdmittedDocumentSourceSchema = z
  .object({
    /** Must match an entry in selected_document_refs (exact mission-selected URL). */
    document_ref: z.string().url(),
    content_pin_kind: MissionDocumentContentPinKindSchema,
    /** Required when content_pin_kind is immutable_versioned_source. */
    source_version_id: z.string().min(1).optional(),
    wire_byte_budget: z.number().int().positive(),
    decompressed_byte_budget: z.number().int().positive(),
    expected_content_sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/i),
    expected_byte_length: z.number().int().positive(),
    require_complete_body: z.literal(true),
    /** Optional extraction completeness expectation for admitted PDFs. */
    expected_pdf_page_count: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((entry, ctx) => {
    if (
      entry.content_pin_kind === 'immutable_versioned_source' &&
      !entry.source_version_id?.trim()
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'source_version_id is required for immutable_versioned_source',
        path: ['source_version_id'],
      })
    }
  })

export const MissionSourcePolicyV2Schema = z
  .object({
    allowed_source_classes: z.array(SourceClassSchema).min(1),
    /** Host-enforced domain patterns; adapters cannot expand. */
    allowed_web_domains: z.array(z.string().min(1)).optional(),
    selected_document_refs: z.array(z.string().min(1)).optional(),
    admitted_document_sources: z.array(MissionAdmittedDocumentSourceSchema).optional(),
    selected_repository_refs: z.array(PinnedRepositoryRefSchema).optional(),
    visibility_retention: VisibilityRetentionPolicySchema,
  })
  .strict()
  .superRefine((policy, ctx) => {
    const selected = new Set(policy.selected_document_refs ?? [])
    for (const [index, entry] of (policy.admitted_document_sources ?? []).entries()) {
      if (!selected.has(entry.document_ref)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'admitted_document_sources.document_ref must be mission-selected',
          path: ['admitted_document_sources', index, 'document_ref'],
        })
      }
    }
  })

export const ResearchMissionV2Schema = z
  .object({
    schema_version: z.literal(RESEARCH_MISSION_V2_SCHEMA_ID),
    contract_version: z.literal(RESEARCH_V2_CONTRACT_VERSION),
    mission_id: RecordIdSchema,
    profile_id: z.string().min(1),
    profile_version: z.string().min(1),
    created_at: IsoDateTimeSchema,
    primary_question: z.string().min(1),
    intended_decision: z.string().min(1),
    constraints: z.array(z.string()),
    exclusions: z.array(z.string()),
    as_of: UnknownValueSchema,
    time_range: TimeRangeSchema.optional(),
    jurisdiction: JurisdictionSchema.optional(),
    source_policy: MissionSourcePolicyV2Schema,
    effort_policy: HostEffortPolicySchema,
    model_route: ModelRouteReferenceSchema,
    /** Populated after first resolved invocation; optional at creation. */
    model_route_receipt: ModelRouteReceiptSchema.optional(),
    /** Technical applicability target; optional for general missions. */
    pinned_target_repository: PinnedRepositoryRefSchema.optional(),
  })
  .strict()

export type ResearchMissionV2 = z.infer<typeof ResearchMissionV2Schema>
export type MissionAdmittedDocumentSource = z.infer<typeof MissionAdmittedDocumentSourceSchema>
