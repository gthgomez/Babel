import type { SessionUsageSummary } from '../services/costTracker.js';

/** Keep observed charges separate from allowance estimates in plain CLI output. */
export function formatUsageCost(usage: Pick<SessionUsageSummary,
  'totalCostUSD' | 'knownCostUSD' | 'estimatedCostUSD' | 'reportedCostUSD' | 'unknownChargeCount' |
  'costComplete' | 'completeCostUSD' | 'estimateComplete'>,
  options?: { fractionDigits?: number }): string {
  const digits = options?.fractionDigits ?? 6;
  const amount = usage.knownCostUSD ?? usage.totalCostUSD;
  if (!Number.isFinite(amount) || amount < 0) return 'cost unavailable';
  const known = `$${amount.toFixed(digits)}`;
  const estimate = Number.isFinite(usage.estimatedCostUSD) && (usage.estimatedCostUSD ?? 0) > 0
    ? `; $${usage.estimatedCostUSD!.toFixed(digits)} usage estimate`
    : '';
  const reported = Number.isFinite(usage.reportedCostUSD)
    ? `; $${usage.reportedCostUSD!.toFixed(digits)} provider-reported`
    : '';
  if ((usage.unknownChargeCount ?? 0) > 0) {
    return `${known} known subtotal + ${usage.unknownChargeCount} unresolved charge(s)${estimate}${reported}`;
  }
  const incomplete = usage.costComplete === false || usage.completeCostUSD === null;
  return (incomplete ? `${known} known subtotal; cost incomplete` : known) + estimate + reported;
}

/** Compact session cost line for waterfall / TUI HUD (not plain CLI tables). */
export function formatSessionCostHud(usage: Pick<SessionUsageSummary,
  'totalCostUSD' | 'knownCostUSD' | 'estimatedCostUSD' | 'reportedCostUSD' | 'unknownChargeCount' |
  'costComplete' | 'completeCostUSD'>): string {
  const known = usage.knownCostUSD ?? usage.totalCostUSD;
  const estimate = usage.estimatedCostUSD ?? 0;
  const reported = usage.reportedCostUSD;
  const unknown = usage.unknownChargeCount ?? 0;
  const billingComplete = usage.costComplete === true && Number.isFinite(reported) && unknown === 0;
  if (billingComplete) {
    return `$${reported!.toFixed(4)} reported`;
  }
  const incomplete = usage.costComplete === false || usage.completeCostUSD === null;
  const bits: string[] = [];
  if (estimate > 0 && (incomplete || known <= 0)) {
    bits.push(`$${estimate.toFixed(4)} usage est.`);
  } else if (Number.isFinite(known) && known > 0) {
    bits.push(`$${known.toFixed(4)}${incomplete ? ' known' : ''}`);
  }
  if (Number.isFinite(reported) && !billingComplete) {
    bits.push(`$${reported!.toFixed(4)} reported`);
  }
  if (unknown > 0) bits.push(`${unknown} unresolved`);
  else if (incomplete && bits.length === 0) bits.push('incomplete');
  else if (incomplete && estimate <= 0 && known <= 0) bits.push('incomplete');
  return bits.join('; ') || '$0.0000';
}

const LEGACY_HUD_NUMERIC = /^\d+\.\d{4}$/;

/** Prefix only legacy bare `toFixed(4)` cache values; preformatted HUD labels pass through. */
export function formatHudCostDisplay(cachedCostStr: string): string {
  return LEGACY_HUD_NUMERIC.test(cachedCostStr) ? `$${cachedCostStr}` : cachedCostStr;
}
