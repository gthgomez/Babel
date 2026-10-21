#!/usr/bin/env node
/**
 * Non-network G-L1 preflight: mission schema, effective model route, search provider wiring.
 * No secrets printed.
 */
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')
const missionPath = join(here, 'mission.json')

const { ResearchMissionV2Schema } = await import(
  join(repoRoot, 'babel-cli/src/research/v2/contracts/mission.ts')
)
const { resolveEffectiveResearchV2ModelRouteForCli } = await import(
  join(repoRoot, 'babel-cli/src/research/v2/model/researchV2ModelRoute.ts')
)
const { verifyEffectiveResearchV2OpenRouterRouteForCampaignPreflight } = await import(
  join(repoRoot, 'babel-cli/src/research/v2/model/researchV2ModelRoute.ts')
)
const { createMissionProductionSearchProvider } = await import(
  join(repoRoot, 'babel-cli/src/research/v2/access/createMissionProductionSearchProvider.ts')
)
const {
  resolveProductionSearchProviderId,
  DUCKDUCKGO_HTML_FALLBACK_PROVIDER_ID,
  buildDuckDuckGoHtmlSearchUrl,
} = await import(join(repoRoot, 'babel-cli/src/research/v2/access/babelConfiguredWebSearch.ts'))
const { getProviderCredentialStatus } = await import(
  join(repoRoot, 'babel-cli/src/runners/credentialHub.ts')
)

const raw = JSON.parse(await readFile(missionPath, 'utf8'))
const mission = ResearchMissionV2Schema.parse(raw)
const routeKey = 'deepseek-v4-flash-openrouter'
const env = { ...process.env }
const effectiveRoute = resolveEffectiveResearchV2ModelRouteForCli(env, routeKey)
const campaignRoute = verifyEffectiveResearchV2OpenRouterRouteForCampaignPreflight(env, routeKey)
const providerId = resolveProductionSearchProviderId(env)
const search = createMissionProductionSearchProvider({ mission, env })
const discoverQuery =
  mission.primary_question.split(/\s+/).slice(0, 8).join(' ')
const openrouterCred = getProviderCredentialStatus('openrouter', env)

const missionRoute = mission.model_route
const routeAligned =
  missionRoute.backend_key === campaignRoute.route_key &&
  missionRoute.provider === campaignRoute.provider &&
  missionRoute.provider_model_id === campaignRoute.model_id

const payload = {
  schema: 'general-g-l1-preflight/v1',
  runtime_sha: '9d97448a20045b2f4eec7b6f06bac9a533fc5424',
  mission_id: mission.mission_id,
  mission_file: missionPath,
  mission_model_route: {
    backend_key: missionRoute.backend_key,
    provider: missionRoute.provider,
    provider_model_id: missionRoute.provider_model_id,
    fixture_route: missionRoute.fixture_route ?? false,
  },
  effective_cli_route: effectiveRoute,
  campaign_openrouter_preflight: {
    route_key: campaignRoute.route_key,
    provider: campaignRoute.provider,
    model_id: campaignRoute.model_id,
    selection_basis: campaignRoute.selection_basis,
    policy_path: campaignRoute.policy_path,
  },
  env_override_active:
    Boolean(env.BABEL_RESEARCH_V2_PROVIDER?.trim()) && Boolean(env.BABEL_RESEARCH_V2_MODEL_ID?.trim()),
  mission_route_matches_policy: routeAligned,
  openrouter_credential: {
    configured: openrouterCred.configured,
    env_var: 'OPENROUTER_API_KEY',
  },
  search_transport: {
    provider_id: providerId,
    expected_provider_id: DUCKDUCKGO_HTML_FALLBACK_PROVIDER_ID,
    limitations: search.limitations,
    discover_query_default: discoverQuery,
    duckduckgo_search_url_template: 'https://duckduckgo.com/html/?q=<query>',
    example_search_url: buildDuckDuckGoHtmlSearchUrl(discoverQuery),
  },
  evidence_web_domains: mission.source_policy.allowed_web_domains ?? [],
  live_api_gate_env: 'BABEL_RESEARCH_V2_ALLOW_LIVE_API',
  live_api_gate_enabled: env.BABEL_RESEARCH_V2_ALLOW_LIVE_API === '1',
}

console.log(JSON.stringify(payload, null, 2))

if (!routeAligned) {
  console.error('preflight: mission model_route disagrees with effective policy route')
  process.exit(1)
}
if (providerId !== DUCKDUCKGO_HTML_FALLBACK_PROVIDER_ID) {
  console.error('preflight: search provider not duckduckgo_html_fallback')
  process.exit(1)
}
if (!openrouterCred.configured) {
  console.error('preflight: OPENROUTER_API_KEY not configured')
  process.exit(1)
}

console.log('general-g-l1-preflight: ok')
