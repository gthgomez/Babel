import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { FindingRecord } from '../contracts/findings.js'
import type { PassageRecord } from '../contracts/passages.js'
import { PlanRevisionSchema } from '../contracts/plan.js'
import { exampleTechnicalMissionFixture } from '../fixtures/exampleMission.js'
import { buildSemanticSupportReviewInput } from './buildSemanticSupportReviewInput.js'

const plan = PlanRevisionSchema.parse({
  plan_revision_id: 'plan-semantic-input',
  mission_id: exampleTechnicalMissionFixture.mission_id,
  created_at: '2026-10-20T00:00:00.000Z',
  revision_reason: 'fixture',
  questions: [
    {
      question_id: 'q-1',
      text: 'What mechanism isolates evidence?',
      importance: 'high',
      evidence_requirement: 'docs',
      status: 'open',
    },
  ],
})

const finding: FindingRecord = {
  finding_id: 'finding-a',
  question_id: 'q-1',
  assertion_text: 'Alpha claim',
  assertion_kind: 'source_observation',
  passage_ids: ['p-inline', 'p-missing', 'p-blob'],
  source_integrity: 'not_checked',
  created_at: '2026-10-20T00:00:00.000Z',
}

const passages: PassageRecord[] = [
  {
    passage_id: 'p-inline',
    source_revision_id: 'rev-1',
    locator: { kind: 'line_range', start_line: 1, end_line: 1 },
    text_ref: {
      mode: 'inline',
      text: 'Evidence alpha text.',
      text_hash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    },
  },
  {
    passage_id: 'p-blob',
    source_revision_id: 'rev-1',
    locator: { kind: 'line_range', start_line: 2, end_line: 2 },
    text_ref: {
      mode: 'blob_ref',
      blob_ref: 'blob-1',
      text_hash: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    },
  },
]

describe('buildSemanticSupportReviewInput', () => {
  it('includes admitted inline passage text and marks unavailable contents', () => {
    const input = buildSemanticSupportReviewInput([finding], passages, plan)
    assert.equal(input.findings.length, 1)
    assert.equal(input.findings[0]?.question_text, 'What mechanism isolates evidence?')
    const cited = input.findings[0]?.cited_passages ?? []
    assert.equal(cited.length, 3)
    const inline = cited[0]
    assert.equal(inline?.content_status, 'available')
    if (inline && inline.content_status === 'available') {
      assert.match(inline.text, /Evidence alpha/)
    }
    assert.equal(cited[1]?.content_status, 'unavailable')
    assert.equal(cited[2]?.content_status, 'unavailable')
    const rubric = input.findings[0]?.coverage_rubric
    assert.ok(rubric)
    assert.match(rubric?.guidance ?? '', /bound question_text/)
  })
})
