export function authorizeTenant(requestTenantId, ownerTenantId) {
  return requestTenantId === ownerTenantId
}
