<<<<<<< HEAD
import { EXA_LITE_SEARCH_PROVIDER_ID, resolveProductionSearchProviderId } from '../access/babelConfiguredWebSearch.js'
import { exaApiKeyConfigured } from '../access/exaLiteSearchCredentials.js'
=======
import { resolveProductionSearchProviderId } from '../access/babelConfiguredWebSearch.js'
>>>>>>> origin/pr-406-head
import type { ResearchMissionV2 } from '../contracts/mission.js'
import { getProviderCredentialStatus } from '../../../runners/credentialHub.js'
import {
  type EffectiveResearchV2ModelRoute,
  verifyEffectiveResearchV2OpenRouterRouteForCampaignPreflight,
} from '../model/researchV2ModelRoute.js'

export const RESEARCH_V2_CAMPAIGN_IDS = ['G-L1', 'G-L2', 'G-L3'] as const
export type ResearchV2CampaignId = (typeof RESEARCH_V2_CAMPAIGN_IDS)[number]

export function missionFileNameForCampaign(campaign: string): string | null {
  const normalized = campaign.trim().toUpperCase()
  const map: Record<string, string> = {
    'G-L1': 'G-L1-mission.json',
    'G-L2': 'G-L2-mission.json',
    'G-L3': 'G-L3-mission.json',
  }
  return map[normalized] ?? null
}

export function assertMissionModelRouteMatchesEffectiveOpenRouterRoute(
  mission: ResearchMissionV2,
  effective: EffectiveResearchV2ModelRoute,
): void {
  const missionRoute = mission.model_route
  const provider = missionRoute.provider.trim().toLowerCase()
  if (provider !== effective.provider.trim().toLowerCase()) {
    throw new Error(
      `mission model_route.provider (${missionRoute.provider}) does not match effective route (${effective.provider})`,
    )
  }
  const missionBackend = missionRoute.backend_key.trim()
  if (missionBackend !== effective.backend_key.trim()) {
    throw new Error(
      `mission model_route.backend_key (${missionBackend}) does not match effective route (${effective.backend_key})`,
    )
  }
  const missionModelId = missionRoute.provider_model_id?.trim()
  if (!missionModelId) {
    throw new Error('mission model_route.provider_model_id is required for campaign preflight')
  }
  if (missionModelId !== effective.model_id.trim()) {
    throw new Error(
      `mission model_route.provider_model_id (${missionModelId}) does not match effective route (${effective.model_id})`,
    )
  }
}

export interface ResearchV2CampaignPreflightReadiness {
  search_provider_configured: boolean
  mission_model_route_matches_effective: boolean
  openrouter_credential_configured: boolean
  ready: boolean
  failures: string[]
}

export function evaluateResearchV2CampaignPreflightReadiness(
  mission: ResearchMissionV2,
  env: NodeJS.ProcessEnv = process.env,
): ResearchV2CampaignPreflightReadiness {
  const failures: string[] = []
  const searchProviderId = resolveProductionSearchProviderId(env)
  if (!searchProviderId) {
    failures.push('unsupported_or_null_search_provider')
  }
<<<<<<< HEAD
  if (searchProviderId === EXA_LITE_SEARCH_PROVIDER_ID && !exaApiKeyConfigured(env)) {
    failures.push('exa_api_key_not_configured')
  }
=======
>>>>>>> origin/pr-406-head

  let missionModelRouteMatchesEffective = false
  try {
    const effective = verifyEffectiveResearchV2OpenRouterRouteForCampaignPreflight(env)
    assertMissionModelRouteMatchesEffectiveOpenRouterRoute(mission, effective)
    missionModelRouteMatchesEffective = true
  } catch (error) {
    failures.push(
      error instanceof Error ? error.message : 'mission_model_route_mismatch_or_route_resolution_failed',
    )
  }

  const openrouterCredential = getProviderCredentialStatus('openrouter', env)
  if (!openrouterCredential.configured) {
    failures.push('openrouter_credential_not_configured')
  }

  return {
    search_provider_configured: searchProviderId !== null,
    mission_model_route_matches_effective: missionModelRouteMatchesEffective,
    openrouter_credential_configured: openrouterCredential.configured,
    ready: failures.length === 0,
    failures,
  }
}

export interface ResearchV2CampaignPreflightPayload {
  schema: 'research-v2-campaign-preflight/v1'
  head_note: string
  acceptance_scenario: string
  readiness: ResearchV2CampaignPreflightReadiness
  openrouter_route: EffectiveResearchV2ModelRoute
  openrouter_credential: {
    provider: string
    env_var: string | null
    configured: boolean
    required: boolean
  }
  mission_id: string
  profile_id: string
  primary_question: string
  search_provider_id: string | null
  expected_outcomes: unknown
}

export function buildResearchV2CampaignPreflightPayload(input: {
  campaign: string
  mission: ResearchMissionV2
  expectedOutcomes: unknown
  env?: NodeJS.ProcessEnv
}): ResearchV2CampaignPreflightPayload {
  const env = input.env ?? process.env
  const route = verifyEffectiveResearchV2OpenRouterRouteForCampaignPreflight(env)
  const readiness = evaluateResearchV2CampaignPreflightReadiness(input.mission, env)
  const credential = getProviderCredentialStatus('openrouter', env)
  return {
    schema: 'research-v2-campaign-preflight/v1',
    head_note: 'No live API calls; campaign OpenRouter lane and host readiness only',
    acceptance_scenario: input.campaign.trim().toUpperCase(),
    readiness,
    openrouter_route: route,
    openrouter_credential: {
      provider: credential.provider,
      env_var: credential.envVar,
      configured: credential.configured,
      required: credential.required,
    },
    mission_id: input.mission.mission_id,
    profile_id: input.mission.profile_id,
    primary_question: input.mission.primary_question,
    search_provider_id: resolveProductionSearchProviderId(env),
    expected_outcomes: input.expectedOutcomes,
  }
}
