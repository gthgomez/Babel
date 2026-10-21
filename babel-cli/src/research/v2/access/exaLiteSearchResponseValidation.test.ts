import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  ExaLiteResponseValidationError,
  mapExaLiteHttpStatusToFailure,
  validateExaLiteSearchResponseBody,
} from './exaLiteSearchResponseValidation.js'

describe('exaLiteSearchResponseValidation', () => {
  it('rejects malformed HTTP 200 JSON (not empty success)', () => {
    assert.throws(
      () => validateExaLiteSearchResponseBody('not-json'),
      ExaLiteResponseValidationError,
    )
    assert.throws(
      () => validateExaLiteSearchResponseBody(JSON.stringify({ results: 'bad' })),
      /results must be an array/,
    )
  })

  it('sanitizes cost metadata as provider estimate', () => {
    const parsed = validateExaLiteSearchResponseBody(
      JSON.stringify({
        requestId: 'req-1',
        costDollars: { total: 0.001, search: 0.001 },
        results: [{ title: 'T', url: 'https://example.com/a', highlights: ['h'] }],
      }),
    )
    assert.equal(parsed.metadata.request_id, 'req-1')
    assert.equal(parsed.metadata.estimated_cost_dollars, 0.001)
    assert.equal(parsed.metadata.estimated_cost_detail?.search, 0.001)
  })

  it('maps auth, billing, policy, timeout and rate-limit statuses', () => {
    assert.equal(mapExaLiteHttpStatusToFailure(401).failureCategory, 'search_provider_unavailable')
    assert.match(mapExaLiteHttpStatusToFailure(402).message, /billing/)
    assert.equal(mapExaLiteHttpStatusToFailure(422).failureCategory, 'policy_denied')
    assert.equal(mapExaLiteHttpStatusToFailure(408).failureCategory, 'timeout')
    assert.equal(mapExaLiteHttpStatusToFailure(429).failureCategory, 'rate_limited')
  })
})
