import { z } from 'zod'
import { ResearchMissionV2Schema, type ResearchMissionV2 } from './mission.js'
import { RESEARCH_V2_CONTRACT_VERSION } from './version.js'

/** Agent B corpus brief shape — not a valid ResearchMissionV2 until normalized. */
export const GeneralMissionBriefSchema = z
  .object({
    profile_id: z.literal('general'),
    primary_question: z.string().min(1),
    intended_decision: z.string().min(1).optional(),
    as_of: z.union([z.string().min(1), z.literal('unknown')]),
    jurisdiction: z.union([z.string().min(1), z.literal('unknown')]).optional(),
    constraints: z.union([z.array(z.string()), z.record(z.string(), z.unknown())]).optional(),
    exclusions: z.array(z.string()).optional(),
  })
  .strict()

export type GeneralMissionBrief = z.infer<typeof GeneralMissionBriefSchema>

export const FIXTURE_MODEL_ROUTE = {
  backend_key: 'fixture-model-route',
  provider: 'fixture',
  provider_model_id: 'fixture/general-research-model',
  fixture_route: true,
} as const

function flattenConstraints(constraints: GeneralMissionBrief['constraints']): string[] {
  if (!constraints) return []
  if (Array.isArray(constraints)) return constraints
  return Object.entries(constraints).map(([key, value]) => `${key}=${JSON.stringify(value)}`)
}

/**
 * Explicit normalization for B-owned mission brief fixtures. Never cast brief JSON to V2.
 */
export function normalizeGeneralMissionBrief(
  brief: unknown,
  options: {
    mission_id: string
    created_at: string
    profile_version: string
  },
): ResearchMissionV2 {
  const parsed = GeneralMissionBriefSchema.parse(brief)
  const mission = {
    schema_version: 'research-mission-v2',
    contract_version: RESEARCH_V2_CONTRACT_VERSION,
    mission_id: options.mission_id,
    profile_id: parsed.profile_id,
    profile_version: options.profile_version,
    created_at: options.created_at,
    primary_question: parsed.primary_question,
    intended_decision: parsed.intended_decision ?? 'Answer the primary question with cited evidence.',
    constraints: flattenConstraints(parsed.constraints),
    exclusions: parsed.exclusions ?? [],
    as_of: parsed.as_of,
    jurisdiction: parsed.jurisdiction ?? 'unknown',
    source_policy: {
      allowed_source_classes: ['web', 'document'],
      visibility_retention: {
        source_visibility: 'public',
        retention: 'excerpt_only',
        export_may_omit_bytes: true,
      },
    },
    effort_policy: {
      preset_name: 'normal',
      resolved_budget_label: 'host-resolved-normal-fixture',
    },
    model_route: FIXTURE_MODEL_ROUTE,
  }
  return ResearchMissionV2Schema.parse(mission)
}
