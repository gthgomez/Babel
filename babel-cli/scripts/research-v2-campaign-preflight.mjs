#!/usr/bin/env node
/**
 * Non-secret campaign preflight at current HEAD: OpenRouter route lane, mission file parse,
 * and DuckDuckGo HTML search URL shape for discover (no live model/search dispatch).
 *
 * BABEL_RESEARCH_V2_CAMPAIGN=G-L1|G-L2|G-L3 (default G-L1)
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyEffectiveResearchV2OpenRouterRouteForCampaignPreflight } from '../src/research/v2/model/researchV2ModelRoute.ts'
import { buildDuckDuckGoHtmlSearchUrl, resolveProductionSearchProviderId } from '../src/research/v2/access/babelConfiguredWebSearch.ts'
import { ResearchMissionV2Schema } from '../src/research/v2/contracts/mission.ts'

const babelCliRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const campaign = (process.env.BABEL_RESEARCH_V2_CAMPAIGN ?? 'G-L1').trim().toUpperCase()
const missionFileByCampaign = {
  'G-L1': 'G-L1-mission.json',
  'G-L2': 'G-L2-mission.json',
  'G-L3': 'G-L3-mission.json',
}
const missionFileName = missionFileByCampaign[campaign]
if (!missionFileName) {
  console.error(`unknown BABEL_RESEARCH_V2_CAMPAIGN: ${campaign}`)
  process.exit(1)
}
const missionPath = join(babelCliRoot, 'src/research/v2/fixtures/campaign', missionFileName)
const outcomesPath = join(
  babelCliRoot,
  'src/research/v2/fixtures/campaign',
  `${campaign}-expected-outcomes.json`,
)

const route = verifyEffectiveResearchV2OpenRouterRouteForCampaignPreflight(process.env)
const mission = ResearchMissionV2Schema.parse(JSON.parse(readFileSync(missionPath, 'utf8')))
const expectedOutcomes = JSON.parse(readFileSync(outcomesPath, 'utf8'))
const discoverQuery =
  process.env.BABEL_RESEARCH_V2_CAMPAIGN_DISCOVER_QUERY?.trim() ??
  mission.primary_question.split(/\s+/).slice(0, 12).join(' ')
const searchProviderId = resolveProductionSearchProviderId(process.env)
const searchUrl = searchProviderId ? buildDuckDuckGoHtmlSearchUrl(discoverQuery) : null
const allowedWebDomains = mission.source_policy.allowed_web_domains ?? []
const searchTransportDomains = ['duckduckgo.com', 'html.duckduckgo.com']
const evidenceWebDomains = allowedWebDomains.filter((d) => !searchTransportDomains.includes(d))

const payload = {
  schema: 'research-v2-campaign-preflight/v1',
  head_note: 'No live API calls; campaign OpenRouter lane only',
  openrouter_route: route,
  mission_file: missionPath,
  expected_outcomes_file: outcomesPath,
  mission_id: mission.mission_id,
  profile_id: mission.profile_id,
  primary_question: mission.primary_question,
  allowed_web_domains: allowedWebDomains,
  evidence_web_domains: evidenceWebDomains,
  search_transport_domains: searchTransportDomains.filter((d) => allowedWebDomains.includes(d)),
  discover_query: discoverQuery,
  search_provider_id: searchProviderId,
  search_url: searchUrl,
  acceptance_scenario: campaign,
  expected_outcomes: expectedOutcomes,
}
console.log(JSON.stringify(payload, null, 2))
console.log(`research-v2-campaign-preflight: ok (${campaign})`)
