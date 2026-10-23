import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { ResearchMissionV2Schema } from '../contracts/mission.js'
import { buildPlanRevisionFromPlanQuestions, missionRequirementsPayload } from './planFromModelOutput.js'
import { missionCoverageSourceSlots } from './missionCoverageSourceSlots.js'

const gL3Mission = ResearchMissionV2Schema.parse(
  JSON.parse(
    readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../fixtures/campaign/G-L3-mission.json'),
      'utf8',
    ),
  ),
)

/** Representative production planner output for G-L3 (criterion obligations, not closed technical_effect taxonomy). */
const productionPlannerOutput = {
  kind: 'plan_questions',
  questions: [
    {
      text: 'What stable CPython version and release date does the official downloads landing page state?',
      importance: 'critical',
      evidence_requirement:
        'Admitted excerpt from python.org downloads landing with explicit stable version and calendar release date',
      coverage_obligations: [
        {
          obligation_id: 'ob-downloads-stable-version-date',
          source_slot: 'web-ref-0',
          criterion_id: 'stable_release_version_and_date_downloads',
          evidence_requirement:
            'Quote or paraphrase the stable release version and release date shown on the downloads landing excerpt',
        },
      ],
    },
    {
      text: 'What stable CPython version and release date does the official developer guide versions status table state?',
      importance: 'critical',
      evidence_requirement:
        'Admitted excerpt from devguide.python.org versions table with explicit stable version and calendar release date',
      coverage_obligations: [
        {
          obligation_id: 'ob-devguide-stable-version-date',
          source_slot: 'web-ref-1',
          criterion_id: 'stable_release_version_and_date_devguide',
          evidence_requirement:
            'Quote or paraphrase the stable release version and release date shown on the devguide status table excerpt',
        },
      ],
    },
    {
      text: 'Do the downloads landing and devguide status table agree on stable release version and date?',
      importance: 'critical',
      evidence_requirement:
        'Both slots admitted; compare only after each criterion obligation is met — otherwise report unresolved comparison',
      coverage_obligations: [
        {
          obligation_id: 'ob-compare-downloads',
          source_slot: 'web-ref-0',
          criterion_id: 'stable_release_version_and_date_downloads',
          evidence_requirement: 'Downloads landing stable version and date for comparison',
        },
        {
          obligation_id: 'ob-compare-devguide',
          source_slot: 'web-ref-1',
          criterion_id: 'stable_release_version_and_date_devguide',
          evidence_requirement: 'Devguide table stable version and date for comparison',
        },
      ],
    },
  ],
}

describe('G-L3 production planner mapping (planFromModelOutput)', () => {
  it('persists per-question evidence_requirement and criterion-based obligations', () => {
    const plan = buildPlanRevisionFromPlanQuestions({
      mission: gL3Mission,
      planRevisionId: 'plan-g-l3-prod-map',
      revisionReason: 'model_plan_questions',
      createdAt: '2026-10-21T13:10:00.000Z',
      modelOutput: productionPlannerOutput,
    })
    assert.equal(plan.questions.length, 3)
    const compare = plan.questions[2]!
    assert.match(compare.evidence_requirement, /unresolved comparison/i)
    const obligations = compare.coverage_obligations ?? []
    assert.equal(obligations.length, 2)
    assert.equal(obligations[0]?.criterion_id, 'stable_release_version_and_date_downloads')
    assert.equal(obligations[0]?.aspect, undefined)
    assert.equal(obligations[1]?.source_slot, 'web-ref-1')
  })

  it('missionRequirementsPayload exposes web-ref slots aligned with planner source_slot ids', () => {
    const payload = missionRequirementsPayload(gL3Mission)
    const slots = missionCoverageSourceSlots(gL3Mission)
    assert.deepEqual(payload.coverage_source_slots, ['web-ref-0', 'web-ref-1'])
    assert.deepEqual(slots, ['web-ref-0', 'web-ref-1'])
    const plan = buildPlanRevisionFromPlanQuestions({
      mission: gL3Mission,
      planRevisionId: 'plan-g-l3-slots',
      revisionReason: 'model_plan_questions',
      createdAt: '2026-10-21T13:10:00.000Z',
      modelOutput: productionPlannerOutput,
    })
    for (const question of plan.questions) {
      for (const obligation of question.coverage_obligations ?? []) {
        assert.ok(slots.includes(obligation.source_slot))
      }
    }
  })

  it('rejects mixing criterion_id with legacy aspect on the same obligation', () => {
    assert.throws(() =>
      buildPlanRevisionFromPlanQuestions({
        mission: gL3Mission,
        planRevisionId: 'plan-g-l3-mixed-shape',
        revisionReason: 'model_plan_questions',
        createdAt: '2026-10-21T13:10:00.000Z',
        modelOutput: {
          kind: 'plan_questions',
          questions: [
            {
              text: 'Release date on downloads?',
              importance: 'high',
              coverage_obligations: [
                {
                  obligation_id: 'ob-bad-mix',
                  source_slot: 'web-ref-0',
                  criterion_id: 'stable_release_version_and_date_downloads',
                  evidence_requirement: 'Stable version and date from downloads excerpt',
                  aspect: 'technical_effect',
                  technical_effect: 'authentication_mechanism',
                },
              ],
            },
          ],
        },
      }),
    )
  })
})
