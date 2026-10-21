#!/usr/bin/env node
/**
 * Non-secret technical campaign preflight: mission parse, adapter resolution labels,
 * pinned versions record, and production search routing shapes (no live model/GitHub/PDF fetch).
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyEffectiveResearchV2OpenRouterRouteForCampaignPreflight } from '../src/research/v2/model/researchV2ModelRoute.ts'
import { ResearchMissionV2Schema } from '../src/research/v2/contracts/mission.ts'
import { createCombinedResearchRegistries } from '../src/research/v2/registry/reviewedBAdapterIntegration.ts'
import { resolveDiscoveryAdapterForMission } from '../src/research/v2/registry/missionAdapterResolution.ts'
import { TECHNICAL_REPOSITORY_FILE_ADAPTER_ID } from '../src/research/v2/profiles/technical/repositoryFileAdapter.ts'

const babelCliRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const campaignDir = join(babelCliRoot, 'src/research/v2/fixtures/campaign')
const pinsPath = join(campaignDir, 'T-L1-T-L2-PINNED-VERSIONS.json')
const tL1Path = join(campaignDir, 'T-L1-mission.json')
const tL2Path = join(campaignDir, 'T-L2-mission.json')

const route = verifyEffectiveResearchV2OpenRouterRouteForCampaignPreflight(process.env)
const pins = JSON.parse(readFileSync(pinsPath, 'utf8'))
const tL1 = ResearchMissionV2Schema.parse(JSON.parse(readFileSync(tL1Path, 'utf8')))
const tL2 = ResearchMissionV2Schema.parse(JSON.parse(readFileSync(tL2Path, 'utf8')))
const registries = await createCombinedResearchRegistries()
const tL1Discovery = resolveDiscoveryAdapterForMission(tL1, registries)
const tL2Discovery = resolveDiscoveryAdapterForMission(tL2, registries)

const tL1DiscoverQuery =
  process.env.BABEL_RESEARCH_V2_T_L1_DISCOVER_QUERY?.trim() ??
  'research v2 store executor boundary'
const tL2DiscoverQuery =
  process.env.BABEL_RESEARCH_V2_T_L2_DISCOVER_QUERY?.trim() ??
  'durable research store persistence'

const payload = {
  schema: 'research-v2-technical-campaign-preflight/v1',
  head_note: 'No live API calls; OpenRouter lane + mission/adapter labels only',
  openrouter_route: route,
  pinned_versions_file: pinsPath,
  pinned_versions: pins,
  missions: {
    'T-L1': {
      acceptance_scenario: 'T-L1',
      mission_file: tL1Path,
      mission_id: tL1.mission_id,
      profile_id: tL1.profile_id,
      discover_query: tL1DiscoverQuery,
      discovery_adapter_id: tL1Discovery?.adapterId ?? null,
      allowed_source_classes: tL1.source_policy.allowed_source_classes,
      pinned_commit_sha: tL1.pinned_target_repository?.commit_sha,
    },
    'T-L2': {
      acceptance_scenario: 'T-L2',
      mission_file: tL2Path,
      mission_id: tL2.mission_id,
      profile_id: tL2.profile_id,
      discover_query: tL2DiscoverQuery,
      discovery_adapter_id: tL2Discovery?.adapterId ?? null,
      allowed_source_classes: tL2.source_policy.allowed_source_classes,
      selected_document_refs: tL2.source_policy.selected_document_refs,
      pinned_commit_sha: tL2.pinned_target_repository?.commit_sha,
      document_search_note:
        'Production document discover requires sourceClasses=[document] per request; engine retrieval is currently single-candidate per pass.',
    },
  },
  expected_discovery_adapter_id: TECHNICAL_REPOSITORY_FILE_ADAPTER_ID,
}
console.log(JSON.stringify(payload, null, 2))
console.log('research-v2-technical-campaign-preflight: ok')
