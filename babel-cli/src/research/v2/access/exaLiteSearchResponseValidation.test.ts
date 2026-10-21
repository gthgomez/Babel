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

  it('sanitizes cost metadata as provider estimate with explicit total only', () => {
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

  it('rejects numeric cost root and does not infer total from breakdown', () => {
    const numericRoot = validateExaLiteSearchResponseBody(
      JSON.stringify({
        costDollars: 0.002,
        results: [{ title: 'T', url: 'https://example.com/a' }],
      }),
    )
    assert.equal(numericRoot.metadata.estimated_cost_dollars, null)
    assert.equal(numericRoot.metadata.estimated_cost_detail, null)

    const partialBreakdown = validateExaLiteSearchResponseBody(
      JSON.stringify({
        costDollars: { search: 0.001, contents: 0.002 },
        results: [{ title: 'T', url: 'https://example.com/a' }],
      }),
    )
    assert.equal(partialBreakdown.metadata.estimated_cost_dollars, null)
    assert.equal(partialBreakdown.metadata.estimated_cost_detail?.search, 0.001)
  })

  it('drops negative cost fields and preserves structured warnings/notices', () => {
    const parsed = validateExaLiteSearchResponseBody(
      JSON.stringify({
        warnings: [
          {
            code: 'domain_filter_relaxed',
            path: 'includeDomains',
            message: 'Some domains were ignored',
            details: { ignoredCount: '2' },
          },
        ],
        notices: ['cached-only'],
        costDollars: { total: -1, search: 0.001 },
        results: [{ title: 'T', url: 'https://example.com/a' }],
      }),
    )
    assert.equal(parsed.metadata.warnings[0]?.code, 'domain_filter_relaxed')
    assert.equal(parsed.metadata.warnings[0]?.details?.ignoredCount, '2')
    assert.equal(parsed.metadata.notices[0]?.code, 'provider_message')
    assert.equal(parsed.metadata.estimated_cost_dollars, null)
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
