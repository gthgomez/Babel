import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { PlanRevisionSchema } from '../contracts/plan.js'
import { exampleTechnicalMissionFixture } from '../fixtures/exampleMission.js'
import { findingsFromExtractModelOutput } from './findingsFromModelOutput.js'

const plan = PlanRevisionSchema.parse({
  plan_revision_id: 'plan-extract-binding',
  mission_id: exampleTechnicalMissionFixture.mission_id,
  created_at: '2026-10-21T09:50:00.000Z',
  revision_reason: 'fixture',
  questions: [
    {
      question_id: 'q-alpha',
      text: 'Alpha?',
      importance: 'high',
      evidence_requirement: 'evidence',
      status: 'open',
    },
    {
      question_id: 'q-beta',
      text: 'Beta?',
      importance: 'high',
      evidence_requirement: 'evidence',
      status: 'open',
    },
  ],
})

describe('findingsFromExtractModelOutput question_id binding', () => {
  it('preserves validated question_id per finding (no Q[0] fallback)', () => {
    const findings = findingsFromExtractModelOutput({
      operationId: 'op-bind',
      plan,
      passages: [
        {
          passage_id: 'p-1',
          source_revision_id: 'rev-1',
          locator: { kind: 'section', section_id: 's' },
          text_ref: { mode: 'inline', text: 't', text_hash: 'a'.repeat(64) },
        },
      ],
      createdAt: '2026-10-21T09:50:00.000Z',
      modelOutput: {
        kind: 'extract_findings',
        findings: [
          {
            assertion_text: 'A',
            assertion_kind: 'source_observation',
            passage_ids: ['p-1'],
            question_id: 'q-alpha',
          },
          {
            assertion_text: 'B',
            assertion_kind: 'source_observation',
            passage_ids: ['p-1'],
            question_id: 'q-beta',
          },
        ],
      },
    })
    assert.deepEqual(findings.map((f) => f.question_id), ['q-alpha', 'q-beta'])
  })

  it('rejects unknown question_id', () => {
    assert.throws(
      () =>
        findingsFromExtractModelOutput({
          operationId: 'op-bad-q',
          plan,
          passages: [
            {
              passage_id: 'p-1',
              source_revision_id: 'rev-1',
              locator: { kind: 'section', section_id: 's' },
              text_ref: { mode: 'inline', text: 't', text_hash: 'a'.repeat(64) },
            },
          ],
          createdAt: '2026-10-21T09:50:00.000Z',
          modelOutput: {
            kind: 'extract_findings',
            findings: [
              {
                assertion_text: 'X',
                assertion_kind: 'source_observation',
                passage_ids: ['p-1'],
                question_id: 'q-unknown',
              },
            ],
          },
        }),
      /unknown question_id/,
    )
  })

  it('rejects legacy extract output missing question_id (Zod parse)', () => {
    assert.throws(
      () =>
        findingsFromExtractModelOutput({
          operationId: 'op-legacy',
          plan,
          passages: [
            {
              passage_id: 'p-1',
              source_revision_id: 'rev-1',
              locator: { kind: 'section', section_id: 's' },
              text_ref: { mode: 'inline', text: 't', text_hash: 'a'.repeat(64) },
            },
          ],
          createdAt: '2026-10-21T09:50:00.000Z',
          modelOutput: {
            kind: 'extract_findings',
            findings: [
              {
                assertion_text: 'legacy',
                assertion_kind: 'source_observation',
                passage_ids: ['p-1'],
              },
            ],
          },
        }),
    )
  })
})
