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
        httpStatus: 401,
        httpFailure: { rate_limit_remaining: '59' },
      }),
      'policy_denied',
    )
    assert.equal(
      inferHttpAccessFailureCategory({
        httpStatus: 403,
        httpFailure: { public_message: 'Requires authentication' },
      }),
      'policy_denied',
    )
  })

  it('does not treat rate headers alone as rate_limited', () => {
    assert.equal(
      inferHttpAccessFailureCategory({
        httpStatus: 403,
        httpFailure: { rate_limit_remaining: '59' },
      }),
      'network_error',
    )
    assert.equal(
      inferHttpAccessFailureCategory({
        httpStatus: 503,
        httpFailure: { rate_limit_resource: 'core' },
      }),
      'network_error',
    )
    assert.equal(
      inferHttpAccessFailureCategory({
        httpStatus: 418,
        httpFailure: { retry_after: '120' },
      }),
      'network_error',
    )
    assert.equal(
      inferHttpAccessFailureCategory({
        httpStatus: 403,
        httpFailure: { public_message: 'secondary rate limit exceeded' },
      }),
      'rate_limited',
    )
  })
})
