import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  assertModelInvocationReceiptBound,
  ModelReceiptBindingError,
  usageSettlementWhenAbortedAfterInvoke,
} from './validateModelInvocationReceipt.js'

describe('validateModelInvocationReceipt', () => {
  it('rejects foreign receipt operation_id', () => {
    assert.throws(
      () =>
        assertModelInvocationReceiptBound('op-a', 'att-a', {
          status: 'ok',
          operationId: 'op-a',
          output: {},
          receipt: {
            operation_id: 'op-b',
            backend_key: 'k',
            provider: 'p',
            provider_model_id: 'm',
            resolved_at: '2026-10-20T00:00:00.000Z',
            usage_settlement: { attempt_id: 'att-a', cost: { status: 'unknown' } },
          },
        }),
      ModelReceiptBindingError,
    )
  })

  it('usageSettlementWhenAbortedAfterInvoke keeps unknown for foreign receipt on ok result', () => {
    const usage = usageSettlementWhenAbortedAfterInvoke('op-a', 'att-a', {
      status: 'ok',
      operationId: 'op-a',
      output: {},
      receipt: {
        operation_id: 'foreign',
        backend_key: 'k',
        provider: 'p',
        provider_model_id: 'm',
        resolved_at: '2026-10-20T00:00:00.000Z',
        usage_settlement: {
          attempt_id: 'foreign-att',
          cost: { status: 'reported', amount_usd: 1, currency: 'USD' },
        },
      },
    })
    assert.equal(usage.attempt_id, 'att-a')
    assert.equal(usage.cost.status, 'unknown')
  })
})
