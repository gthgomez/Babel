import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { FindingRecord } from '../contracts/findings.js'
import { applySemanticSupportReview } from './findingsFromModelOutput.js'

const baseFinding = (): FindingRecord => ({
  finding_id: 'f-1',
  question_id: 'q-1',
  assertion_text: 'Claim A',
  assertion_kind: 'source_observation',
  passage_ids: ['p-1'],
  source_integrity: 'not_checked',
  created_at: '2026-10-20T00:00:00.000Z',
})

describe('semantic support review persistence shape', () => {
  it('marks omitted findings not_checked instead of leaving semantic_support unset', () => {
    const reviewed = applySemanticSupportReview(
      [baseFinding(), { ...baseFinding(), finding_id: 'f-2', assertion_text: 'Claim B' }],
      {
        kind: 'semantic_support_review',
        judgments: [
          {
            finding_id: 'f-1',
            status: 'contradicted',
            rationale: 'Passage text contradicts the assertion.',
            question_coverage: 'none',
            claimed_source_attribution: 'not_assessed',
            claimed_source_slots: ['web-ref-0'],
          },
        ],
      },
      '2026-10-20T01:00:00.000Z',
    )
    const f1 = reviewed.find((f) => f.finding_id === 'f-1')
    const f2 = reviewed.find((f) => f.finding_id === 'f-2')
    assert.equal(f1?.semantic_support?.status, 'contradicted')
    assert.equal(f2?.semantic_support?.status, 'not_checked')
    assert.equal(f2?.question_coverage?.status, 'not_assessed')
    assert.ok(f2?.revised_at)
  })
})
