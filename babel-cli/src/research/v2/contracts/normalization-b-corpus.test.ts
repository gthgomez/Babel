/**
 * Regression: all six Agent B original mission.json briefs (verbatim on disk).
 * B reported G-DEV-02 (missing as_of, hard_requirements) and G-DEV-06 (notes)
 * fail against frozen A 74ee4276 — not substitutes or inlined copies.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  GeneralMissionBriefSchema,
  normalizeGeneralMissionBrief,
} from './normalization.js'
import { ResearchMissionV2Schema } from './mission.js'
import {
  parseVerbatimBriefJson,
  type VerbatimBriefCaseId,
} from '../fixtures/general-dev-brief-corpus/verbatimBriefBytes.js'

const CASE_IDS: VerbatimBriefCaseId[] = [
  'G-DEV-01',
  'G-DEV-02',
  'G-DEV-03',
  'G-DEV-04',
  'G-DEV-05',
  'G-DEV-06',
]

const normalizeOpts = (missionId: string) => ({
  mission_id: missionId,
  created_at: '2026-10-20T12:00:00.000Z',
  profile_version: '0.0.0-checkpoint',
})

describe('normalizeGeneralMissionBrief — six original B mission.json files', () => {
  for (const caseId of CASE_IDS) {
    it(`${caseId}: GeneralMissionBriefSchema accepts verbatim JSON`, () => {
      const brief = parseVerbatimBriefJson(caseId)
      GeneralMissionBriefSchema.parse(brief)
    })

    it(`${caseId}: normalizes to ResearchMissionV2 without cast`, () => {
      const brief = parseVerbatimBriefJson(caseId)
      const mission = normalizeGeneralMissionBrief(brief, normalizeOpts(caseId))
      ResearchMissionV2Schema.parse(mission)
      assert.equal(mission.profile_id, 'general')
    })
  }

  it('G-DEV-02: missing as_of becomes unknown; hard_requirements preserved', () => {
    const brief = parseVerbatimBriefJson('G-DEV-02')
    assert.equal((brief as { as_of?: string }).as_of, undefined)
    assert.deepEqual((brief as { hard_requirements?: string[] }).hard_requirements, [
      'usb_c_displayport_alt_mode',
    ])
    const mission = normalizeGeneralMissionBrief(brief, normalizeOpts('G-DEV-02'))
    assert.equal(mission.as_of, 'unknown')
    assert.ok(
      mission.constraints.includes('hard_requirement:usb_c_displayport_alt_mode'),
      'hard_requirements must survive normalization',
    )
    assert.ok(mission.constraints.some((c) => c.includes('max_budget_usd')))
  })

  it('G-DEV-06: notes preserved; as_of from brief retained', () => {
    const brief = parseVerbatimBriefJson('G-DEV-06')
    assert.equal(
      (brief as { notes?: string }).notes,
      'Primary registry fixture is intentionally inaccessible.',
    )
    const mission = normalizeGeneralMissionBrief(brief, normalizeOpts('G-DEV-06'))
    assert.equal(mission.as_of, '2026-07-01')
    assert.ok(
      mission.constraints.some((c) =>
        c.includes('Primary registry fixture is intentionally inaccessible.'),
      ),
      'notes must survive normalization',
    )
  })

  it('verbatim briefs are not valid ResearchMissionV2 without normalization', () => {
    for (const caseId of CASE_IDS) {
      const brief = parseVerbatimBriefJson(caseId)
      assert.throws(() => ResearchMissionV2Schema.parse(brief))
    }
  })
})
