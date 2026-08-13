import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  canSubmitNextTask,
  handleInteractiveInterrupt,
  notifyRunEnded,
  notifyRunStarted,
  resetInterruptHostForTests,
} from './interruptHost.js';
import { InputCoordinator } from './inputCoordinator.js';
import { TerminalRestoreGuard } from './terminalRestoreGuard.js';
import { DEC_2026_END } from './terminalEscapeSequences.js';
import { presentChatReview } from './reviewCard.js';

afterEach(() => {
  resetInterruptHostForTests();
});

function recoverFrom(outcome: string): { promptUsable: boolean; nextOk: boolean; kind: string } {
  notifyRunStarted();
  handleInteractiveInterrupt(
    { composerEmpty: true },
    {
      cancelTurn: () => undefined,
      clearComposer: () => undefined,
      cancelPaste: () => undefined,
      declineOverlay: () => undefined,
      restorePrompt: () => undefined,
      hintExit: () => undefined,
      requestExit: () => undefined,
    },
  );
  notifyRunEnded();
  const card = presentChatReview({ outcome, verification: { ran: false } });
  return {
    promptUsable: canSubmitNextTask(),
    nextOk: canSubmitNextTask(),
    kind: card.kind,
  };
}

describe('recovery after terminal states', () => {
  it('returns a usable prompt after verify-fail, block, provider, budget, and cancel', () => {
    for (const outcome of [
      'CANCELLED',
      'BLOCKED_POLICY',
      'INFRA_FAILURE',
      'BUDGET_EXHAUSTED',
      'UNVERIFIED_PATCH',
    ]) {
      resetInterruptHostForTests();
      const recovered = recoverFrom(outcome);
      assert.equal(recovered.promptUsable, true, outcome);
      assert.equal(recovered.nextOk, true, outcome);
    }
  });

  it('teardown helpers show cursor, reset scroll region, and end DEC 2026', () => {
    const writes: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    const stub = ((chunk: string | Uint8Array) => {
      writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
      return true;
    }) as typeof process.stdout.write;
    process.stdout.write = stub;
    try {
      const guard = new TerminalRestoreGuard();
      guard.restore();
      InputCoordinator.getInstance().emergencyRestore();
    } finally {
      process.stdout.write = original;
    }
    assert.ok(writes.some((w) => w.includes('\x1b[?25h')), 'cursor shown');
    assert.ok(writes.some((w) => w === '\x1b[r'), 'scroll region reset');
    assert.ok(writes.some((w) => w === DEC_2026_END), 'DEC 2026 ended');
  });
});
