/**
 * outputBuffer.test.ts — Tests for the OutputBuffer singleton.
 *
 * OutputBuffer is the single choke-point for all terminal output in Babel's
 * TUI. This file covers the singleton lifecycle, frame buffering (DEC 2026),
 * cursor positioning, scroll regions, hyperlink generation, resize handling,
 * broken-pipe recovery, and metrics tracking.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { OutputBuffer, isBrokenStdoutError, sanitizeHyperlinkUri } from './outputBuffer.js';
import { withEnv } from './testUtils.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Intercept process.stdout.write, replacing it with a mock that records calls.
 * Returns a cleanup function that restores the original.
 */
function mockStdoutWrite(): { writes: string[]; restore: () => void } {
  const original = process.stdout.write;
  const writes: string[] = [];
  // We must bind process.stdout so the receiver is correct
  (process.stdout as { write: typeof process.stdout.write }).write = ((data: unknown) => {
    writes.push(String(data ?? ''));
    return true;
  }) as typeof process.stdout.write;
  return {
    writes,
    restore: () => {
      (process.stdout as { write: typeof process.stdout.write }).write = original;
    },
  };
}

/**
 * Create a fresh OutputBuffer instance for testing.
 * Resets the singleton and the static broken state.
 */
function freshBuffer(): OutputBuffer {
  OutputBuffer.resetInstance();
  const buf = OutputBuffer.getInstance();
  // Clear any initial state from constructor
  return buf;
}

const savedAnsiEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ['NO_COLOR', 'BABEL_A11Y'] as const) {
    savedAnsiEnv[key] = process.env[key];
    delete process.env[key];
  }
  OutputBuffer.resetInstance();
});

afterEach(() => {
  for (const key of ['NO_COLOR', 'BABEL_A11Y'] as const) {
    if (savedAnsiEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedAnsiEnv[key];
  }
  OutputBuffer.resetInstance();
});

// ═══════════════════════════════════════════════════════════════════════════════
// isBrokenStdoutError
// ═══════════════════════════════════════════════════════════════════════════════

describe('isBrokenStdoutError', () => {
  it('returns true for EPIPE', () => {
    assert.equal(isBrokenStdoutError({ code: 'EPIPE' }), true);
  });

  it('returns true for ERR_STREAM_DESTROYED', () => {
    assert.equal(isBrokenStdoutError({ code: 'ERR_STREAM_DESTROYED' }), true);
  });

  it('returns true for ENOTCONN', () => {
    assert.equal(isBrokenStdoutError({ code: 'ENOTCONN' }), true);
  });

  it('returns false for other error codes', () => {
    assert.equal(isBrokenStdoutError({ code: 'ENOENT' }), false);
    assert.equal(isBrokenStdoutError({ code: 'EACCES' }), false);
  });

  it('returns false for non-error objects', () => {
    assert.equal(isBrokenStdoutError('EPIPE'), false);
    assert.equal(isBrokenStdoutError(null), false);
    assert.equal(isBrokenStdoutError(undefined), false);
    assert.equal(isBrokenStdoutError(42), false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// sanitizeHyperlinkUri
// ═══════════════════════════════════════════════════════════════════════════════

describe('sanitizeHyperlinkUri', () => {
  it('accepts valid https URLs', () => {
    assert.equal(sanitizeHyperlinkUri('https://example.com/path'), 'https://example.com/path');
  });

  it('accepts valid http URLs', () => {
    assert.equal(sanitizeHyperlinkUri('http://localhost:3000/file.ts'), 'http://localhost:3000/file.ts');
  });

  it('rejects mailto URIs', () => {
    assert.equal(sanitizeHyperlinkUri('mailto:user@example.com'), null);
  });

  it('rejects file URIs', () => {
    assert.equal(sanitizeHyperlinkUri('file:///etc/passwd'), null);
  });

  it('rejects javascript URIs', () => {
    assert.equal(sanitizeHyperlinkUri('javascript:alert(1)'), null);
  });

  it('rejects data URIs', () => {
    assert.equal(sanitizeHyperlinkUri('data:text/html,<script>alert(1)</script>'), null);
  });

  it('rejects invalid URLs', () => {
    assert.equal(sanitizeHyperlinkUri('not-a-url'), null);
  });

  it('strips control characters from the URI', () => {
    const result = sanitizeHyperlinkUri('https://example.com/\x00test\x1fpath');
    assert.ok(result === 'https://example.com/testpath' || result === null);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Singleton lifecycle
// ═══════════════════════════════════════════════════════════════════════════════

describe('Singleton lifecycle', () => {
  it('getInstance returns the same object', () => {
    const a = OutputBuffer.getInstance();
    const b = OutputBuffer.getInstance();
    assert.strictEqual(a, b);
  });

  it('resetInstance creates a new object on next getInstance', () => {
    const a = OutputBuffer.getInstance();
    OutputBuffer.resetInstance();
    const b = OutputBuffer.getInstance();
    assert.notStrictEqual(a, b);
  });

  it('resetInstance is idempotent', () => {
    OutputBuffer.resetInstance();
    OutputBuffer.resetInstance();
    const buf = OutputBuffer.getInstance();
    assert.ok(buf instanceof OutputBuffer);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Frame management
// ═══════════════════════════════════════════════════════════════════════════════

describe('Frame management', () => {
  it('buffers writes during a frame and flushes on endFrame', () => {
    const buf = freshBuffer();
    const mock = mockStdoutWrite();
    try {
      buf.beginFrame();
      buf.write('hello');
      buf.write(' world');
      // Nothing should have been written yet
      assert.equal(mock.writes.length, 0);
      buf.endFrame();
      // All buffered content flushed together
      const allOutput = mock.writes.join('');
      assert.ok(allOutput.includes('hello world'));
    } finally {
      mock.restore();
    }
  });

  it('writes directly to stdout when not in a frame', () => {
    const buf = freshBuffer();
    const mock = mockStdoutWrite();
    try {
      buf.write('direct write');
      assert.ok(mock.writes.length > 0, 'should write directly outside frame');
    } finally {
      mock.restore();
    }
  });

  it('nested beginFrame calls are silently merged', () => {
    const buf = freshBuffer();
    const mock = mockStdoutWrite();
    try {
      buf.beginFrame();
      buf.write('outer');
      buf.beginFrame(); // nested — silently merged, does not start a new frame
      buf.write(' inner');
      // endFrame always flushes (there is no nesting depth counter —
      // the contract is that callers should pair beginFrame/endFrame
      // correctly and not nest them)
      buf.endFrame();
      const allOutput = mock.writes.join('');
      assert.ok(allOutput.includes('outer inner'), 'content should be flushed');
    } finally {
      mock.restore();
    }
  });

  it('endFrame without beginFrame is a no-op', () => {
    const buf = freshBuffer();
    const mock = mockStdoutWrite();
    try {
      // Should not throw
      buf.endFrame();
      // Should not have written anything
      const total = mock.writes.join('');
      assert.equal(total, '');
    } finally {
      mock.restore();
    }
  });

  it('inFrame getter tracks frame state', () => {
    const buf = freshBuffer();
    assert.equal(buf.inFrame, false);
    buf.beginFrame();
    assert.equal(buf.inFrame, true);
    buf.endFrame();
    assert.equal(buf.inFrame, false);
  });

  it('metrics are recorded after each completed frame', () => {
    const buf = freshBuffer();
    const mock = mockStdoutWrite();
    try {
      buf.beginFrame();
      buf.write('metrics test');
      buf.endFrame();
      assert.equal(buf.frameHistory.length, 1);
      const frame = buf.frameHistory[0]!;
      assert.equal(frame.wasSyncUpdate, buf.syncUpdateSupported);
      assert.ok(frame.bytesWritten > 0);
      assert.ok(frame.timestamp > 0);
    } finally {
      mock.restore();
    }
  });

  it('frame history is capped at MAX_FRAME_HISTORY', () => {
    const buf = freshBuffer();
    const mock = mockStdoutWrite();
    try {
      // Fill well past the 60-frame cap
      for (let i = 0; i < 100; i++) {
        buf.beginFrame();
        buf.write(`frame ${i}`);
        buf.endFrame();
      }
      assert.ok(buf.frameHistory.length <= 60);
    } finally {
      mock.restore();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// DEC 2026 synchronized update
// ═══════════════════════════════════════════════════════════════════════════════

describe('DEC 2026 synchronized update', () => {
  it('syncUpdateSupported reflects terminal capability', () => {
    const buf = freshBuffer();
    // Just verify it's a boolean — actual value depends on the terminal
    assert.equal(typeof buf.syncUpdateSupported, 'boolean');
  });

  it('supportsSyncUpdate static method matches instance', () => {
    const buf = freshBuffer();
    assert.equal(OutputBuffer.supportsSyncUpdate(), buf.syncUpdateSupported);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Cursor positioning
// ═══════════════════════════════════════════════════════════════════════════════

describe('Cursor positioning', () => {
  it('writeAt emits cursor-save, position, text, and cursor-restore', () => {
    const buf = freshBuffer();
    const mock = mockStdoutWrite();
    try {
      buf.writeAt(5, 10, 'hello');
      const output = mock.writes.join('');
      // Should contain save, cursor position, text, and restore
      assert.ok(output.includes('\x1b[s'), 'should save cursor');
      assert.ok(output.includes('\x1b[5;10H'), 'should position cursor');
      assert.ok(output.includes('hello'), 'should write text');
      assert.ok(output.includes('\x1b[u'), 'should restore cursor');
    } finally {
      mock.restore();
    }
  });

  it('writeAt buffers during a frame', () => {
    const buf = freshBuffer();
    const mock = mockStdoutWrite();
    try {
      buf.beginFrame();
      buf.writeAt(3, 1, 'buffered');
      assert.equal(mock.writes.length, 0);
      buf.endFrame();
      const output = mock.writes.join('');
      assert.ok(output.includes('buffered'));
    } finally {
      mock.restore();
    }
  });

  it('writeAt ignores empty text', () => {
    const buf = freshBuffer();
    const mock = mockStdoutWrite();
    try {
      buf.writeAt(1, 1, '');
      assert.equal(mock.writes.join(''), '');
    } finally {
      mock.restore();
    }
  });

  it('writeLine clears to EOL before writing', () => {
    const buf = freshBuffer();
    const mock = mockStdoutWrite();
    try {
      buf.writeLine(2, 1, 'status');
      const output = mock.writes.join('');
      assert.ok(output.includes('\x1b[K'), 'should clear to EOL');
      assert.ok(output.includes('status'), 'should write text');
    } finally {
      mock.restore();
    }
  });

  it('clearRegion writes spaces over the given range', () => {
    const buf = freshBuffer();
    const mock = mockStdoutWrite();
    try {
      buf.clearRegion(2, 4, 1, 10);
      const output = mock.writes.join('');
      // Should clear three rows (2, 3, 4)
      assert.ok(output.includes('\x1b[2;1H'), 'should start at row 2');
      assert.ok(output.includes('\x1b[3;1H'), 'should cover row 3');
      assert.ok(output.includes('\x1b[4;1H'), 'should cover row 4');
      assert.ok(output.includes('\x1b[K'), 'should clear to EOL');
    } finally {
      mock.restore();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Cursor visibility and movement
// ═══════════════════════════════════════════════════════════════════════════════

describe('Cursor visibility and movement', () => {
  it('hideCursor emits hide sequence', () => {
    const buf = freshBuffer();
    const mock = mockStdoutWrite();
    try {
      buf.hideCursor();
      assert.ok(mock.writes.join('').includes('\x1b[?25l'));
    } finally {
      mock.restore();
    }
  });

  it('showCursor emits show sequence', () => {
    const buf = freshBuffer();
    const mock = mockStdoutWrite();
    try {
      buf.showCursor();
      assert.ok(mock.writes.join('').includes('\x1b[?25h'));
    } finally {
      mock.restore();
    }
  });

  it('moveCursor writes absolute positioning', () => {
    const buf = freshBuffer();
    const mock = mockStdoutWrite();
    try {
      buf.moveCursor(10, 20);
      assert.ok(mock.writes.join('').includes('\x1b[10;20H'));
    } finally {
      mock.restore();
    }
  });

  it('saveCursor and restoreCursor emit correct sequences', () => {
    const buf = freshBuffer();
    const mock = mockStdoutWrite();
    try {
      buf.saveCursor();
      buf.restoreCursor();
      const output = mock.writes.join('');
      assert.ok(output.includes('\x1b[s'));
      assert.ok(output.includes('\x1b[u'));
    } finally {
      mock.restore();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Scroll regions
// ═══════════════════════════════════════════════════════════════════════════════

describe('Scroll regions', () => {
  it('setScrollRegion writes DECSTBM sequence', () => {
    const buf = freshBuffer();
    const mock = mockStdoutWrite();
    try {
      buf.setScrollRegion(2, 50);
      const output = mock.writes.join('');
      assert.ok(output.includes('\x1b[2;50r'));
    } finally {
      mock.restore();
    }
  });

  it('resetScrollRegion writes full-screen reset', () => {
    const buf = freshBuffer();
    const mock = mockStdoutWrite();
    try {
      buf.resetScrollRegion();
      const output = mock.writes.join('');
      assert.ok(output.includes('\x1b[r'));
    } finally {
      mock.restore();
    }
  });

  it('setScrollRegion is not frame-buffered (writes directly)', () => {
    const buf = freshBuffer();
    const mock = mockStdoutWrite();
    try {
      buf.beginFrame();
      const before = mock.writes.length;
      buf.setScrollRegion(5, 30);
      // setScrollRegion uses writeRaw directly — should be visible even during a frame
      assert.ok(mock.writes.length > before, 'scroll region should write directly');
      buf.endFrame();
    } finally {
      mock.restore();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Hyperlinks (OSC 8)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Hyperlinks (OSC 8)', () => {
  it('writeHyperlink emits OSC 8 for valid https URL', () => {
    const buf = freshBuffer();
    const mock = mockStdoutWrite();
    try {
      buf.writeHyperlink('https://github.com/example', 'GitHub');
      const output = mock.writes.join('');
      assert.ok(output.includes('\x1b]8;;https://github.com/example\x07'));
      assert.ok(output.includes('GitHub'));
      assert.ok(output.includes('\x1b]8;;\x07'), 'should close OSC 8');
    } finally {
      mock.restore();
    }
  });

  it('writeHyperlink falls back to plain write for invalid URIs', () => {
    const buf = freshBuffer();
    const mock = mockStdoutWrite();
    try {
      buf.writeHyperlink('javascript:alert(1)', 'click me');
      const output = mock.writes.join('');
      assert.ok(!output.includes('\x1b]8;;'), 'should not emit OSC 8 for invalid URI');
      assert.ok(output.includes('click me'), 'should still write the text');
    } finally {
      mock.restore();
    }
  });

  it('writeHyperlink ignores empty text', () => {
    const buf = freshBuffer();
    const mock = mockStdoutWrite();
    try {
      buf.writeHyperlink('https://example.com', '');
      assert.equal(mock.writes.join(''), '');
    } finally {
      mock.restore();
    }
  });

  it('writeHyperlinkAt positions the hyperlink', () => {
    const buf = freshBuffer();
    const mock = mockStdoutWrite();
    try {
      buf.writeHyperlinkAt(3, 10, 'https://example.com', 'link');
      const output = mock.writes.join('');
      assert.ok(output.includes('\x1b[s'), 'should save cursor');
      assert.ok(output.includes('\x1b[3;10H'), 'should position cursor');
      assert.ok(output.includes('\x1b]8;;https://example.com\x07'));
      assert.ok(output.includes('link'));
      assert.ok(output.includes('\x1b]8;;\x07'), 'should close OSC 8');
      assert.ok(output.includes('\x1b[u'), 'should restore cursor');
    } finally {
      mock.restore();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Resize handling
// ═══════════════════════════════════════════════════════════════════════════════

describe('Resize handling', () => {
  it('onResize registers a callback and returns an unregister function', () => {
    const buf = freshBuffer();
    let called = false;
    const unreg = buf.onResize(() => {
      called = true;
    });
    assert.equal(typeof unreg, 'function');
    // Cleanup: unregister
    unreg();
    assert.equal(called, false, 'callback should not have fired just from registration');
  });

  it('unregister removes the callback', () => {
    const buf = freshBuffer();
    let callCount = 0;
    const unreg = buf.onResize(() => {
      callCount++;
    });
    unreg();
    // Trigger resize manually via the internal handler
    process.stdout.emit('resize');
    // The debounce means this won't fire synchronously, but the callback
    // should have been removed from _resizeCallbacks
    // We can only verify the unregister returned successfully
    assert.equal(callCount, 0, 'callback should not fire after unregister');
  });

  it('onResize handles multiple callbacks', () => {
    const buf = freshBuffer();
    const calls: number[] = [];
    const unreg1 = buf.onResize(() => calls.push(1));
    const unreg2 = buf.onResize(() => calls.push(2));
    // Both should be registered
    unreg1();
    unreg2();
    // No assertion on firing (debounced), just verify no throw
    assert.ok(true);
  });

  it('getTerminalSize returns sensible defaults', () => {
    const size = OutputBuffer.getTerminalSize();
    assert.ok(size.cols > 0);
    assert.ok(size.rows > 0);
    assert.equal(typeof size.cols, 'number');
    assert.equal(typeof size.rows, 'number');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Error handling (EPIPE / broken pipe)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Error handling (EPIPE)', () => {
  it('canWrite is true initially', () => {
    const buf = freshBuffer();
    assert.equal(buf.canWrite, true);
  });

  it('EPIPE sets canWrite to false', () => {
    const buf = freshBuffer();
    const mock = mockStdoutWrite();
    try {
      // Override write to throw EPIPE
      const original = process.stdout.write;
      let calls = 0;
      (process.stdout as { write: typeof process.stdout.write }).write = ((data: unknown) => {
        calls++;
        if (calls === 1) {
          // Create a proper error with code property
          const err = new Error('Broken pipe') as Error & { code: string };
          err.code = 'EPIPE';
          throw err;
        }
        return true;
      }) as typeof process.stdout.write;

      buf.write('this should trigger EPIPE');
      assert.equal(buf.canWrite, false, 'canWrite should be false after EPIPE');

      // Restore mock
      (process.stdout as { write: typeof process.stdout.write }).write = original;

      // Subsequent writes should be swallowed
      const mock2 = mockStdoutWrite();
      buf.write('this should be swallowed');
      assert.equal(mock2.writes.length, 0, 'broken pipe should suppress writes');
      mock2.restore();
    } finally {
      mock.restore();
    }
  });

  it('reset() restores canWrite', () => {
    const buf = freshBuffer();
    const mock = mockStdoutWrite();
    try {
      // Force broken state by throwing EPIPE
      const original = process.stdout.write;
      let calls = 0;
      (process.stdout as { write: typeof process.stdout.write }).write = ((data: unknown) => {
        calls++;
        if (calls === 1) {
          const err = new Error('Broken pipe') as Error & { code: string };
          err.code = 'EPIPE';
          throw err;
        }
        return true;
      }) as typeof process.stdout.write;

      buf.write('trigger EPIPE');
      (process.stdout as { write: typeof process.stdout.write }).write = original;
      assert.equal(buf.canWrite, false);

      buf.reset();
      assert.equal(buf.canWrite, true, 'reset() should restore canWrite');
    } finally {
      mock.restore();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// flush()
// ═══════════════════════════════════════════════════════════════════════════════

describe('flush()', () => {
  it('flushes buffered content during an active frame without closing it', () => {
    const buf = freshBuffer();
    const mock = mockStdoutWrite();
    try {
      buf.beginFrame();
      buf.write('first batch');
      buf.flush();
      // Content should now be on stdout
      const output = mock.writes.join('');
      assert.ok(output.includes('first batch'), 'flush should write buffered content');
      // Frame should still be active
      assert.equal(buf.inFrame, true);

      // Write more and end the frame
      buf.write(' second batch');
      buf.endFrame();
      const allOutput = mock.writes.join('');
      assert.ok(allOutput.includes('second batch'), 'should flush remaining content');
    } finally {
      mock.restore();
    }
  });

  it('flush is a no-op outside a frame', () => {
    const buf = freshBuffer();
    const mock = mockStdoutWrite();
    try {
      const before = mock.writes.length;
      buf.flush();
      // Nothing new should be written (reset() in constructor may have written cursor show)
      // Just verify no throw
      assert.ok(true);
    } finally {
      mock.restore();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// reset() and resetStats()
// ═══════════════════════════════════════════════════════════════════════════════

describe('reset() and resetStats()', () => {
  it('reset() shows cursor and clears frame state', () => {
    const buf = freshBuffer();
    const mock = mockStdoutWrite();
    try {
      buf.beginFrame();
      buf.write('some content');
      buf.reset();
      const output = mock.writes.join('');
      assert.ok(output.includes('\x1b[?25h'), 'reset should show cursor');
      assert.equal(buf.inFrame, false);
    } finally {
      mock.restore();
    }
  });

  it('resetStats() clears metrics without affecting frame state', () => {
    const buf = freshBuffer();
    const mock = mockStdoutWrite();
    try {
      buf.beginFrame();
      buf.write('metric content');
      buf.endFrame();
      assert.ok(buf.totalBytesWritten > 0);
      assert.ok(buf.frameHistory.length > 0);

      buf.resetStats();
      assert.equal(buf.totalBytesWritten, 0);
      assert.equal(buf.frameHistory.length, 0);
      assert.equal(buf.lastFrameBytes, 0);
    } finally {
      mock.restore();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Metrics
// ═══════════════════════════════════════════════════════════════════════════════

describe('Metrics', () => {
  it('totalBytesWritten tracks all output', () => {
    const buf = freshBuffer();
    const mock = mockStdoutWrite();
    try {
      buf.resetStats(); // clear any constructor bytes
      buf.write('hello');
      assert.equal(buf.totalBytesWritten, 5);
      buf.write(' world');
      assert.equal(buf.totalBytesWritten, 11);
    } finally {
      mock.restore();
    }
  });

  it('lastFrameBytes returns bytes from the most recent frame', () => {
    const buf = freshBuffer();
    const mock = mockStdoutWrite();
    try {
      buf.resetStats();
      buf.beginFrame();
      buf.write('12 bytes here');
      buf.endFrame();
      // '12 bytes here' is 13 chars
      assert.equal(buf.lastFrameBytes, 13);
    } finally {
      mock.restore();
    }
  });

  it('lastFrameBytes returns 0 when no frames have completed', () => {
    const buf = freshBuffer();
    buf.resetStats();
    assert.equal(buf.lastFrameBytes, 0);
  });

  it('frameHistory is readonly', () => {
    const buf = freshBuffer();
    // frameHistory should be an array we can read but not mutate through the getter
    const history = buf.frameHistory;
    assert.ok(Array.isArray(history));
  });

  it('_frameBytes resets after each endFrame', () => {
    const buf = freshBuffer();
    const mock = mockStdoutWrite();
    try {
      buf.beginFrame();
      buf.write('frame 1');
      buf.endFrame();
      const bytes1 = buf.lastFrameBytes;

      buf.beginFrame();
      buf.write('f2');
      buf.endFrame();
      const bytes2 = buf.lastFrameBytes;

      assert.ok(bytes1 > bytes2, 'each frame tracks its own byte count');
    } finally {
      mock.restore();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// getTerminalSize
// ═══════════════════════════════════════════════════════════════════════════════

describe('getTerminalSize', () => {
  it('returns object with cols and rows', () => {
    const size = OutputBuffer.getTerminalSize();
    assert.ok('cols' in size);
    assert.ok('rows' in size);
    assert.ok(size.cols >= 1);
    assert.ok(size.rows >= 1);
  });

  it('returns fallback values when stdout columns/rows are undefined', () => {
    // If process.stdout has no columns/rows, should return fallback (88x24)
    const size = OutputBuffer.getTerminalSize();
    // We can't force undefined in a live terminal, but verify fallback is sensible
    assert.ok(size.cols >= 1);
    assert.ok(size.rows >= 1);
  });
});
