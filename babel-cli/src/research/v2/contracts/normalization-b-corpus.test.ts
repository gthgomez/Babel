import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { normalizeGeneralMissionBrief } from './normalization.js'
import { GENERAL_DEV_BRIEF_FIXTURES } from '../fixtures/generalDevBriefCorpus.js'
import { ResearchMissionV2Schema } from './mission.js'

const normalizeOpts = (missionId: string) => ({
  mission_id: missionId,
  created_at: '2026-10-20T12:00:00.000Z',
  profile_version: '0.0.0-checkpoint',
})

describe('normalizeGeneralMissionBrief — Agent B dev corpus', () => {
  for (const [fixtureId, brief] of Object.entries(GENERAL_DEV_BRIEF_FIXTURES)) {
    it(`normalizes ${fixtureId} without cast`, () => {
      const mission = normalizeGeneralMissionBrief(brief, normalizeOpts(fixtureId))
      ResearchMissionV2Schema.parse(mission)
      assert.equal(mission.profile_id, 'general')
    })
  }

  it('preserves G-DEV-02 hard_requirements and unknown as_of', () => {
    const mission = normalizeGeneralMissionBrief(
      GENERAL_DEV_BRIEF_FIXTURES['G-DEV-02'],
      normalizeOpts('mission-g-dev-02'),
    )
    assert.equal(mission.as_of, 'unknown')
    assert.ok(mission.constraints.some((c) => c === 'hard_requirement:usb_c_displayport_alt_mode'))
    assert.ok(mission.constraints.some((c) => c.includes('max_budget_usd')))
  })

  it('preserves G-DEV-06 mission notes', () => {
    const mission = normalizeGeneralMissionBrief(
      GENERAL_DEV_BRIEF_FIXTURES['G-DEV-06'],
      normalizeOpts('mission-g-dev-06'),
    )
    assert.ok(mission.constraints.some((c) => c.startsWith('mission_note:')))
  })
})
