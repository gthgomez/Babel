import type { SessionUsageSummary } from '../services/costTracker.js';

/** Keep observed charges separate from allowance estimates in plain CLI output. */
export function formatUsageCost(usage: Pick<SessionUsageSummary,
  'totalCostUSD' | 'knownCostUSD' | 'estimatedCostUSD' | 'reportedCostUSD' | 'unknownChargeCount' |
  'costComplete' | 'completeCostUSD' | 'estimateComplete'>): string {
  const amount = usage.knownCostUSD ?? usage.totalCostUSD;
  if (!Number.isFinite(amount) || amount < 0) return 'cost unavailable';
  const known = `$${amount.toFixed(6)}`;
  const estimate = Number.isFinite(usage.estimatedCostUSD) && (usage.estimatedCostUSD ?? 0) > 0
    ? `; $${usage.estimatedCostUSD!.toFixed(6)} usage estimate`
    : '';
  const reported = Number.isFinite(usage.reportedCostUSD)
    ? `; $${usage.reportedCostUSD!.toFixed(6)} provider-reported`
    : '';
  if ((usage.unknownChargeCount ?? 0) > 0) {
    return `${known} known subtotal + ${usage.unknownChargeCount} unresolved charge(s)${estimate}${reported}`;
  }
  const incomplete = usage.costComplete === false || usage.completeCostUSD === null;
  return (incomplete ? `${known} known subtotal; cost incomplete` : known) + estimate + reported;
}
