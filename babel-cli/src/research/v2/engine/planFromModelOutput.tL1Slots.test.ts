import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { ResearchMissionV2Schema } from '../contracts/mission.js'
import { missionRequirementsPayload } from './planFromModelOutput.js'
import { missionCoverageSourceSlots } from './missionCoverageSourceSlots.js'

const tL1Mission = ResearchMissionV2Schema.parse(
  JSON.parse(
    readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../fixtures/campaign/T-L1-mission.json'),
      'utf8',
    ),
  ),
)

describe('T-L1 missionRequirementsPayload slots', () => {
  it('derives repository-pin slots from the canonical mission source directory', () => {
    const slots = missionCoverageSourceSlots(tL1Mission)
    assert.deepEqual(slots, ['repository-pin-0', 'repository-pin-1'])
    const payload = missionRequirementsPayload(tL1Mission)
    assert.deepEqual(payload.coverage_source_slots, slots)
    assert.ok(!payload.coverage_source_slots.includes('discover-primary'))
  })
})
