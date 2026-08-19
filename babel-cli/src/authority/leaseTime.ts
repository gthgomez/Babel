/**
 * leaseTime.ts — temporal validity for autonomy leases.
 *
 * expiresAt is a security-significant field. Malformed timestamps fail
 * closed. An injectable clock keeps the check deterministic in tests.
 */

import type { AutonomyLease } from './lease.js';

export type LeaseTemporalResult =
  | { ok: true }
  | { ok: false; reasonCode: 'DENY_LEASE_EXPIRED' | 'DENY_LEASE_INVALID_TIME' };

const STRICT_ISO =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

export function parseStrictTimestamp(value: string): number | null {
  const trimmed = value.trim();
  if (!STRICT_ISO.test(trimmed)) return null;
  const ms = Date.parse(trimmed);
  return Number.isFinite(ms) ? ms : null;
}

export function toEpochMs(now: Date | number): number {
  return typeof now === 'number' ? now : now.getTime();
}

/**
 * Evaluate lease expiry against `now`. Absent expiresAt is valid.
 * now >= expiresAt is expired (including equality).
 */
export function evaluateLeaseTemporalValidity(
  lease: Pick<AutonomyLease, 'expiresAt'>,
  now: Date | number = Date.now(),
): LeaseTemporalResult {
  if (lease.expiresAt === undefined || lease.expiresAt === '') {
    return { ok: true };
  }
  const expiresMs = parseStrictTimestamp(lease.expiresAt);
  if (expiresMs === null) {
    return { ok: false, reasonCode: 'DENY_LEASE_INVALID_TIME' };
  }
  if (toEpochMs(now) >= expiresMs) {
    return { ok: false, reasonCode: 'DENY_LEASE_EXPIRED' };
  }
  return { ok: true };
}
