/**
 * Bounded reflection counter on failed edits (packet C2).
 *
 * The tracker counts failed edit rounds per file per turn (owner submission
 * generation). Under the cap the loop reflects (failure diagnostics flow back
 * with an explicit retry note); at the cap it halts with an explicit surface.
 * A successful edit clears the file's count; a new turn resets everything.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  EditReflectionTracker,
  EDIT_REFLECTION_CAP_MARKER,
  MAX_EDIT_REFLECTION_ROUNDS,
  formatEditReflectionCapSurface,
  formatEditReflectionNote,
} from './reflection.js';

describe('EditReflectionTracker', () => {
  test('counts rounds per file and caps at MAX_EDIT_REFLECTION_ROUNDS', () => {
    const tracker = new EditReflectionTracker();
    for (let round = 1; round < MAX_EDIT_REFLECTION_ROUNDS; round++) {
      const decision = tracker.recordFailure(1, 'src/a.ts');
      assert.deepEqual(decision, { round, capped: false });
    }
    const capped = tracker.recordFailure(1, 'src/a.ts');
    assert.deepEqual(capped, { round: MAX_EDIT_REFLECTION_ROUNDS, capped: true });
  });

  test('tracks files independently', () => {
    const tracker = new EditReflectionTracker();
    tracker.recordFailure(1, 'src/a.ts');
    const other = tracker.recordFailure(1, 'src/b.ts');
    assert.deepEqual(other, { round: 1, capped: false });
    assert.equal(tracker.roundsFor('src/a.ts'), 1);
    assert.equal(tracker.roundsFor('src/b.ts'), 1);
  });

  test('a successful edit clears the file counter', () => {
    const tracker = new EditReflectionTracker();
    tracker.recordFailure(1, 'src/a.ts');
    tracker.recordFailure(1, 'src/a.ts');
    tracker.recordSuccess(1, 'src/a.ts');
    const fresh = tracker.recordFailure(1, 'src/a.ts');
    assert.deepEqual(fresh, { round: 1, capped: false });
  });

  test('a new turn key resets all counters (per file per turn)', () => {
    const tracker = new EditReflectionTracker();
    tracker.recordFailure(1, 'src/a.ts');
    tracker.recordFailure(1, 'src/a.ts');
    const nextTurn = tracker.recordFailure(2, 'src/a.ts');
    assert.deepEqual(nextTurn, { round: 1, capped: false });
  });

  test('the same file in a new turn starts from zero even after a cap', () => {
    const tracker = new EditReflectionTracker();
    for (let i = 0; i < MAX_EDIT_REFLECTION_ROUNDS; i++) {
      tracker.recordFailure(7, 'src/a.ts');
    }
    assert.equal(tracker.recordFailure(7, 'src/a.ts').capped, true);
    assert.equal(tracker.recordFailure(8, 'src/a.ts').capped, false);
  });
});

describe('reflection observation formatting', () => {
  test('note states the round, the cap, and the retry contract', () => {
    const note = formatEditReflectionNote({ round: 1, capped: false });
    assert.match(note, new RegExp(`reflection round 1/${MAX_EDIT_REFLECTION_ROUNDS}`));
    assert.match(note, /retry the same edit/);
    assert.match(note, /remain/);
  });

  test('cap surface is an explicit, headed failure surface embedding the failure', () => {
    const surface = formatEditReflectionCapSurface('src/a.ts', '### str_replace src/a.ts\nError: anchor not found');
    assert.match(surface, new RegExp(`### ${EDIT_REFLECTION_CAP_MARKER} src/a\\.ts`));
    assert.match(surface, new RegExp(`after ${MAX_EDIT_REFLECTION_ROUNDS} reflection rounds`));
    assert.match(surface, /stopped for this turn/);
    assert.ok(surface.includes('Error: anchor not found'), 'original diagnostics preserved');
  });
});
