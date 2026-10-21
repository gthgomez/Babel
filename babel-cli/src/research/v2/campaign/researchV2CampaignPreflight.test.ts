import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { ResearchMissionV2Schema } from '../contracts/mission.js'
import {
  assertMissionModelRouteMatchesEffectiveOpenRouterRoute,
  evaluateResearchV2CampaignPreflightReadiness,
} from './researchV2CampaignPreflight.js'
import { verifyEffectiveResearchV2OpenRouterRouteForCampaignPreflight } from '../model/researchV2ModelRoute.js'

const campaignDir = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/campaign')

function loadMission(name: string) {
  return ResearchMissionV2Schema.parse(
    JSON.parse(readFileSync(join(campaignDir, name), 'utf8')),
  )
}

describe('research v2 campaign preflight readiness (no network)', () => {
  it('G-L3 mission model_route matches effective OpenRouter policy route', () => {
    const mission = loadMission('G-L3-mission.json')
    const effective = verifyEffectiveResearchV2OpenRouterRouteForCampaignPreflight({})
    assertMissionModelRouteMatchesEffectiveOpenRouterRoute(mission, effective)
  })

  it('exa_lite without EXA_API_KEY fails readiness (presence-only)', () => {
    const mission = loadMission('G-L3-mission.json')
    const readiness = evaluateResearchV2CampaignPreflightReadiness(mission, {
      ...process.env,
      BABEL_WEB_SEARCH_PROVIDER: 'exa_lite',
      EXA_API_KEY: '',
    })
    assert.ok(readiness.failures.includes('exa_api_key_not_configured'))
    assert.equal(readiness.ready, false)
  })

  it('unsupported BABEL_WEB_SEARCH_PROVIDER fails readiness without printing ok semantics', () => {
    const mission = loadMission('G-L3-mission.json')
    const readiness = evaluateResearchV2CampaignPreflightReadiness(mission, {
      ...process.env,
      BABEL_WEB_SEARCH_PROVIDER: 'unsupported_vendor',
    })
    assert.equal(readiness.search_provider_configured, false)
    assert.ok(readiness.failures.some((f) => f.includes('unsupported_or_null_search_provider')))
    assert.equal(readiness.ready, false)
  })
})
