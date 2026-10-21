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

  it('returns not_assessed when citation unavailable despite unrelated admitted_fetched slot', () => {
    const fields = claimedSourceReviewFieldsFromSemanticInput(
      {
        finding_id: 'f2',
        cited_passages: [
          {
            content_status: 'unavailable',
            source_attribution: { coverage_source_slot: 'repository-pin-0' },
          },
        ],
      },
      [
        {
          source_slot: 'web-ref-0',
          fetch_status: 'admitted_fetched',
          configured_url: 'https://example.invalid/other',
        },
      ],
    )
    assert.equal(fields.claimed_source_attribution, 'not_assessed')
    assert.deepEqual(fields.claimed_source_slots, ['web-ref-0'])
  })

  it('returns not_assessed when available citation lacks coverage_source_slot', () => {
    const fields = claimedSourceReviewFieldsFromSemanticInput(
      {
        finding_id: 'f3',
        cited_passages: [{ content_status: 'available' }],
      },
      [
        {
          source_slot: 'repository-pin-0',
          fetch_status: 'admitted_fetched',
          configured_url: 'https://example.invalid/pin',
        },
      ],
    )
    assert.equal(fields.claimed_source_attribution, 'not_assessed')
    assert.deepEqual(fields.claimed_source_slots, ['repository-pin-0'])
  })
})
