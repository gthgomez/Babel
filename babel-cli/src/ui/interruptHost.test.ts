/**
 * Drives the shipped interrupt host + input arbiter from a real start state.
 * These tests are the P0 cancel/composer contract — not a reimplementation.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  dispatchInputArbiter,
  getInputArbiterState,
} from './inputCoordinator.js';
import {
  appendStreamingDraft,
  canSubmitNextTask,
  EXIT_HINT,
  handleInteractiveInterrupt,
  notifyOverlayClosed,
  notifyOverlayOpened,
  notifyRunEnded,
  notifyRunStarted,
  peekComposerDraft,
  peekStreamingDraft,
  preserveComposerAcrossResize,
  resetInterruptHostForTests,
  snapshotComposerDraft,
  takeComposerDraft,
  takeStreamingDraft,
  wasExitRequested,
} from './interruptHost.js';

interface Harness {
  cancelledTurns: number;
  cleared: number;
  pasteCancelled: number;
  overlaysDeclined: number;
  hints: string[];
  exits: number;
  prompts: number;
  lastOutcome: ReturnType<typeof handleInteractiveInterrupt> | null;
}

function createHarness(): Harness {
  resetInterruptHostForTests();
  const h: Harness = {
    cancelledTurns: 0,
    cleared: 0,
    pasteCancelled: 0,
    overlaysDeclined: 0,
    hints: [],
    exits: 0,
    prompts: 0,
    lastOutcome: null,
  };
  return h;
}

function interrupt(
  h: Harness,
  ctx: { composerEmpty?: boolean; inPaste?: boolean; overlayActive?: boolean } = {},
): ReturnType<typeof handleInteractiveInterrupt> {
  const result = handleInteractiveInterrupt(
    {
      composerEmpty: ctx.composerEmpty ?? true,
      inPaste: ctx.inPaste ?? false,
      overlayActive: ctx.overlayActive ?? false,
    },
    {
      cancelTurn: () => {
        h.cancelledTurns += 1;
      },
      clearComposer: () => {
        h.cleared += 1;
      },
      cancelPaste: () => {
        h.pasteCancelled += 1;
      },
      declineOverlay: () => {
        h.overlaysDeclined += 1;
      },
      restorePrompt: () => {
        h.prompts += 1;
      },
      hintExit: (message) => {
        h.hints.push(message);
      },
      requestExit: () => {
        h.exits += 1;
      },
    },
  );
  h.lastOutcome = result;
  return result;
}

afterEach(() => {
  resetInterruptHostForTests();
});

describe('interrupt host — running task Ctrl+C', () => {
  it('cancels the turn, stays alive, and allows a subsequent submit', () => {
    const h = createHarness();
    notifyRunStarted();
    assert.equal(getInputArbiterState().mode, 'running');
    assert.deepEqual(
      getInputArbiterState().stdinOwner === 'running' ? ['running'] : [],
      ['running'],
    );

    const first = interrupt(h);
    assert.equal(first.cancelled, true);
    assert.equal(first.exited, false);
    assert.equal(first.processStayedAlive, true);
    assert.equal(h.cancelledTurns, 1);
    assert.equal(h.exits, 0);
    assert.equal(h.prompts, 1);
    assert.equal(canSubmitNextTask(), true);

    notifyRunEnded();
    dispatchInputArbiter({ type: 'submit' });
    notifyRunStarted();
    const next = interrupt(h);
    assert.equal(next.cancelled, true);
    assert.equal(h.cancelledTurns, 2);
    assert.equal(h.exits, 0);
    assert.equal(canSubmitNextTask(), true);
  });

  it('does not paint cancel as success or failure on the arbiter', () => {
    const h = createHarness();
    notifyRunStarted();
    const result = interrupt(h);
    assert.equal(result.cancelled, true);
    assert.equal(result.exited, false);
    assert.equal(result.arbiter.mode, 'running');
    assert.equal(result.arbiter.cancelArmed, true);
    assert.ok(!result.clearedComposer);
  });

  it('second Ctrl+C while still running after cancel requests exit', () => {
    const h = createHarness();
    notifyRunStarted();
    interrupt(h);
    const second = interrupt(h);
    assert.equal(second.exited, true);
    assert.equal(second.processStayedAlive, false);
    assert.equal(h.exits, 1);
  });
});

describe('interrupt host — idle composer', () => {
  it('clears a non-empty composer and does not exit', () => {
    const h = createHarness();
    const result = interrupt(h, { composerEmpty: false });
    assert.equal(result.clearedComposer, true);
    assert.equal(result.exited, false);
    assert.equal(result.processStayedAlive, true);
    assert.equal(h.cleared, 1);
    assert.equal(h.exits, 0);
    assert.equal(h.prompts, 1);
  });

  it('does not exit on a single empty Ctrl+C; hints instead', () => {
    const h = createHarness();
    const first = interrupt(h, { composerEmpty: true });
    assert.equal(first.hintedExit, true);
    assert.equal(first.exited, false);
    assert.equal(first.processStayedAlive, true);
    assert.equal(h.exits, 0);
    assert.deepEqual(h.hints, [EXIT_HINT]);
    assert.equal(wasExitRequested(), false);
  });

  it('exits only on the second empty Ctrl+C', () => {
    const h = createHarness();
    interrupt(h, { composerEmpty: true });
    const second = interrupt(h, { composerEmpty: true });
    assert.equal(second.exited, true);
    assert.equal(h.exits, 1);
  });

  it('typing after an exit hint disarms the exit (clear then empty)', () => {
    const h = createHarness();
    interrupt(h, { composerEmpty: true });
    const clear = interrupt(h, { composerEmpty: false });
    assert.equal(clear.clearedComposer, true);
    assert.equal(clear.exited, false);
    const emptyAgain = interrupt(h, { composerEmpty: true });
    assert.equal(emptyAgain.hintedExit, true);
    assert.equal(emptyAgain.exited, false);
    assert.equal(h.exits, 0);
  });
});

describe('interrupt host — paste / overlay', () => {
  it('cancels paste mode and returns to the composer', () => {
    const h = createHarness();
    const result = interrupt(h, { inPaste: true, composerEmpty: false });
    assert.equal(result.cancelledPaste, true);
    assert.equal(result.exited, false);
    assert.equal(h.pasteCancelled, 1);
    assert.equal(h.prompts, 1);
  });

  it('declines an overlay, restores draft, and does not start a chat task', () => {
    const h = createHarness();
    snapshotComposerDraft('partial draft');
    notifyOverlayOpened();
    assert.equal(getInputArbiterState().mode, 'dialog');
    const result = interrupt(h, { overlayActive: true });
    assert.equal(result.declinedOverlay, true);
    assert.equal(result.exited, false);
    assert.equal(h.overlaysDeclined, 1);
    const restored = notifyOverlayClosed();
    assert.equal(restored, 'partial draft');
    assert.equal(peekComposerDraft(), null);
    assert.equal(canSubmitNextTask(), true);
  });

  it('takeComposerDraft is single-use so picker digits cannot leak', () => {
    snapshotComposerDraft('11');
    assert.equal(takeComposerDraft(), '11');
    assert.equal(takeComposerDraft(), null);
  });
});

describe('interrupt host — composer survives stream and resize', () => {
  it('keeps type-during-stream draft intact', () => {
    resetInterruptHostForTests();
    notifyRunStarted();
    appendStreamingDraft('abc');
    appendStreamingDraft('d');
    assert.equal(peekStreamingDraft(), 'abcd');
    notifyRunEnded();
    assert.equal(takeStreamingDraft(), 'abcd');
    assert.equal(takeStreamingDraft(), '');
  });

  it('resize does not drop draft', () => {
    let draft = 'still here after resize';
    preserveComposerAcrossResize(
      () => draft,
      (text) => {
        draft = text;
      },
    );
    assert.equal(draft, 'still here after resize');
  });
});

describe('interrupt host — exclusive stdin owner', () => {
  it('keeps exactly one stdin owner through prompt → run → overlay → prompt', () => {
    resetInterruptHostForTests();
    assert.equal(getInputArbiterState().stdinOwner, 'prompt');
    notifyRunStarted();
    assert.equal(getInputArbiterState().stdinOwner, 'running');
    dispatchInputArbiter({ type: 'approval_open' });
    assert.equal(getInputArbiterState().stdinOwner, 'approval');
    dispatchInputArbiter({ type: 'approval_close' });
    assert.equal(getInputArbiterState().stdinOwner, 'running');
    notifyRunEnded();
    assert.equal(getInputArbiterState().stdinOwner, 'prompt');
  });
});
