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
    assert.equal((mission.source_policy.selected_web_refs ?? []).length, 2)
    assert.deepEqual(outcomes.acceptance_scenario, 'G-L3')
    assert.ok(outcomes.structural.must_allow_terminal_partial_on_insufficient_or_contradicted)
    assert.ok(outcomes.structural.requires_two_distinct_canonical_pages)
    assert.deepEqual(outcomes.acceptable_terminal_states, ['partial', 'complete'])
    assert.ok(outcomes.structural.deterministic_insufficiency_fixture)
    const insufficiency = JSON.parse(
      readFileSync(
        join(dirname(fileURLToPath(import.meta.url)), outcomes.structural.deterministic_insufficiency_fixture),
        'utf8',
      ),
    )
    assert.equal(insufficiency.label, 'DETERMINISTIC_INSUFFICIENCY_FIXTURE')
    assert.ok(insufficiency.rules.never_invent_contradiction)
    assert.ok(insufficiency.rules.one_page_cannot_count_as_cross_page_coverage)
  })
})
