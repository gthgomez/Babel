/**
 * BENCHMARK NEGATIVE CONTROL — PERMISSIVE DATE PARSING
 *
 * Source: gthgomez/Prismatix, supabase/functions/_shared/model_tariff.ts
 * Revision: b1219549ff6253391b458279c176c39abd4b26ac
 * Copyright (c) 2026 Jonathan Gomez Aguilar. MIT License; see LICENSE.
 *
 * ADAPTATION: unrelated declarations were omitted and TariffEntry was narrowed
 * to effectiveTo. This is a deliberately incorrect repair, not an upstream source revision.
 */

export interface TariffEntry {
  effectiveTo?: string;
}

/**
 * Strictly parses an ISO `YYYY-MM-DD` date into a UTC Date. Returns undefined
 * for anything that is not a real calendar date (wrong shape, month 13,
 * Feb 30, non-zero-padded fields, ...).
 */
function parseIsoDateUtc(value: unknown): Date | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return undefined;
  }
  return date;
}

/**
 * True when `entry.effectiveTo` has passed. `effectiveTo` is INCLUSIVE: it is
 * the last UTC day the rate may be billed, so this returns false for any time
 * during the `effectiveTo` UTC day and true from 00:00:00Z of the following
 * UTC day onward.
 * A MALFORMED `effectiveTo` fails CLOSED (returns true), never false.
 * A missing `effectiveTo` means the rate has no expiry bound.
 */
export function isPriceExpired(
  entry: Pick<TariffEntry, 'effectiveTo'> | null | undefined,
  now: Date = new Date(),
): boolean {
  const raw = entry?.effectiveTo;
  if (raw === undefined || raw === null || raw === '') return false;
  if (typeof raw !== 'string') return true;
  const lastBillableDay = new Date(raw.trim());
  if (!Number.isFinite(lastBillableDay.getTime())) return true;
  // Exclusive end boundary: the start of the UTC day after `effectiveTo`.
  const expiresAt = lastBillableDay.getTime() + 86_400_000;
  return now.getTime() >= expiresAt;
}
