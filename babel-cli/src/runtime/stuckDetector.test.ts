/**
 * Packet A1 — stuck-loop detector.
 *
 * Fires at exactly N consecutive identical no-change turns; legitimate repeats
 * that mutate state never count.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_STUCK_THRESHOLD,
  isStuckLoop,
  StuckLoopDetector,
  type TurnObservation,
} from './stuckDetector.js';

const A: TurnObservation = { actionSignature: 'shell:npm test', stateDigest: 'hash-1' };

test('A1: default threshold is 3', () => {
  assert.equal(DEFAULT_STUCK_THRESHOLD, 3);
  assert.equal(new StuckLoopDetector().threshold, 3);
});

test('A1: detector fires at exactly N on a synthetic loop', () => {
  const detector = new StuckLoopDetector(); // N = 3
  assert.equal(detector.record(A).stuck, false);
  assert.equal(detector.record(A).stuck, false);
  const third = detector.record(A);
  assert.equal(third.stuck, true, 'must fire on the 3rd identical no-change turn');
  assert.equal(third.repeatCount, 3);
  // Edge-triggered: stays quiet on further identical turns.
  assert.equal(detector.record(A).stuck, false);
  assert.equal(detector.record(A).stuck, false);
});

test('A1: detector does not fire below N', () => {
  const detector = new StuckLoopDetector({ threshold: 4 });
  for (let index = 0; index < 3; index += 1) {
    assert.equal(detector.record(A).stuck, false);
  }
});

test('A1: legitimate repeats that mutate state never fire', () => {
  const detector = new StuckLoopDetector(); // N = 3
  for (let index = 0; index < 10; index += 1) {
    const result = detector.record({ actionSignature: A.actionSignature, stateDigest: `state-${index}` });
    assert.equal(result.stuck, false, `state-changing repeat ${index} must not count`);
    assert.equal(result.repeatCount, 1, 'a state change resets the repeat run');
  }
});

test('A1: pattern break resets the run, then re-fires on a fresh run', () => {
  const detector = new StuckLoopDetector();
  detector.record(A);
  detector.record(A);
  // Break the pattern.
  detector.record({ actionSignature: 'read:src/a.ts', stateDigest: 'hash-9' });
  assert.equal(detector.currentRepeats(), 1);
  // Re-form: three fresh identical no-change turns (threshold 3) fire again.
  assert.equal(detector.record(A).stuck, false);
  assert.equal(detector.record(A).stuck, false);
  assert.equal(detector.record(A).stuck, true);
});

test('A1: a signature change with unchanged digest also breaks the run', () => {
  const detector = new StuckLoopDetector();
  detector.record(A);
  detector.record(A);
  assert.equal(detector.record({ actionSignature: 'shell:other', stateDigest: 'hash-1' }).stuck, false);
  assert.equal(detector.currentRepeats(), 1);
});

test('A1: isStuckLoop pure classification matches the incremental detector', () => {
  assert.equal(isStuckLoop([A], {}), false);
  assert.equal(isStuckLoop([A, A], {}), false);
  assert.equal(isStuckLoop([A, A, A], {}), true);
  assert.equal(isStuckLoop([A, A, A], { threshold: 4 }), false);
  assert.equal(
    isStuckLoop([A, { ...A, stateDigest: 'next' }, A, A, A], {}),
    true,
    'trailing run of 3 fires regardless of earlier history',
  );
  assert.equal(
    isStuckLoop([A, { ...A, stateDigest: 'next' }, A, A], {}),
    false,
  );
});

test('A1: hostile input is total — never throws, never fabricates stuck', () => {
  const detector = new StuckLoopDetector({ threshold: Number.NaN });
  assert.equal(detector.threshold, DEFAULT_STUCK_THRESHOLD);
  // @ts-expect-error hostile input on purpose
  assert.equal(detector.record(null).stuck, false);
  // @ts-expect-error hostile input on purpose
  assert.equal(isStuckLoop(undefined, {}), false);
  assert.equal(isStuckLoop([undefined as unknown as TurnObservation, A, A], {}), false);
});
