import type { RunnerInvocationMetadata } from '../runners/base.js'

/**
 * Provider charge passed to `CostTracker.settleUsage` as `reportedCostUsd`.
 * Uses `provider_reported_total_charge_usd` only; never `estimated_cost_usd`.
 *
 * @returns finite reported charge, `null` when the provider explicitly withheld cost,
 * or `undefined` when no provider report exists (registry estimate may apply).
 */
export function settlementReportedCostUsd(
  metadata: RunnerInvocationMetadata | null | undefined,
): number | null | undefined {
  if (metadata === null || metadata === undefined) {
    return undefined
  }
  if (!('provider_reported_total_charge_usd' in metadata)) {
    return undefined
  }
  const reported = metadata.provider_reported_total_charge_usd
  if (reported === undefined) {
    return undefined
  }
  if (reported === null) {
    return null
  }
  if (typeof reported === 'number' && Number.isFinite(reported) && reported >= 0) {
    return reported
  }
  return null
}
