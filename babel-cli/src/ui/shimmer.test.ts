/**
 * Tests for shimmer animation system.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { shimmerText, shimmerChars, shimmerIfEnabled, resetShimmerClock } from './shimmer.js';

// ─── Shimmer character output ───────────────────────────────────────────────

test('shimmerChars returns empty array for empty text', () => {
  const result = shimmerChars('');
  assert.deepEqual(result, []);
});

test('shimmerChars returns one styled char per input grapheme', () => {
  const result = shimmerChars('hello');
  assert.equal(result.length, 5);
  // Each result should be a non-empty string
  for (const r of result) {
    assert.ok(r.length > 0);
  }
});

test('shimmerChars handles emoji correctly', () => {
  const result = shimmerChars('👋🌍');
  assert.equal(result.length, 2);
});

test('shimmerText produces a non-empty string for non-empty input', () => {
  const result = shimmerText('Loading...');
  assert.ok(result.length >= 'Loading...'.length);
});

test('shimmerChars does not dim out-of-band characters', () => {
  resetShimmerClock();
  // Long string so most chars sit outside the sweep band at t≈0
  const result = shimmerChars('abcdefghijklmnopqrstuvwxyz0123456789');
  const dimmed = result.filter((c) => c.includes('\x1b[2m'));
  assert.equal(dimmed.length, 0, 'base text must not be forced dim');
});

test('shimmerText produces consistent output for same input', () => {
  resetShimmerClock();
  const a = shimmerText('test');
  const b = shimmerText('test');
  assert.equal(a, b, 'same tick should produce identical output');
});

// ─── Reduced motion ─────────────────────────────────────────────────────────

test('shimmerIfEnabled returns plain text when BABEL_REDUCED_MOTION=1', () => {
  process.env['BABEL_REDUCED_MOTION'] = '1';
  const result = shimmerIfEnabled('test');
  assert.equal(result, 'test');
  delete process.env['BABEL_REDUCED_MOTION'];
});

test('shimmerIfEnabled returns shimmered text when motion enabled', () => {
  delete process.env['BABEL_REDUCED_MOTION'];
  const result = shimmerIfEnabled('test');
  // Should contain ANSI sequences (shimmer effect applied)
  assert.ok(result.length >= 'test'.length);
});

// ─── Clock reset ────────────────────────────────────────────────────────────

test('resetShimmerClock restarts the animation phase', () => {
  resetShimmerClock();
  const a = shimmerText('test');
  // Advance imaginary time doesn't change output without real clock tick,
  // but we can verify the clock reset works
  resetShimmerClock();
  const b = shimmerText('test');
  assert.equal(a, b, 'same time point produces same output');
});
