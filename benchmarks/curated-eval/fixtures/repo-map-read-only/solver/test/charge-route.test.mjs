import assert from 'node:assert/strict'
import { test } from 'node:test'

import { postCharge } from '../src/api/charge-route.mjs'

test('a tenant can charge its own invoice', () => {
  assert.deepEqual(postCharge({
    tenantId: 'tenant-a',
    invoice: { id: 'inv-1', tenantId: 'tenant-a', items: [{ amountCents: 250 }] },
  }), { status: 201, invoiceId: 'inv-1', amountCents: 250 })
})

test('a tenant cannot charge another tenant invoice', () => {
  assert.deepEqual(postCharge({
    tenantId: 'tenant-a',
    invoice: { id: 'inv-2', tenantId: 'tenant-b', items: [{ amountCents: 250 }] },
  }), { status: 403, code: 'TENANT_MISMATCH' })
})
