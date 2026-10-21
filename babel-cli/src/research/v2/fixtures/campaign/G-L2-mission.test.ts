import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { ResearchMissionV2Schema } from '../../contracts/mission.js'

const missionPath = join(dirname(fileURLToPath(import.meta.url)), 'G-L2-mission.json')
const outcomesPath = join(dirname(fileURLToPath(import.meta.url)), 'G-L2-expected-outcomes.json')

describe('G-L2 campaign mission fixture', () => {
  it('parses constrained-comparison mission with public MDN + Cloudflare scope', () => {
    const mission = ResearchMissionV2Schema.parse(JSON.parse(readFileSync(missionPath, 'utf8')))
    const outcomes = JSON.parse(readFileSync(outcomesPath, 'utf8'))
    assert.equal(mission.mission_id, outcomes.mission_id)
    assert.equal(mission.profile_id, 'general')
    assert.ok(mission.primary_question.includes('MDN'))
    assert.ok(mission.primary_question.includes('Cloudflare'))
    const domains = mission.source_policy.allowed_web_domains ?? []
    assert.ok(domains.includes('developer.mozilla.org'))
    assert.ok(domains.includes('developers.cloudflare.com'))
    assert.deepEqual(outcomes.acceptance_scenario, 'G-L2')
  })
})
