import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { inferHttpAccessFailureCategory } from './inferHttpAccessFailureCategory.js'

describe('inferHttpAccessFailureCategory', () => {
  it('uses rate_limited only with rate evidence, not bare 403', () => {
    assert.equal(
      inferHttpAccessFailureCategory({ httpStatus: 403, httpFailure: { public_message: 'Forbidden' } }),
      'network_error',
    )
    assert.equal(
      inferHttpAccessFailureCategory({
        httpStatus: 403,
        httpFailure: { rate_limit_remaining: '0' },
      }),
      'rate_limited',
    )
  })

  it('uses policy_denied for 401 or explicit auth message on 403', () => {
    assert.equal(inferHttpAccessFailureCategory({ httpStatus: 401 }), 'policy_denied')
    assert.equal(
      inferHttpAccessFailureCategory({
        httpStatus: 403,
        httpFailure: { public_message: 'Requires authentication' },
      }),
      'policy_denied',
    )
  })
})
