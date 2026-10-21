/**
 * Typed alignment manifest only — no production imports. When A `d490dced` lands,
 * update reciprocal rationale assertions per B_HANDOFF_OBLIGATION_COVERAGE_4e9b5f70.md.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

/** B `4e9b5f70` host rationale tokens → A `semanticObligationCoverageValidation` violations. */
export const B_INTEGRITY_TOKEN_TO_A_VIOLATION: Readonly<
  Record<string, 'unknown_passage_id' | 'foreign_passage_id' | 'duplicate_obligation_id' | 'unknown_obligation_id'>
> = {
  absent_passage_id: 'unknown_passage_id',
  foreign_passage_id: 'foreign_passage_id',
  duplicate_obligation_id: 'duplicate_obligation_id',
  unknown_obligation_id: 'unknown_obligation_id',
}

export const RECIPROCAL_BOUNDED_NEGATIVE_SCENARIOS = [
  'valid_passage_plus_absent_id',
  'duplicate_obligation_met_then_unmet',
  'unknown_obligation_id_row',
  'foreign_passage_not_on_finding',
  'complete_positive_control',
] as const

export const A_HOST_REJECTED_PREFIX = 'Host rejected obligation_coverage response'

describe('G-L2 obligation wiring A reconciliation manifest (typed alignment)', () => {
  it('maps B integrity tokens to A violation enums for post-merge assertion updates', () => {
    assert.equal(B_INTEGRITY_TOKEN_TO_A_VIOLATION.absent_passage_id, 'unknown_passage_id')
    assert.equal(Object.keys(B_INTEGRITY_TOKEN_TO_A_VIOLATION).length, 4)
  })

  it('lists reciprocal scenarios that must stay green after A canonical merge', () => {
    assert.equal(RECIPROCAL_BOUNDED_NEGATIVE_SCENARIOS.length, 5)
    assert.ok(RECIPROCAL_BOUNDED_NEGATIVE_SCENARIOS.includes('complete_positive_control'))
  })

  it('documents dual acceptable rationale shapes during reconciliation', () => {
    const bSample = 'obligation_coverage judgment integrity failed: absent_passage_id:DOES-NOT-EXIST'
    const aSample =
      'Host rejected obligation_coverage response (unknown_passage_id): unknown passage_id DOES-NOT-EXIST for obligation_id ob-mdn-max-age-semantics.'
    assert.match(bSample, /absent_passage_id/)
    assert.match(aSample, new RegExp(A_HOST_REJECTED_PREFIX))
    assert.match(aSample, /unknown_passage_id/)
  })
})
