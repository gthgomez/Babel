/**
 * BENCHMARK EXTRACTION — ADAPTATION NOTICE
 *
 * Source: gthgomez/Prismatix, supabase/functions/_shared/model_tariff.ts
 * Revision: 150f4446aa7ec001acba3087593a3e6ea38b49d5
 * Copyright (c) 2026 Jonathan Gomez Aguilar. MIT License; see LICENSE.
 *
 * The surrounding registry and unrelated exports were omitted. TariffEntry
 * was narrowed to its effectiveTo property so this excerpt stands alone.
 * The two function bodies and their historical comments are unchanged.
 * This is historical buggy code. PROMPT.md states the intended behavior.
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
 * True when `entry.effectiveTo` is a valid date strictly before `now`.
 * A MALFORMED `effectiveTo` fails CLOSED (returns true), never false.
 * A missing `effectiveTo` means the rate has no expiry bound.
 */
export function isPriceExpired(
  entry: Pick<TariffEntry, 'effectiveTo'> | null | undefined,
  now: Date = new Date(),
): boolean {
  const raw = entry?.effectiveTo;
  if (raw === undefined || raw === null || raw === '') return false;
  const expiry = parseIsoDateUtc(raw);
  if (!expiry) return true; // malformed -> fail closed
  return expiry.getTime() < now.getTime();
}
