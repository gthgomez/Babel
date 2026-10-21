import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { ResearchMissionV2Schema } from '../../contracts/mission.js'

const missionPath = join(dirname(fileURLToPath(import.meta.url)), 'G-L1-mission.json')

describe('G-L1 campaign mission fixture', () => {
  it('parses as ResearchMissionV2 with production OpenRouter route and web search domains', () => {
    const mission = ResearchMissionV2Schema.parse(JSON.parse(readFileSync(missionPath, 'utf8')))
    assert.equal(mission.mission_id, 'mission-g-l1-general-live')
    assert.equal(mission.profile_id, 'general')
    assert.equal(mission.model_route.provider, 'openrouter')
    assert.equal(mission.model_route.fixture_route, undefined)
    assert.ok(mission.source_policy.allowed_web_domains?.includes('duckduckgo.com'))
    assert.deepEqual(mission.source_policy.allowed_source_classes, ['web'])
  })
})
