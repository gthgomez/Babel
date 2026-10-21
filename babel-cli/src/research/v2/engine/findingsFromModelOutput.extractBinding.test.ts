import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { examplePlanRevisionFixture } from '../fixtures/exampleMission.js'
import { findingsFromExtractModelOutput } from './findingsFromModelOutput.js'

describe('findingsFromExtractModelOutput plan binding', () => {
  it('assigns every extracted finding to plan.questions[0].question_id', () => {
    const firstQuestionId = examplePlanRevisionFixture.questions[0]?.question_id
    assert.ok(firstQuestionId)
    const findings = findingsFromExtractModelOutput({
      operationId: 'op-extract-binding',
      plan: examplePlanRevisionFixture,
      passages: [
        {
          passage_id: 'p-1',
          source_revision_id: 'rev-1',
          locator: { kind: 'section', section_id: 's' },
          heading_path: ['H'],
          text_ref: { mode: 'inline', text: 'text', text_hash: 'abc' },
        },
      ],
      createdAt: '2026-10-21T00:00:00.000Z',
      modelOutput: {
        kind: 'extract_findings',
        findings: [
          {
            assertion_text: 'First assertion',
            assertion_kind: 'source_observation',
            passage_ids: ['p-1'],
          },
          {
            assertion_text: 'Second assertion',
            assertion_kind: 'inference',
            passage_ids: ['p-1'],
          },
        ],
      },
    })
    assert.equal(findings.length, 2)
    assert.ok(findings.every((f) => f.question_id === firstQuestionId))
  })
})
