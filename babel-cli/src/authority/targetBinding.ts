/**
 * targetBinding.ts — normalize PR / branch / environment identity so
 * capability-specific constraints compare apples to apples.
 */

export function normalizePrNumber(value: string | number): number | null {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value > 0 ? value : null;
  }
  const trimmed = value.trim();
  const match = /^#?(\d+)$/.exec(trimmed);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Strip refspec / refs/heads / leading + so parser aliases compare equal. */
export function normalizeBranchRef(value: string): string {
  let v = value.trim();
  if (v.startsWith('+')) v = v.slice(1);
  if (v.includes(':')) {
    const dest = v.split(':').pop() ?? v;
    v = dest;
  }
  if (v.startsWith('refs/heads/')) v = v.slice('refs/heads/'.length);
  else if (v.startsWith('heads/')) v = v.slice('heads/'.length);
  return v;
}

export function branchAllowed(actual: string, allowed: readonly string[]): boolean {
  const normalized = normalizeBranchRef(actual);
  return allowed.some((candidate) => normalizeBranchRef(candidate) === normalized);
}

export function normalizeEnvironment(value: string): string {
  const lower = value.trim().toLowerCase();
  if (lower === 'prod') return 'production';
  if (lower === 'stage') return 'staging';
  return lower;
}

export function environmentAllowed(actual: string, allowed: readonly string[]): boolean {
  const normalized = normalizeEnvironment(actual);
  return allowed.some((candidate) => normalizeEnvironment(candidate) === normalized);
}
