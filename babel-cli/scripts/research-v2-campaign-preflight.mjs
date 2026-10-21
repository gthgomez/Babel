#!/usr/bin/env node
/**
 * Non-secret campaign preflight at current HEAD: OpenRouter route lane, mission file parse,
 * and DuckDuckGo HTML search URL shape for discover (no live model/search dispatch).
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyEffectiveResearchV2OpenRouterRouteForCampaignPreflight } from '../src/research/v2/model/researchV2ModelRoute.ts'
import { buildDuckDuckGoHtmlSearchUrl, resolveProductionSearchProviderId } from '../src/research/v2/access/babelConfiguredWebSearch.ts'
import { ResearchMissionV2Schema } from '../src/research/v2/contracts/mission.ts'

const babelCliRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const missionPath = join(babelCliRoot, 'src/research/v2/fixtures/campaign/G-L1-mission.json')

const route = verifyEffectiveResearchV2OpenRouterRouteForCampaignPreflight(process.env)
const mission = ResearchMissionV2Schema.parse(JSON.parse(readFileSync(missionPath, 'utf8')))
const discoverQuery =
  process.env.BABEL_RESEARCH_V2_G_L1_DISCOVER_QUERY?.trim() ??
  mission.primary_question.split(/\s+/).slice(0, 12).join(' ')
const searchProviderId = resolveProductionSearchProviderId(process.env)
const searchUrl = searchProviderId ? buildDuckDuckGoHtmlSearchUrl(discoverQuery) : null

const payload = {
  schema: 'research-v2-campaign-preflight/v1',
  head_note: 'No live API calls; campaign OpenRouter lane only',
  openrouter_route: route,
  mission_file: missionPath,
  mission_id: mission.mission_id,
  profile_id: mission.profile_id,
  allowed_web_domains: mission.source_policy.allowed_web_domains ?? [],
  discover_query: discoverQuery,
  search_provider_id: searchProviderId,
  search_url: searchUrl,
  acceptance_scenario: 'G-L1',
}
console.log(JSON.stringify(payload, null, 2))
console.log('research-v2-campaign-preflight: ok')
