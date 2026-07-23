/**
 * Tests for RawModeManager.
 *
 * Verifies the raw-mode stdin lifecycle: enable/disable idempotency,
 * cursor management, suspend handler integration, TerminalRestoreGuard
 * integration, and non-TTY guard.
 */

import { describe, it, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { RawModeManager } from './rawMode.js';
import { installKeyHandler, installSuspendHandler, type KeyEvent } from './keyInput.js';
import { OutputBuffer } from './outputBuffer.js';
import { TerminalRestoreGuard } from './terminalRestoreGuard.js';

// ── Mocks ───────────────────────────────────────────────────────────────────

/** Create a mock NodeJS.ReadStream for testing. */
function mockStdin(options: { isTTY?: boolean } = {}): NodeJS.ReadStream {
  return {
    isRaw: false,
    isTTY: options.isTTY ?? true,
    setRawMode: mock.fn(),
    resume: mock.fn(),
    pause: mock.fn(),
    isPaused: () => false,
    on: mock.fn(),
    off: mock.fn(),
    readable: true,
    read: () => null,
    _read: () => {},
    push: () => false,
    unshift: () => {},
    destroy: () => {},
    addListener: () => mockStdin(),
    emit: () => true,
    eventNames: () => [],
    getMaxListeners: () => 0,
    listenerCount: () => 0,
    listeners: () => [],
    once: () => mockStdin(),
    prependListener: () => mockStdin(),
    prependOnceListener: () => mockStdin(),
    rawListeners: () => [],
    removeAllListeners: () => mockStdin(),
    removeListener: () => mockStdin(),
    setMaxListeners: () => mockStdin(),
    pipe: () => mockStdin() as unknown as NodeJS.WritableStream,
  } as unknown as NodeJS.ReadStream;
}

/** Intercept OutputBuffer writes to capture cursor sequences. */
function captureOutputBuffer(): { writes: string[]; restore: () => void } {
  const writes: string[] = [];
  const instance = OutputBuffer.getInstance();
  const origWrite = (instance as any).write;
  (instance as any).write = (text: string) => {
    if (text === '\x1b[?25l' || text === '\x1b[?25h') {
      writes.push(text);
    }
    return origWrite.call(instance, text);
  };
  return {
    writes,
    restore: () => {
      (instance as any).write = origWrite;
    },
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('RawModeManager', () => {
  let savedSetRawMode: any;
  let savedIsTTY: boolean | undefined;

  beforeEach(() => {
    // Save originals so we can restore
    savedSetRawMode = (process.stdin as any).setRawMode;
    savedIsTTY = (process.stdin as any).isTTY;
    // Stub process.stdin for suspend handler (installSuspendHandler uses it)
    (process.stdin as any).isTTY = true;
    (process.stdin as any).setRawMode = mock.fn();

    // Reset the OutputBuffer singleton to clear any frame state
    OutputBuffer.resetInstance();
  });

  afterEach(() => {
    (process.stdin as any).setRawMode = savedSetRawMode;
    (process.stdin as any).isTTY = savedIsTTY;
    // Reset the OutputBuffer singleton
    OutputBuffer.resetInstance();
  });

  // ── Constructor ─────────────────────────────────────────────────────────

  it('starts inactive', () => {
    const stdin = mockStdin();
    const manager = new RawModeManager(stdin);
    assert.equal(manager.isActive, false);
    manager.dispose();
  });

  it('accepts default process.stdin', () => {
    const manager = new RawModeManager();
    assert.equal(manager.isActive, false);
    manager.dispose();
  });

  // ── enable / disable ────────────────────────────────────────────────────

  it('enable sets isActive and installs handlers', () => {
    const stdin = mockStdin();
    const manager = new RawModeManager(stdin);
    const callback = (_event: KeyEvent) => {};

    manager.enable(callback);
    assert.equal(manager.isActive, true);

    // installKeyHandler should have set raw mode on the stream
    assert.equal((stdin.setRawMode as any).mock.calls.length, 1);
    // The mock fn is called with `true` (enable raw mode)
    const setRawCall = (stdin.setRawMode as any).mock.calls[0];
    assert.equal(setRawCall.arguments[0], true);

    manager.disable();
    assert.equal(manager.isActive, false);
    manager.dispose();
  });

  it('disable restores raw mode and removes handlers', () => {
    const stdin = mockStdin();
    const manager = new RawModeManager(stdin);
    const callback = (_event: KeyEvent) => {};

    manager.enable(callback);
    assert.equal(manager.isActive, true);

    manager.disable();
    assert.equal(manager.isActive, false);

    // installKeyHandler cleanup sets raw mode back to previous (false)
    // The cleanup fn calls setRawMode(wasRaw) where wasRaw = isRaw = false
    // Now find a call with false in the full history (enable called with true,
    // cleanup calls with false)
    const calls = (stdin.setRawMode as any).mock.calls;
    const restoreCall = calls.filter((c: any) => c.arguments[0] === false);
    assert.ok(restoreCall.length >= 1, 'raw mode should be restored to false on disable');
    manager.dispose();
  });

  it('enable is idempotent — second call is no-op', () => {
    const stdin = mockStdin();
    const manager = new RawModeManager(stdin);
    const callback = (_event: KeyEvent) => {};

    manager.enable(callback);
    const callsAfterFirst = (stdin.setRawMode as any).mock.calls.length;

    manager.enable(callback);
    const callsAfterSecond = (stdin.setRawMode as any).mock.calls.length;

    // Should not have added any new calls
    assert.equal(callsAfterFirst, callsAfterSecond);
    assert.equal(manager.isActive, true);

    manager.disable();
    manager.dispose();
  });

  it('disable is idempotent — second call is no-op', () => {
    const stdin = mockStdin();
    const manager = new RawModeManager(stdin);
    const callback = (_event: KeyEvent) => {};
    manager.enable(callback);

    manager.disable();
    assert.equal(manager.isActive, false);

    // Second disable should be a no-op (no errors)
    manager.disable();
    assert.equal(manager.isActive, false);
    manager.dispose();
  });

  // ── Non-TTY stdin ──────────────────────────────────────────────────────

  it('enable is no-op when stdin is not a TTY', () => {
    const stdin = mockStdin({ isTTY: false });
    const manager = new RawModeManager(stdin);
    const callback = (_event: KeyEvent) => {};

    manager.enable(callback);
    // Should not set raw mode or install handlers
    assert.equal(manager.isActive, false);
    assert.equal((stdin.setRawMode as any).mock.calls.length, 0);

    manager.disable(); // should be no-op
    manager.dispose();
  });

  // ── Cursor management ──────────────────────────────────────────────────

  it('hides cursor on enable (default manageCursor=true)', () => {
    const { writes, restore } = captureOutputBuffer();
    try {
      const stdin = mockStdin();
      const manager = new RawModeManager(stdin);
      const callback = (_event: KeyEvent) => {};

      manager.enable(callback);
      assert.ok(writes.includes('\x1b[?25l'), 'cursor should be hidden on enable');
      assert.equal(writes.length, 1);

      manager.disable();
      assert.ok(writes.includes('\x1b[?25h'), 'cursor should be shown on disable');
      manager.dispose();
    } finally {
      restore();
    }
  });

  it('does NOT manage cursor when manageCursor=false', () => {
    const { writes, restore } = captureOutputBuffer();
    try {
      const stdin = mockStdin();
      const manager = new RawModeManager(stdin, { manageCursor: false });
      const callback = (_event: KeyEvent) => {};

      manager.enable(callback);
      assert.equal(writes.length, 0, 'no cursor sequence should be written');

      manager.disable();
      assert.equal(writes.length, 0, 'no cursor sequence should be written');
      manager.dispose();
    } finally {
      restore();
    }
  });

  // ── forceCleanup ────────────────────────────────────────────────────────

  it('forceCleanup is an alias for disable', () => {
    const stdin = mockStdin();
    const manager = new RawModeManager(stdin);
    const callback = (_event: KeyEvent) => {};
    manager.enable(callback);
    assert.equal(manager.isActive, true);

    manager.forceCleanup();
    assert.equal(manager.isActive, false);

    // Should be idempotent like disable
    manager.forceCleanup();
    assert.equal(manager.isActive, false);
    manager.dispose();
  });

  // ── TerminalRestoreGuard integration ───────────────────────────────────

  it('registers onRestore callback with TerminalRestoreGuard', () => {
    const guard = new TerminalRestoreGuard();
    const stdin = mockStdin();
    const manager = new RawModeManager(stdin, { restoreGuard: guard });
    const callback = (_event: KeyEvent) => {};

    manager.enable(callback);
    assert.equal(manager.isActive, true);

    // Simulate guard restore (e.g. on signal or exception)
    guard.restore('signal');

    // After guard fires, raw mode should be disabled
    assert.equal(manager.isActive, false);
    manager.dispose();
  });

  it('dispose unregisters guard callback', () => {
    const guard = new TerminalRestoreGuard();
    const stdin = mockStdin();
    const manager = new RawModeManager(stdin, { restoreGuard: guard });
    const callback = (_event: KeyEvent) => {};

    manager.enable(callback);
    assert.equal(manager.isActive, true);

    // Dispose — should prevent guard from disabling again
    manager.dispose();

    // Guard restore should NOT disable the manager (already disposed)
    guard.restore('signal');
    assert.equal(manager.isActive, true);

    // Clean up manually
    manager.disable();
  });

  // ── Edge cases ─────────────────────────────────────────────────────────

  it('enable after previous disable re-installs handlers', () => {
    const stdin = mockStdin();
    const manager = new RawModeManager(stdin);
    const callback = (_event: KeyEvent) => {};

    manager.enable(callback);
    manager.disable();
    assert.equal(manager.isActive, false);

    // Re-enable should work
    manager.enable(callback);
    assert.equal(manager.isActive, true);

    manager.disable();
    manager.dispose();
  });

  it('does not crash when stdout writes fail', () => {
    // Simulate a broken output stream: make OutputBuffer think it's broken
    const instance = OutputBuffer.getInstance();
    (instance as any)._broken = true;

    const stdin = mockStdin();
    const manager = new RawModeManager(stdin);
    const callback = (_event: KeyEvent) => {};

    // Should not throw despite broken output
    manager.enable(callback);
    assert.equal(manager.isActive, true);

    manager.disable();
    assert.equal(manager.isActive, false);
    manager.dispose();

    // Restore
    (instance as any)._broken = false;
  });
});
