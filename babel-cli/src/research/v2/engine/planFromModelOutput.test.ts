import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ResearchMissionV2Schema } from '../contracts/mission.js'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildPlanRevisionFromPlanQuestions } from './planFromModelOutput.js'
import { PlanCoverageObligationValidationError } from './missionCoverageSourceSlots.js'

const mission = ResearchMissionV2Schema.parse(
  JSON.parse(
    readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../fixtures/campaign/G-L2-mission.json'),
      'utf8',
    ),
  ),
)

describe('buildPlanRevisionFromPlanQuestions', () => {
  it('persists validated coverage_obligations from model plan output', () => {
    const plan = buildPlanRevisionFromPlanQuestions({
      mission,
      planRevisionId: 'plan-wire-test',
      revisionReason: 'test',
      createdAt: '2026-10-21T12:00:00.000Z',
      modelOutput: {
        kind: 'plan_questions',
        questions: [
          {
            text: 'Compare max-age per source',
            importance: 'critical',
            coverage_obligations: [
              {
                obligation_id: 'ob-0-max',
                source_slot: 'web-ref-0',
                aspect: 'technical_effect',
                technical_effect: 'max_age_or_ttl_semantics',
              },
              {
                obligation_id: 'ob-1-max',
                source_slot: 'web-ref-1',
                aspect: 'technical_effect',
                technical_effect: 'max_age_or_ttl_semantics',
              },
            ],
          },
        ],
      },
    })
    assert.equal(plan.questions[0]?.coverage_obligations?.length, 2)
    assert.equal(plan.questions[0]?.coverage_obligations?.[0]?.source_slot, 'web-ref-0')
  })

  it('rejects obligations referencing unknown mission slots', () => {
    assert.throws(
      () =>
        buildPlanRevisionFromPlanQuestions({
          mission,
          planRevisionId: 'plan-bad-slot',
          revisionReason: 'test',
          createdAt: '2026-10-21T12:00:00.000Z',
          modelOutput: {
            kind: 'plan_questions',
            questions: [
              {
                text: 'Bad slot',
                importance: 'high',
                coverage_obligations: [
                  {
                    obligation_id: 'ob-bad',
                    source_slot: 'not-a-mission-slot',
                    aspect: 'technical_effect',
                    technical_effect: 'general_technical',
                  },
                ],
              },
            ],
          },
        }),
      PlanCoverageObligationValidationError,
    )
  })

  it('rejects malformed obligation aspect shape via Zod', () => {
    assert.throws(() =>
      buildPlanRevisionFromPlanQuestions({
        mission,
        planRevisionId: 'plan-malformed',
        revisionReason: 'test',
        createdAt: '2026-10-21T12:00:00.000Z',
        modelOutput: {
          kind: 'plan_questions',
          questions: [
            {
              text: 'Missing technical_effect',
              importance: 'high',
              coverage_obligations: [
                {
                  obligation_id: 'ob-x',
                  source_slot: 'web-ref-0',
                  aspect: 'technical_effect',
                },
              ],
            },
          ],
        },
      }),
    )
  })
})
