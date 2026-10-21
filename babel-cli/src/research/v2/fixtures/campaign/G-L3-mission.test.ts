import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { ResearchMissionV2Schema } from '../../contracts/mission.js'

const missionPath = join(dirname(fileURLToPath(import.meta.url)), 'G-L3-mission.json')
const outcomesPath = join(dirname(fileURLToPath(import.meta.url)), 'G-L3-expected-outcomes.json')

describe('G-L3 campaign mission fixture', () => {
  it('parses contradiction/insufficiency mission with official python.org scope', () => {
    const mission = ResearchMissionV2Schema.parse(JSON.parse(readFileSync(missionPath, 'utf8')))
    const outcomes = JSON.parse(readFileSync(outcomesPath, 'utf8'))
    assert.equal(mission.mission_id, outcomes.mission_id)
    assert.equal(mission.profile_id, 'general')
    assert.ok(mission.constraints.some((c) => c.includes('semantic_support_must_be_per_question')))
    const domains = mission.source_policy.allowed_web_domains ?? []
    assert.ok(domains.includes('www.python.org'))
    assert.ok(domains.includes('docs.python.org'))
    assert.deepEqual(outcomes.acceptance_scenario, 'G-L3')
    assert.ok(outcomes.structural.must_allow_terminal_partial_on_insufficient_or_contradicted)
  })
})
