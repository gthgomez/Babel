/**
 * rateLimitWidget.ts — Visual rate-limit indicator for API usage.
 *
 * Renders remaining request budget as an ANSI bar with color-coded
 * thresholds for normal, warning, critical, and exhausted states.
 *
 * Mirrors the pattern from tokenBar.ts but tracks remaining budget
 * rather than consumed capacity. Pure functions only — no state.
 *
 * Usage:
 *   import { renderRateLimitWidget, renderCompactRateLimit }
 *     from './rateLimitWidget.js';
 *
 *   const state: RateLimitState = {
 *     remaining: 750, limit: 1000,
 *     resetAt: new Date(Date.now() + 300_000),
 *   };
 *   console.log(renderRateLimitWidget(state));
 *   // "[██████░░ 750/1000]"
 *
 *   console.log(renderCompactRateLimit(state));
 *   // "API: 750/1000"
 *
 * @module rateLimitWidget
 */

import { muted, ghost, warning, error, info, bold } from './theme.js';
import { getEffectiveTerminalWidth } from './theme.js';

// ── Types ───────────────────────────────────────────────────────────────

export interface RateLimitState {
  /** Remaining requests in current rate-limit window */
  remaining: number;
  /** Total request limit per window */
  limit: number;
  /** When the rate-limit window resets */
  resetAt: Date;
  /** Optional: recent burst count (requests in last ~60s) */
  requestsThisMinute?: number;
  /** Provider that set this state (e.g., 'deepinfra', 'deepseek') */
  provider?: string;
}

// ── Thresholds ─────────────────────────────────────────────────────────

enum RateLimitTier {
  Normal = 'normal', // remaining > 25%
  Warning = 'warning', // remaining 10% – 25%
  Critical = 'critical', // remaining 1% – 9.9%
  Exhausted = 'exhausted', // remaining === 0
}

interface RateLimitInfo {
  tier: RateLimitTier;
  /** Remaining as percentage of limit (0–100) */
  percent: number;
}

/**
 * Classify a rate-limit state into a tier.
 * Exhausted only triggers at exactly 0 to distinguish from critical.
 */
function classifyRateLimit(remaining: number, limit: number): RateLimitInfo {
  if (remaining <= 0) return { tier: RateLimitTier.Exhausted, percent: 0 };
  const safeLimit = Math.max(1, limit);
  const ratio = remaining / safeLimit;
  const percent = Math.min(100, Math.max(0, Math.round(ratio * 100)));
  // Use raw ratio for tier boundaries to avoid Math.round edge cases.
  // Critical at <= 10%, Warning at <= 25%, Normal above.
  if (ratio <= 0.1) return { tier: RateLimitTier.Critical, percent };
  if (ratio <= 0.25) return { tier: RateLimitTier.Warning, percent };
  return { tier: RateLimitTier.Normal, percent };
}

// ── Bar characters ──────────────────────────────────────────────────────

/**
 * Unicode fraction-height blocks for smooth 1/8-step gradients.
 * Index 0 is a light shade (empty), index 8 is full block.
 */
const FRACTION_BARS = ['░', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

/** Default bar width in characters */
const BAR_WIDTH_DEFAULT = 8;

// ── Bar rendering ──────────────────────────────────────────────────────

/**
 * Build a visual bar showing remaining capacity using fraction-height blocks.
 *
 * @param ratio    Remaining / limit (0.0 – 1.0)
 * @param width    Bar width in characters
 * @param colorFn  ANSI color function to wrap the bar with
 * @returns ANSI-escaped bar string
 */
function buildBar(ratio: number, width: number, colorFn: (text: string) => string): string {
  let bar = '';
  for (let i = 0; i < width; i++) {
    const segStart = i / width;
    const segEnd = (i + 1) / width;
    // How much of this segment is within [0, ratio]
    const clampedRatio = Math.max(0, Math.min(1, ratio - segStart));
    const filledPortion = clampedRatio / (1 / width);
    const idx = Math.round(Math.max(0, Math.min(1, filledPortion)) * 8);
    bar += FRACTION_BARS[idx]!;
  }
  return colorFn(bar);
}

/**
 * Pick the ANSI color function for a given tier.
 */
function colorForTier(tier: RateLimitTier): (text: string) => string {
  switch (tier) {
    case RateLimitTier.Exhausted:
    case RateLimitTier.Critical:
      return error;
    case RateLimitTier.Warning:
      return warning;
    default:
      return muted;
  }
}

// ── Time formatting ────────────────────────────────────────────────────

/**
 * Format the time until the rate-limit window resets.
 * Returns human-readable strings like "12m", "1h 30m", "any moment".
 */
function formatTimeRemaining(resetAt: Date): string {
  const ms = resetAt.getTime() - Date.now();
  if (ms <= 0) return 'any moment';
  const totalMinutes = Math.ceil(ms / 60_000);
  if (totalMinutes >= 60) {
    const hours = Math.floor(totalMinutes / 60);
    const mins = totalMinutes % 60;
    return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  }
  return `${totalMinutes}m`;
}

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Render a full rate-limit indicator widget with a visual bar.
 *
 * Output format:
 *   Normal:     [██████░░ 750/1000]
 *   Warning:    [████░░░░ 120/1000 ⚠]
 *   Critical:   [▆░░░░░░░ 45/1000 ⚡ 3m]
 *   Exhausted:  [░░░░░░░░ 0/1000 ⛔ 12m]
 *   Null state: (empty string)
 *
 * @param state  Rate-limit state, or null for unknown (renders empty)
 * @param width  Total widget width in characters (default: auto-fit)
 * @returns ANSI-escaped string, or empty string for null state
 */
export function renderRateLimitWidget(state: RateLimitState | null, width?: number): string {
  if (state === null) return '';

  const { remaining, limit, resetAt } = state;
  const effectiveWidth = width ?? Math.min(40, getEffectiveTerminalWidth(40, 120));
  const barWidth = Math.max(2, effectiveWidth - 22);
  const { tier } = classifyRateLimit(remaining, limit);
  const ratio = Math.max(0, Math.min(1, remaining / Math.max(1, limit)));
  const colorFn = colorForTier(tier);
  const bar = buildBar(ratio, barWidth, colorFn);
  const displayStr = `${remaining}/${limit}`;

  switch (tier) {
    case RateLimitTier.Exhausted: {
      const resetStr = formatTimeRemaining(resetAt);
      return `${bar} ${colorFn(displayStr)} ${error(`⛔ ${resetStr}`)}`;
    }
    case RateLimitTier.Critical: {
      const resetStr = formatTimeRemaining(resetAt);
      return `${bar} ${colorFn(displayStr)} ${info(`⚡ ${resetStr}`)}`;
    }
    case RateLimitTier.Warning: {
      return `${bar} ${colorFn(`${displayStr} ⚠`)}`;
    }
    default: {
      return `${bar} ${colorFn(displayStr)}`;
    }
  }
}

/**
 * Render a compact rate-limit indicator for status bars and footers.
 * Designed to fit in ~20–28 characters; no visual bar, text only.
 *
 * Output format:
 *   Normal:     API: 750/1000
 *   Warning:    API: 120/1000 ⚠
 *   Critical:   API: 45/1000 ⚡ 3m
 *   Exhausted:  API: 0/1000 ⛔ 12m
 *   Null state: (empty string)
 *
 * @returns ANSI-escaped string, or empty string for null state
 */
export function renderCompactRateLimit(state: RateLimitState | null): string {
  if (state === null) return '';

  const { remaining, limit, resetAt, provider } = state;
  const { tier } = classifyRateLimit(remaining, limit);
  const colorFn = colorForTier(tier);
  const label = provider ? provider.charAt(0).toUpperCase() + provider.slice(1) : 'API';
  const displayStr = `${label}: ${remaining}/${limit}`;

  switch (tier) {
    case RateLimitTier.Exhausted: {
      const resetStr = formatTimeRemaining(resetAt);
      return `${colorFn(displayStr)} ${error(`⛔ ${resetStr}`)}`;
    }
    case RateLimitTier.Critical: {
      const resetStr = formatTimeRemaining(resetAt);
      return `${colorFn(displayStr)} ${info(`⚡ ${resetStr}`)}`;
    }
    case RateLimitTier.Warning: {
      return colorFn(`${displayStr} ⚠`);
    }
    default: {
      return colorFn(displayStr);
    }
  }
}

// Re-export for testing
export { RateLimitTier, classifyRateLimit, buildBar, formatTimeRemaining };

/**
 * Parse rate limit response headers and update the global rate-limit state.
 *
 * Handles three header formats:
 *   x-ratelimit-remaining — remaining request count (number)
 *   x-ratelimit-limit     — total request limit per window (number)
 *   x-ratelimit-reset     — Unix timestamp (seconds or milliseconds) or ISO-8601 date
 *
 * If headers are missing or unparseable the function is a no-op.
 * If reset is missing or unparseable, defaults to 60 seconds from now.
 */
export function parseRateLimitHeaders(headers: Headers, provider: string): void {
  const remaining = headers.get('x-ratelimit-remaining');
  const limit = headers.get('x-ratelimit-limit');
  const resetAt = headers.get('x-ratelimit-reset');
  const remainingNum = parseInt(remaining ?? '', 10);
  const limitNum = parseInt(limit ?? '', 10);
  if (!Number.isFinite(remainingNum) || !Number.isFinite(limitNum)) return;

  let resetDate: Date;
  if (resetAt) {
    const trimmed = resetAt.trim();
    // Check if the entire value is purely numeric (Unix timestamp).
    // This avoids parseInt grabbing a year prefix from ISO strings like
    // "2026-06-26T10:23:15.123Z", which would be misinterpreted as seconds.
    if (/^\d+$/.test(trimmed)) {
      const parsed = parseInt(trimmed, 10);
      // Unix timestamp — could be seconds or milliseconds
      resetDate = new Date(parsed > 1e12 ? parsed : parsed * 1000);
    } else {
      // Try ISO-8601 / HTTP-date
      const d = new Date(trimmed);
      resetDate = Number.isFinite(d.getTime()) ? d : new Date(Date.now() + 60000);
    }
  } else {
    resetDate = new Date(Date.now() + 60000);
  }

  setGlobalRateLimitState({
    remaining: remainingNum,
    limit: limitNum,
    resetAt: resetDate,
    provider,
  });
}

// ── Global rate-limit state ───────────────────────────────────────────────

let _globalRateLimitState: RateLimitState | null = null;

export function getGlobalRateLimitState(): RateLimitState | null {
  return _globalRateLimitState;
}

export function setGlobalRateLimitState(state: RateLimitState): void {
  _globalRateLimitState = state;
}
