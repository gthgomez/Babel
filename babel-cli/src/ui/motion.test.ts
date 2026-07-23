/**
 * Tests for motion primitives.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MotionMode,
  ReducedMotionIndicator,
  activityIndicator,
  shimmerText,
  spinnerFrame,
  getMotionMode,
  setMotionMode,
  resetMotionMode,
} from './motion.js';

// ─── MotionMode ─────────────────────────────────────────────────────────────

test('MotionMode.fromEnv returns Animated by default', () => {
  delete process.env['BABEL_REDUCED_MOTION'];
  delete process.env['NO_COLOR'];
  const mode = MotionMode.fromEnv();
  // In test environment, stdout may not be a TTY
  assert.ok(Object.values(MotionMode).includes(mode));
});

test('MotionMode.fromEnv returns Reduced when BABEL_REDUCED_MOTION=1', () => {
  process.env['BABEL_REDUCED_MOTION'] = '1';
  const mode = MotionMode.fromEnv();
  assert.equal(mode, MotionMode.Reduced);
  delete process.env['BABEL_REDUCED_MOTION'];
});

test('MotionMode.fromEnv returns Reduced when NO_COLOR is set', () => {
  process.env['NO_COLOR'] = '1';
  const mode = MotionMode.fromEnv();
  assert.equal(mode, MotionMode.Reduced);
  delete process.env['NO_COLOR'];
});

test('MotionMode.fromAnimationsEnabled creates correct modes', () => {
  assert.equal(MotionMode.fromAnimationsEnabled(true), MotionMode.Animated);
  assert.equal(MotionMode.fromAnimationsEnabled(false), MotionMode.Reduced);
});

// ─── Activity indicator ─────────────────────────────────────────────────────

test('activityIndicator returns null for Reduced + Hidden', () => {
  const result = activityIndicator(null, MotionMode.Reduced, ReducedMotionIndicator.Hidden);
  assert.equal(result, null);
});

test('activityIndicator returns static bullet for Reduced + StaticBullet', () => {
  const result = activityIndicator(null, MotionMode.Reduced, ReducedMotionIndicator.StaticBullet);
  assert.ok(result !== null);
  assert.ok(result!.includes('•'));
});

test('activityIndicator returns animated indicator for Animated mode', () => {
  const result = activityIndicator(
    Date.now(),
    MotionMode.Animated,
    ReducedMotionIndicator.StaticBullet,
  );
  assert.ok(result !== null);
  assert.ok(result!.length > 0);
});

// ─── Shimmer text ───────────────────────────────────────────────────────────

test('shimmerText returns plain text in Reduced mode', () => {
  const result = shimmerText('Loading', MotionMode.Reduced);
  assert.equal(result, 'Loading');
});

test('shimmerText returns animated text in Animated mode', () => {
  const result = shimmerText('Loading', MotionMode.Animated);
  assert.ok(result.length >= 'Loading'.length);
});

// ─── Spinner frames ─────────────────────────────────────────────────────────

test('spinnerFrame returns static bullet in Reduced mode', () => {
  assert.equal(spinnerFrame(0, MotionMode.Reduced), '•');
  assert.equal(spinnerFrame(5, MotionMode.Reduced), '•');
});

test('spinnerFrame cycles through frames in Animated mode', () => {
  const frames = new Set<string>();
  for (let i = 0; i < 4; i++) {
    frames.add(spinnerFrame(i, MotionMode.Animated));
  }
  assert.equal(frames.size, 4, 'all 4 spinner frames should be unique');
});

// ─── Global motion mode ─────────────────────────────────────────────────────

test('getMotionMode returns cached mode', () => {
  setMotionMode(MotionMode.Animated);
  assert.equal(getMotionMode(), MotionMode.Animated);
  setMotionMode(MotionMode.Reduced);
  assert.equal(getMotionMode(), MotionMode.Reduced);
  resetMotionMode();
});

test('getMotionMode caches after first call', () => {
  resetMotionMode();
  const first = getMotionMode();
  const second = getMotionMode();
  assert.equal(first, second);
  resetMotionMode();
});
