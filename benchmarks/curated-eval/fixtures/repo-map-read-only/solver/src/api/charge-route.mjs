import { authorizeTenant } from '../auth/tenant-policy.mjs'
import { chargeInvoice } from '../billing/charges.mjs'

export function postCharge(request) {
  if (!authorizeTenant(request.tenantId, request.invoice.tenantId)) {
    return { status: 403, code: 'TENANT_MISMATCH' }
  }
  return chargeInvoice(request.invoice)
}
