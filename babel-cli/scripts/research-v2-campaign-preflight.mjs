#!/usr/bin/env node
/**
 * Non-secret campaign preflight at current HEAD: OpenRouter route lane, mission file parse,
 * search provider configuration, mission/effective route parity, and credential presence (no secret values).
 *
 * BABEL_RESEARCH_V2_CAMPAIGN=G-L1|G-L2|G-L3 (default G-L1)
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildDuckDuckGoHtmlSearchUrl } from '../src/research/v2/access/babelConfiguredWebSearch.ts'
import { ResearchMissionV2Schema } from '../src/research/v2/contracts/mission.ts'
import {
  buildResearchV2CampaignPreflightPayload,
  missionFileNameForCampaign,
} from '../src/research/v2/campaign/researchV2CampaignPreflight.ts'

const babelCliRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const campaign = (process.env.BABEL_RESEARCH_V2_CAMPAIGN ?? 'G-L1').trim().toUpperCase()
const missionFileName = missionFileNameForCampaign(campaign)
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

const mission = ResearchMissionV2Schema.parse(JSON.parse(readFileSync(missionPath, 'utf8')))
const expectedOutcomes = JSON.parse(readFileSync(outcomesPath, 'utf8'))
const discoverQuery =
  process.env.BABEL_RESEARCH_V2_CAMPAIGN_DISCOVER_QUERY?.trim() ??
  mission.primary_question.split(/\s+/).slice(0, 12).join(' ')
const allowedWebDomains = mission.source_policy.allowed_web_domains ?? []
const searchTransportDomains = ['duckduckgo.com', 'html.duckduckgo.com']
const evidenceWebDomains = allowedWebDomains.filter((d) => !searchTransportDomains.includes(d))
const basePayload = buildResearchV2CampaignPreflightPayload({ campaign, mission, expectedOutcomes })
const searchUrl = basePayload.search_provider_id
  ? buildDuckDuckGoHtmlSearchUrl(discoverQuery)
  : null

const payload = {
  ...basePayload,
  mission_file: missionPath,
  expected_outcomes_file: outcomesPath,
  allowed_web_domains: allowedWebDomains,
  evidence_web_domains: evidenceWebDomains,
  search_transport_domains: searchTransportDomains.filter((d) => allowedWebDomains.includes(d)),
  discover_query: discoverQuery,
  search_url: searchUrl,
}
console.log(JSON.stringify(payload, null, 2))
if (!payload.readiness.ready) {
  console.error(
    `research-v2-campaign-preflight: not ready (${campaign}): ${payload.readiness.failures.join(', ')}`,
  )
  process.exit(1)
}
console.log(`research-v2-campaign-preflight: ok (${campaign})`)
