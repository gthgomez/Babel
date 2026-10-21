import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { ResearchMissionV2Schema } from '../../contracts/mission.js'

const missionPath = join(dirname(fileURLToPath(import.meta.url)), 'G-L1-mission.json')

const CANONICAL_G_L1_QUESTION =
  "As of the run's UTC date, what is the latest stable Python release and its release date? Distinguish stable releases from prereleases, cite the official Python release/download page, and report uncertainty if official pages disagree or cannot be read."

describe('G-L1 campaign mission fixture', () => {
  it('parses canonical public-fact Python mission with OpenRouter route and evidence + search domains', () => {
    const mission = ResearchMissionV2Schema.parse(JSON.parse(readFileSync(missionPath, 'utf8')))
    assert.equal(mission.mission_id, 'mission-g-l1-general-live')
    assert.equal(mission.profile_id, 'general')
    assert.equal(mission.primary_question, CANONICAL_G_L1_QUESTION)
    assert.equal(mission.model_route.provider, 'openrouter')
    assert.equal(mission.model_route.provider_model_id, 'deepseek/deepseek-v4-flash-0731')
    assert.equal(mission.model_route.fixture_route, undefined)
    const domains = mission.source_policy.allowed_web_domains ?? []
    assert.ok(domains.includes('duckduckgo.com'))
    assert.ok(domains.includes('python.org'))
    assert.ok(domains.includes('www.python.org'))
    assert.ok(domains.includes('docs.python.org'))
    assert.deepEqual(mission.source_policy.allowed_source_classes, ['web'])
  })
})
