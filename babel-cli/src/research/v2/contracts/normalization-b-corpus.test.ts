/**
 * Regression: all six Agent B original mission.json briefs (verbatim on disk).
 * B reported G-DEV-02 (missing as_of, hard_requirements) and G-DEV-06 (notes)
 * fail against frozen A 74ee4276 — not substitutes or inlined copies.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import {
  GeneralMissionBriefSchema,
  normalizeGeneralMissionBrief,
} from './normalization.js'
import { ResearchMissionV2Schema } from './mission.js'

const corpusDir = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/general-dev-brief-corpus')
const manifest = JSON.parse(
  readFileSync(join(corpusDir, 'BRIEF_FIXTURE_MANIFEST.json'), 'utf8'),
) as {
  cases: Record<string, { sha256: string }>
}

const CASE_IDS = ['G-DEV-01', 'G-DEV-02', 'G-DEV-03', 'G-DEV-04', 'G-DEV-05', 'G-DEV-06'] as const

function loadOriginalBrief(caseId: string): unknown {
  const rel = join(caseId, 'mission.json')
  const bytes = readFileSync(join(corpusDir, rel))
  const sha = createHash('sha256').update(bytes).digest('hex')
  const expected = manifest.cases[caseId]?.sha256
  assert.equal(sha, expected, `${caseId} mission.json bytes changed from B original`)
  return JSON.parse(bytes.toString('utf8'))
}

const normalizeOpts = (missionId: string) => ({
  mission_id: missionId,
  created_at: '2026-10-20T12:00:00.000Z',
  profile_version: '0.0.0-checkpoint',
})

describe('normalizeGeneralMissionBrief — six original B mission.json files', () => {
  for (const caseId of CASE_IDS) {
    it(`${caseId}: GeneralMissionBriefSchema accepts verbatim JSON`, () => {
      const brief = loadOriginalBrief(caseId)
      GeneralMissionBriefSchema.parse(brief)
    })

    it(`${caseId}: normalizes to ResearchMissionV2 without cast`, () => {
      const brief = loadOriginalBrief(caseId)
      const mission = normalizeGeneralMissionBrief(brief, normalizeOpts(caseId))
      ResearchMissionV2Schema.parse(mission)
      assert.equal(mission.profile_id, 'general')
    })
  }

  it('G-DEV-02: missing as_of becomes unknown; hard_requirements preserved', () => {
    const brief = loadOriginalBrief('G-DEV-02')
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
    const brief = loadOriginalBrief('G-DEV-06')
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
      const brief = loadOriginalBrief(caseId)
      assert.throws(() => ResearchMissionV2Schema.parse(brief))
    }
  })
})
