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

export const MissionSourcePolicyV2Schema = z
  .object({
    allowed_source_classes: z.array(SourceClassSchema).min(1),
    /** Host-enforced domain patterns; adapters cannot expand. */
    allowed_web_domains: z.array(z.string().min(1)).optional(),
    selected_document_refs: z.array(z.string().min(1)).optional(),
    selected_repository_refs: z.array(PinnedRepositoryRefSchema).optional(),
    visibility_retention: VisibilityRetentionPolicySchema,
  })
  .strict()

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
