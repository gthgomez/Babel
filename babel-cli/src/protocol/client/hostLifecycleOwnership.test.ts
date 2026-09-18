/**
 * P01 — owner-token guard unit coverage.
 *
 * A stale finalizer must not be able to clear a successor's ownership. This is
 * inherently a guard property: under the shipped busy policy a successor cannot
 * be admitted while a predecessor is unsettled, so the guard is verified
 * directly against the ownership primitive used by the handler.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createProtocolHostState, releaseLaunchOwnership, type ActiveLaunch } from './index.js';

test('P01: an obsolete finalizer cannot clear a successor owner', () => {
  const state = createProtocolHostState();
  const predecessor: ActiveLaunch = {
    turnId: 1,
    generation: 1,
    cancelRequested: true,
    settled: true,
  };
  const successor: ActiveLaunch = {
    turnId: 2,
    generation: 2,
    cancelRequested: false,
    settled: false,
  };
  state.activeTurns.set('thread-x', successor);

  const releasedByStale = releaseLaunchOwnership(state, 'thread-x', predecessor);
  assert.equal(releasedByStale, false, 'stale generation must not release ownership');
  assert.equal(
    state.activeTurns.get('thread-x'),
    successor,
    'successor ownership must survive the obsolete finalizer',
  );

  const releasedByOwner = releaseLaunchOwnership(state, 'thread-x', successor);
  assert.equal(releasedByOwner, true, 'the actual owner releases its own launch');
  assert.equal(state.activeTurns.has('thread-x'), false);
});

test('P01: releasing an already-cleared launch is a no-op', () => {
  const state = createProtocolHostState();
  const launch: ActiveLaunch = {
    turnId: 1,
    generation: 1,
    cancelRequested: false,
    settled: true,
  };
  assert.equal(releaseLaunchOwnership(state, 'thread-x', launch), false);
  assert.equal(state.activeTurns.has('thread-x'), false);
});
