import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { claimedSourceReviewFieldsFromSemanticInput } from './claimedSourceReviewFieldsFromSemanticInput.js'

describe('claimedSourceReviewFieldsFromSemanticInput', () => {
  it('prefers coverage_source_slot from available cited passages', () => {
    const fields = claimedSourceReviewFieldsFromSemanticInput(
      {
        finding_id: 'f1',
        cited_passages: [
          {
            content_status: 'available',
            source_attribution: { coverage_source_slot: 'repository-pin-0' },
          },
        ],
      },
      [{ source_slot: 'repository-pin-0', fetch_status: 'admitted_fetched', configured_url: 'u' }],
    )
    assert.equal(fields.claimed_source_attribution, 'matches_admitted_citations')
    assert.deepEqual(fields.claimed_source_slots, ['repository-pin-0'])
  })
})
