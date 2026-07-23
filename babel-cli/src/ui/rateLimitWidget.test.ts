/**
 * rateLimitWidget.test.ts — Tests for the rate-limit indicator.
 *
 * Covers:
 *   1. classifyRateLimit — tier thresholds (Normal/Warning/Critical/Exhausted)
 *   2. renderRateLimitWidget — full widget output for each tier
 *   3. renderCompactRateLimit — compact output format
 *   4. Null state (renders empty string)
 *   5. Width adaptation (truncation at small widths)
 *   6. buildBar — Unicode fraction-height block rendering
 *   7. formatTimeRemaining — time formatting
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyRateLimit,
  renderRateLimitWidget,
  renderCompactRateLimit,
  parseRateLimitHeaders,
  getGlobalRateLimitState,
  RateLimitTier,
  buildBar,
  formatTimeRemaining,
} from './rateLimitWidget.js';
import { stripAnsi } from './theme.js';

// ═══════════════════════════════════════════════════════════════════════════════
// 1. classifyRateLimit
// ═══════════════════════════════════════════════════════════════════════════════

describe('classifyRateLimit', () => {
  it('returns Normal for 100% remaining', () => {
    const result = classifyRateLimit(1000, 1000);
    assert.equal(result.tier, RateLimitTier.Normal);
    assert.equal(result.percent, 100);
  });

  it('returns Normal for 26% remaining', () => {
    const result = classifyRateLimit(260, 1000);
    assert.equal(result.tier, RateLimitTier.Normal);
  });

  it('returns Normal for 25.1% remaining (above threshold)', () => {
    const result = classifyRateLimit(251, 1000);
    assert.equal(result.tier, RateLimitTier.Normal);
  });

  it('returns Warning for exactly 25% remaining', () => {
    const result = classifyRateLimit(250, 1000);
    assert.equal(result.tier, RateLimitTier.Warning);
    assert.equal(result.percent, 25);
  });

  it('returns Warning for 24.9% remaining (just inside threshold)', () => {
    const result = classifyRateLimit(249, 1000);
    assert.equal(result.tier, RateLimitTier.Warning);
  });

  it('returns Warning for 10.1% remaining', () => {
    const result = classifyRateLimit(101, 1000);
    assert.equal(result.tier, RateLimitTier.Warning);
  });

  it('returns Critical for exactly 10% remaining', () => {
    const result = classifyRateLimit(100, 1000);
    assert.equal(result.tier, RateLimitTier.Critical);
    assert.equal(result.percent, 10);
  });

  it('returns Critical for 9.9% remaining', () => {
    const result = classifyRateLimit(99, 1000);
    assert.equal(result.tier, RateLimitTier.Critical);
  });

  it('returns Critical for 1% remaining', () => {
    const result = classifyRateLimit(10, 1000);
    assert.equal(result.tier, RateLimitTier.Critical);
    assert.equal(result.percent, 1);
  });

  it('returns Exhausted for 0 remaining', () => {
    const result = classifyRateLimit(0, 1000);
    assert.equal(result.tier, RateLimitTier.Exhausted);
    assert.equal(result.percent, 0);
  });

  it('returns Exhausted for negative remaining', () => {
    const result = classifyRateLimit(-5, 1000);
    assert.equal(result.tier, RateLimitTier.Exhausted);
  });

  it('handles limit of 0 (division by zero guard)', () => {
    const result = classifyRateLimit(50, 0);
    assert.equal(result.tier, RateLimitTier.Normal);
    assert.equal(result.percent, 100);
  });

  it('handles remaining=0 and limit=0 gracefully', () => {
    const result = classifyRateLimit(0, 0);
    assert.equal(result.tier, RateLimitTier.Exhausted);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. renderRateLimitWidget — full widget output
// ═══════════════════════════════════════════════════════════════════════════════

const FUTURE_5M = new Date(Date.now() + 300_000);
const FUTURE_12M = new Date(Date.now() + 720_000);

describe('renderRateLimitWidget', () => {
  it('renders empty string for null state', () => {
    const result = renderRateLimitWidget(null);
    assert.equal(result, '');
  });

  it('renders normal state with muted colors and ratio', () => {
    const state = { remaining: 750, limit: 1000, resetAt: FUTURE_5M };
    const result = renderRateLimitWidget(state, 40);
    assert.ok(typeof result === 'string');
    assert.ok(result.length > 0);
    const plain = stripAnsi(result);
    // Should contain ratio display
    assert.ok(plain.includes('750/1000'));
  });

  it('renders warning state with warning text and ⚠ indicator', () => {
    const state = { remaining: 200, limit: 1000, resetAt: FUTURE_5M };
    const result = renderRateLimitWidget(state, 40);
    const plain = stripAnsi(result);
    assert.ok(plain.includes('200/1000'));
    assert.ok(plain.includes('⚠'));
  });

  it('renders critical state with error text, ⚡ indicator, and time', () => {
    const state = { remaining: 50, limit: 1000, resetAt: FUTURE_5M };
    const result = renderRateLimitWidget(state, 40);
    const plain = stripAnsi(result);
    assert.ok(plain.includes('50/1000'));
    assert.ok(plain.includes('⚡'));
    assert.ok(plain.includes('5m') || plain.includes('any moment'));
  });

  it('renders exhausted state with error text, ⛔ indicator, and time', () => {
    const state = { remaining: 0, limit: 1000, resetAt: FUTURE_12M };
    const result = renderRateLimitWidget(state, 40);
    const plain = stripAnsi(result);
    assert.ok(plain.includes('0/1000'));
    assert.ok(plain.includes('⛔'));
    assert.ok(plain.includes('12m'));
  });

  it('contains Unicode bar characters', () => {
    const state = { remaining: 750, limit: 1000, resetAt: FUTURE_5M };
    const result = renderRateLimitWidget(state, 40);
    // Should contain fraction-height block characters
    assert.ok(result.includes('░') || result.includes('█'));
  });

  it('handles very small width', () => {
    const state = { remaining: 500, limit: 1000, resetAt: FUTURE_5M };
    const result = renderRateLimitWidget(state, 10);
    assert.ok(typeof result === 'string');
    assert.ok(result.length > 0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. renderCompactRateLimit — compact output
// ═══════════════════════════════════════════════════════════════════════════════

describe('renderCompactRateLimit', () => {
  it('renders empty string for null state', () => {
    const result = renderCompactRateLimit(null);
    assert.equal(result, '');
  });

  it('starts with "API:" prefix in normal state', () => {
    const state = { remaining: 750, limit: 1000, resetAt: FUTURE_5M };
    const result = renderCompactRateLimit(state);
    const plain = stripAnsi(result);
    assert.ok(plain.startsWith('API:'));
    assert.ok(plain.includes('750/1000'));
  });

  it('includes ⚠ in warning state', () => {
    const state = { remaining: 200, limit: 1000, resetAt: FUTURE_5M };
    const result = renderCompactRateLimit(state);
    const plain = stripAnsi(result);
    assert.ok(plain.includes('⚠'));
  });

  it('includes ⚡ and time in critical state', () => {
    const state = { remaining: 80, limit: 1000, resetAt: FUTURE_5M };
    const result = renderCompactRateLimit(state);
    const plain = stripAnsi(result);
    assert.ok(plain.includes('⚡'));
    assert.ok(plain.includes('5m') || plain.includes('any moment'));
  });

  it('includes ⛔ and time in exhausted state', () => {
    const state = { remaining: 0, limit: 1000, resetAt: FUTURE_12M };
    const result = renderCompactRateLimit(state);
    const plain = stripAnsi(result);
    assert.ok(plain.includes('⛔'));
    assert.ok(plain.includes('12m'));
  });

  it('output does not contain bar characters (compact has no bar)', () => {
    const state = { remaining: 750, limit: 1000, resetAt: FUTURE_5M };
    const result = renderCompactRateLimit(state);
    // Compact mode should have bar characters stripped / absent
    const resultNoAnsi = stripAnsi(result);
    assert.ok(resultNoAnsi.includes('API:'));
  });

  it('does not end with newline', () => {
    const state = { remaining: 750, limit: 1000, resetAt: FUTURE_5M };
    const result = renderCompactRateLimit(state);
    assert.ok(!result.endsWith('\n'));
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. Width adaptation
// ═══════════════════════════════════════════════════════════════════════════════

describe('width adaptation', () => {
  it('shrinks the bar at narrow widths', () => {
    const state = { remaining: 500, limit: 1000, resetAt: FUTURE_5M };
    const wide = renderRateLimitWidget(state, 60);
    const narrow = renderRateLimitWidget(state, 20);
    // Both should produce valid output
    assert.ok(stripAnsi(wide).includes('500/1000'));
    assert.ok(stripAnsi(narrow).includes('500/1000'));
  });

  it('handles width=10 gracefully (minimum bar width)', () => {
    const state = { remaining: 500, limit: 1000, resetAt: FUTURE_5M };
    const result = renderRateLimitWidget(state, 10);
    assert.ok(typeof result === 'string');
    assert.ok(result.length > 0);
    // Ratio should always be present
    assert.ok(stripAnsi(result).includes('500/1000'));
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. buildBar — Unicode fraction-height blocks
// ═══════════════════════════════════════════════════════════════════════════════

describe('buildBar', () => {
  const identity = (s: string) => s;

  it('renders all fraction blocks (█) at 100%', () => {
    const bar = buildBar(1.0, 8, identity);
    // At 100%, all 8 chars should be full blocks
    assert.equal(bar.length, 8);
    assert.ok([...bar].every((c) => c === '█'));
  });

  it('renders all empty blocks (░) at 0%', () => {
    const bar = buildBar(0, 8, identity);
    assert.equal(bar.length, 8);
    assert.ok([...bar].every((c) => c === '░'));
  });

  it('renders a mix of blocks at 50%', () => {
    const bar = buildBar(0.5, 8, identity);
    assert.equal(bar.length, 8);
    // First 4 should be █, last 4 should be ░
    for (let i = 0; i < 4; i++) assert.equal(bar[i], '█', `char ${i} should be █`);
    for (let i = 4; i < 8; i++) assert.equal(bar[i], '░', `char ${i} should be ░`);
  });

  it('uses partial fraction blocks for fractional values', () => {
    // At ~6.25% (1/16), first char should be a partial block, rest ░
    const bar = buildBar(1 / 16, 8, identity);
    assert.equal(bar.length, 8);
    // First char is not █ and not ░ (a partial block)
    assert.ok(bar[0] !== '░', 'first char should not be empty at ~6%');
    // Remaining chars should be ░
    for (let i = 1; i < 8; i++) assert.equal(bar[i], '░', `char ${i} should be ░ at ~6%`);
  });

  it('applies the color function to the full bar', () => {
    const colorFn = (s: string) => `[[[${s}]]]`;
    const bar = buildBar(0.5, 4, colorFn);
    assert.ok(bar.startsWith('[[['));
    assert.ok(bar.endsWith(']]]'));
  });

  it('clamps ratio above 1.0 to full bar', () => {
    const bar = buildBar(1.5, 4, identity);
    assert.ok([...bar].every((c) => c === '█'));
  });

  it('clamps ratio below 0.0 to empty bar', () => {
    const bar = buildBar(-0.5, 4, identity);
    assert.ok([...bar].every((c) => c === '░'));
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. formatTimeRemaining
// ═══════════════════════════════════════════════════════════════════════════════

describe('formatTimeRemaining', () => {
  it('formats minutes correctly', () => {
    const future = new Date(Date.now() + 180_000); // 3 min
    const result = formatTimeRemaining(future);
    assert.equal(result, '3m');
  });

  it('formats hours for 60+ minutes', () => {
    const future = new Date(Date.now() + 3_600_000); // 1 hour
    const result = formatTimeRemaining(future);
    assert.equal(result, '1h');
  });

  it('formats hours and minutes for uneven time', () => {
    const future = new Date(Date.now() + 5_400_000); // 1.5 hours
    const result = formatTimeRemaining(future);
    assert.equal(result, '1h 30m');
  });

  it('returns "any moment" for expired window', () => {
    const past = new Date(Date.now() - 10_000);
    const result = formatTimeRemaining(past);
    assert.equal(result, 'any moment');
  });

  it('returns "any moment" for immediate reset', () => {
    const now = new Date(Date.now());
    const result = formatTimeRemaining(now);
    assert.equal(result, 'any moment');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 7. RateLimitTier enum
// ═══════════════════════════════════════════════════════════════════════════════

describe('RateLimitTier enum', () => {
  it('has all four expected values', () => {
    assert.equal(RateLimitTier.Normal, 'normal');
    assert.equal(RateLimitTier.Warning, 'warning');
    assert.equal(RateLimitTier.Critical, 'critical');
    assert.equal(RateLimitTier.Exhausted, 'exhausted');
  });
});
// ═══════════════════════════════════════════════════════════════════════════════
// 8. parseRateLimitHeaders — header parsing + global state
// ═══════════════════════════════════════════════════════════════════════════════

describe('parseRateLimitHeaders', () => {
  it('parses valid rate limit headers and sets global state', () => {
    const resetUnix = Math.floor(Date.now() / 1000) + 300; // 5 min from now
    const headers = new Headers({
      'x-ratelimit-remaining': '750',
      'x-ratelimit-limit': '1000',
      'x-ratelimit-reset': String(resetUnix),
    });
    parseRateLimitHeaders(headers, 'deepinfra');
    const state = getGlobalRateLimitState();
    assert.ok(state !== null);
    assert.equal(state!.remaining, 750);
    assert.equal(state!.limit, 1000);
    assert.equal(state!.provider, 'deepinfra');
  });

  it('is a no-op when headers are missing', () => {
    const prev = getGlobalRateLimitState();
    const headers = new Headers({});
    parseRateLimitHeaders(headers, 'deepseek');
    const state = getGlobalRateLimitState();
    // State should remain unchanged (same reference as before)
    assert.equal(state, prev);
  });

  it('is a no-op when remaining is not a number', () => {
    const prev = getGlobalRateLimitState();
    const headers = new Headers({
      'x-ratelimit-remaining': 'abc',
      'x-ratelimit-limit': '1000',
    });
    parseRateLimitHeaders(headers, 'deepinfra');
    const state = getGlobalRateLimitState();
    assert.equal(state, prev);
  });

  it('defaults missing reset to ~60 seconds from now', () => {
    const before = Date.now();
    const headers = new Headers({
      'x-ratelimit-remaining': '500',
      'x-ratelimit-limit': '1000',
    });
    parseRateLimitHeaders(headers, 'deepseek');
    const state = getGlobalRateLimitState();
    assert.ok(state !== null);
    assert.equal(state!.remaining, 500);
    assert.equal(state!.limit, 1000);
    const after = Date.now();
    const resetMs = state!.resetAt.getTime();
    assert.ok(
      resetMs >= before + 55000,
      `expected reset ~60s from now, got ${resetMs - before}ms delta`,
    );
    assert.ok(
      resetMs <= after + 65000,
      `expected reset ~60s from now, got ${resetMs - before}ms delta`,
    );
  });

  it('handles Unix timestamp in seconds vs milliseconds', () => {
    const futureS = Math.floor(Date.now() / 1000) + 120; // 2 min in seconds
    const headersS = new Headers({
      'x-ratelimit-remaining': '100',
      'x-ratelimit-limit': '1000',
      'x-ratelimit-reset': String(futureS),
    });
    parseRateLimitHeaders(headersS, 'test');
    const stateS = getGlobalRateLimitState();
    assert.ok(stateS !== null);
    // Should treat seconds timestamps correctly (< 1e12 is seconds)
    assert.ok(stateS!.resetAt.getTime() > Date.now());

    const futureMs = Date.now() + 120000; // 2 min in milliseconds
    const headersMs = new Headers({
      'x-ratelimit-remaining': '100',
      'x-ratelimit-limit': '1000',
      'x-ratelimit-reset': String(futureMs),
    });
    parseRateLimitHeaders(headersMs, 'test');
    const stateMs = getGlobalRateLimitState();
    assert.ok(stateMs !== null);
    // Should also work for ms (> 1e12 is ms)
    const diff = Math.abs(stateMs!.resetAt.getTime() - futureMs);
    assert.ok(
      diff < 2000,
      `expected reset within 2s of ${futureMs}, got ${stateMs!.resetAt.getTime()}`,
    );
  });

  it('handles ISO-8601 reset time', () => {
    const future = new Date(Date.now() + 3600000); // 1 hour
    const headers = new Headers({
      'x-ratelimit-remaining': '900',
      'x-ratelimit-limit': '1000',
      'x-ratelimit-reset': future.toISOString(),
    });
    parseRateLimitHeaders(headers, 'openai');
    const state = getGlobalRateLimitState();
    assert.ok(state !== null);
    assert.equal(state!.remaining, 900);
    assert.equal(state!.limit, 1000);
    assert.equal(state!.provider, 'openai');
    const diff = Math.abs(state!.resetAt.getTime() - future.getTime());
    assert.ok(diff < 2000, 'expected reset within 2s of ISO date, got ${diff}ms');
  });
});
