/**
 * mouseInput.test.ts — SGR mouse event parser and handler tests.
 *
 * Covers parseSgrMouse, isMouseSequence, and installMouseHandler for
 * XTerm-style SGR mouse scroll events.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseSgrMouse, isMouseSequence, installMouseHandler } from './mouseInput.js';

// ═══════════════════════════════════════════════════════════════════════════════
// parseSgrMouse — scroll parsing
// ═══════════════════════════════════════════════════════════════════════════════

describe('parseSgrMouse — scroll parsing', () => {
  it('parses scroll_up (\\x1b[<64;Y;XM) — release with btn=64', () => {
    const result = parseSgrMouse('\x1b[<64;10;5M');
    assert.notEqual(result, null);
    assert.equal(result!.type, 'scroll_up');
  });

  it('parses scroll_down (\\x1b[<65;Y;XM) — release with btn=65', () => {
    const result = parseSgrMouse('\x1b[<65;10;5M');
    assert.notEqual(result, null);
    assert.equal(result!.type, 'scroll_down');
  });

  it('parses scroll_up at bottom-right corner (large X,Y)', () => {
    const result = parseSgrMouse('\x1b[<64;9999;9999M');
    assert.notEqual(result, null);
    assert.equal(result!.type, 'scroll_up');
  });

  it('parses scroll_down at top-left corner (small X,Y)', () => {
    const result = parseSgrMouse('\x1b[<65;1;1M');
    assert.notEqual(result, null);
    assert.equal(result!.type, 'scroll_down');
  });

  it('returns other for scroll press (btn=64 with m terminator)', () => {
    // Some terminals encode scroll as press; we handle on release only
    const result = parseSgrMouse('\x1b[<64;10;5m');
    assert.notEqual(result, null);
    assert.equal(result!.type, 'other');
  });

  it('returns other for scroll_down press (btn=65 with m terminator)', () => {
    const result = parseSgrMouse('\x1b[<65;10;5m');
    assert.notEqual(result, null);
    assert.equal(result!.type, 'other');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// parseSgrMouse — non-scroll mouse events
// ═══════════════════════════════════════════════════════════════════════════════

describe('parseSgrMouse — non-scroll events', () => {
  it('returns other for button 0 press (\\x1b[<0;Y;Xm)', () => {
    const result = parseSgrMouse('\x1b[<0;10;5m');
    assert.notEqual(result, null);
    assert.equal(result!.type, 'other');
  });

  it('returns other for button 0 release (\\x1b[<0;Y;XM)', () => {
    const result = parseSgrMouse('\x1b[<0;10;5M');
    assert.notEqual(result, null);
    assert.equal(result!.type, 'other');
  });

  it('returns other for button 1 press', () => {
    assert.equal(parseSgrMouse('\x1b[<1;10;5m')!.type, 'other');
  });

  it('returns other for button 2 press', () => {
    assert.equal(parseSgrMouse('\x1b[<2;10;5m')!.type, 'other');
  });

  it('returns other for button 0-2 release (ignored buttons)', () => {
    // Button 0..2 release events are explicitly ignored
    assert.equal(parseSgrMouse('\x1b[<0;10;5M')!.type, 'other');
    assert.equal(parseSgrMouse('\x1b[<1;10;5M')!.type, 'other');
    assert.equal(parseSgrMouse('\x1b[<2;10;5M')!.type, 'other');
  });

  it('returns other for motion event with button 32', () => {
    const result = parseSgrMouse('\x1b[<32;10;5M');
    assert.notEqual(result, null);
    assert.equal(result!.type, 'other');
  });

  it('returns other for high button numbers (beyond scroll)', () => {
    const result = parseSgrMouse('\x1b[<128;10;5M');
    assert.notEqual(result, null);
    assert.equal(result!.type, 'other');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// parseSgrMouse — null returns (non-mouse data)
// ═══════════════════════════════════════════════════════════════════════════════

describe('parseSgrMouse — null returns', () => {
  it('returns null for non-CSI prefix (plain text)', () => {
    assert.equal(parseSgrMouse('hello'), null);
  });

  it('returns null for empty buffer', () => {
    assert.equal(parseSgrMouse(Buffer.alloc(0)), null);
  });

  it('returns null for empty string', () => {
    assert.equal(parseSgrMouse(''), null);
  });

  it('returns null for regular CSI sequences (not SGR mouse)', () => {
    // Arrow keys, etc.
    assert.equal(parseSgrMouse('\x1b[A'), null);
    assert.equal(parseSgrMouse('\x1b[1;2H'), null);
    assert.equal(parseSgrMouse('\x1b[3~'), null);
  });

  it('returns null for incomplete SGR mouse prefix (missing terminator)', () => {
    assert.equal(parseSgrMouse('\x1b[<0;10;'), null);
  });

  it('returns null for malformed SGR mouse (non-numeric btn)', () => {
    assert.equal(parseSgrMouse('\x1b[<abc;10;5M'), null);
    // The regex won't match because \d+ expects digits
  });

  it('returns null for SGR mouse with wrong terminator (uppercase M but no match)', () => {
    // Already tested via valid sequence. Test a truly non-matching variant.
    assert.equal(parseSgrMouse('\x1b[<0;10;5'), null); // missing m/M
  });

  it('returns null for non-CSI ESC sequence', () => {
    // ESC O P (SS3)
    assert.equal(parseSgrMouse('\x1bOP'), null);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// parseSgrMouse — Buffer input
// ═══════════════════════════════════════════════════════════════════════════════

describe('parseSgrMouse — Buffer input', () => {
  it('parses scroll_up from Buffer input', () => {
    const buf = Buffer.from('\x1b[<64;10;5M');
    const result = parseSgrMouse(buf);
    assert.notEqual(result, null);
    assert.equal(result!.type, 'scroll_up');
  });

  it('parses scroll_down from Buffer input', () => {
    const buf = Buffer.from('\x1b[<65;10;5M');
    const result = parseSgrMouse(buf);
    assert.notEqual(result, null);
    assert.equal(result!.type, 'scroll_down');
  });

  it('returns null for Buffer with non-mouse data', () => {
    const buf = Buffer.from('hello');
    assert.equal(parseSgrMouse(buf), null);
  });

  it('returns null for empty Buffer', () => {
    assert.equal(parseSgrMouse(Buffer.alloc(0)), null);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// isMouseSequence
// ═══════════════════════════════════════════════════════════════════════════════

describe('isMouseSequence', () => {
  it('returns true for SGR mouse prefix (string)', () => {
    assert.equal(isMouseSequence('\x1b[<0;10;5M'), true);
    assert.equal(isMouseSequence('\x1b[<64;10;5M'), true);
    assert.equal(isMouseSequence('\x1b[<65;10;5m'), true);
  });

  it('returns true for SGR mouse prefix (Buffer)', () => {
    assert.equal(isMouseSequence(Buffer.from('\x1b[<0;10;5M')), true);
  });

  it('returns false for plain text', () => {
    assert.equal(isMouseSequence('hello'), false);
  });

  it('returns false for regular CSI sequences', () => {
    assert.equal(isMouseSequence('\x1b[A'), false);
    assert.equal(isMouseSequence('\x1b[1;2H'), false);
  });

  it('returns false for empty string', () => {
    assert.equal(isMouseSequence(''), false);
  });

  it('returns false for empty Buffer', () => {
    assert.equal(isMouseSequence(Buffer.alloc(0)), false);
  });

  it('returns false for non-SGR escape sequences', () => {
    assert.equal(isMouseSequence('\x1bOP'), false);
    assert.equal(isMouseSequence('\x1b]0;title\x07'), false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// installMouseHandler
// ═══════════════════════════════════════════════════════════════════════════════

describe('installMouseHandler', () => {
  // ── Mock stream factory ──────────────────────────────────────────────────

  function createMockStream() {
    const listeners = new Map<string, Set<(...args: any[]) => void>>();
    return {
      on: (event: string, listener: (...args: any[]) => void) => {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event)!.add(listener);
      },
      off: (event: string, listener: (...args: any[]) => void) => {
        listeners.get(event)?.delete(listener);
      },
      removeListener: (event: string, listener: (...args: any[]) => void) => {
        listeners.get(event)?.delete(listener);
      },
      emit: (event: string, ...args: any[]) => {
        listeners.get(event)?.forEach((l) => l(...args));
      },
      listeners: (event: string) => {
        return Array.from(listeners.get(event) ?? []);
      },
    } as unknown as NodeJS.ReadStream;
  }

  function sendData(stream: NodeJS.ReadStream, data: Buffer | string): void {
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
    (stream as any).emit('data', buf);
  }

  // ── Tests ────────────────────────────────────────────────────────────────

  it('calls onScrollUp for scroll_up SGR sequence', () => {
    const stream = createMockStream();
    let up = 0;
    let down = 0;

    const cleanup = installMouseHandler(stream, {
      onScrollUp: () => up++,
      onScrollDown: () => down++,
    });

    sendData(stream, '\x1b[<64;10;5M'); // scroll up
    assert.equal(up, 1);
    assert.equal(down, 0);

    cleanup();
  });

  it('calls onScrollDown for scroll_down SGR sequence', () => {
    const stream = createMockStream();
    let up = 0;
    let down = 0;

    const cleanup = installMouseHandler(stream, {
      onScrollUp: () => up++,
      onScrollDown: () => down++,
    });

    sendData(stream, '\x1b[<65;10;5M'); // scroll down
    assert.equal(up, 0);
    assert.equal(down, 1);

    cleanup();
  });

  it('ignores non-scroll SGR mouse sequences', () => {
    const stream = createMockStream();
    let up = 0;
    let down = 0;

    const cleanup = installMouseHandler(stream, {
      onScrollUp: () => up++,
      onScrollDown: () => down++,
    });

    sendData(stream, '\x1b[<0;10;5M'); // button 0 release
    sendData(stream, '\x1b[<1;10;5m'); // button 1 press
    sendData(stream, '\x1b[<32;10;5M'); // motion
    assert.equal(up, 0);
    assert.equal(down, 0);

    cleanup();
  });

  it('passes through non-mouse data (no callback, no crash)', () => {
    const stream = createMockStream();
    let up = 0;
    let down = 0;

    const cleanup = installMouseHandler(stream, {
      onScrollUp: () => up++,
      onScrollDown: () => down++,
    });

    // Non-mouse data should be silently ignored
    sendData(stream, 'hello');
    sendData(stream, '\x1b[A');
    sendData(stream, '\x1b[3~');
    assert.equal(up, 0);
    assert.equal(down, 0);

    cleanup();
  });

  it('returns a cleanup function that removes the data listener', () => {
    const stream = createMockStream();
    let up = 0;
    let down = 0;

    const cleanup = installMouseHandler(stream, {
      onScrollUp: () => up++,
      onScrollDown: () => down++,
    });

    cleanup();

    // After cleanup, mouse events should be ignored
    sendData(stream, '\x1b[<64;10;5M');
    assert.equal(up, 0);
    assert.equal(down, 0);
  });

  it('cleanup is idempotent (calling multiple times is safe)', () => {
    const stream = createMockStream();
    let up = 0;
    let down = 0;

    const cleanup = installMouseHandler(stream, {
      onScrollUp: () => up++,
      onScrollDown: () => down++,
    });

    cleanup();
    cleanup();
    cleanup();

    sendData(stream, '\x1b[<64;10;5M');
    assert.equal(up, 0);
    assert.equal(down, 0);
  });

  it('handles scroll_up from Buffer input', () => {
    const stream = createMockStream();
    let up = 0;
    let down = 0;

    const cleanup = installMouseHandler(stream, {
      onScrollUp: () => up++,
      onScrollDown: () => down++,
    });

    sendData(stream, Buffer.from('\x1b[<64;10;5M'));
    assert.equal(up, 1);

    cleanup();
  });

  it('handles scroll_down from Buffer input', () => {
    const stream = createMockStream();
    let up = 0;
    let down = 0;

    const cleanup = installMouseHandler(stream, {
      onScrollUp: () => up++,
      onScrollDown: () => down++,
    });

    sendData(stream, Buffer.from('\x1b[<65;10;5M'));
    assert.equal(down, 1);

    cleanup();
  });

  it('handles multiple scroll events in sequence', () => {
    const stream = createMockStream();
    let up = 0;
    let down = 0;

    const cleanup = installMouseHandler(stream, {
      onScrollUp: () => up++,
      onScrollDown: () => down++,
    });

    sendData(stream, '\x1b[<64;10;5M'); // up
    sendData(stream, '\x1b[<64;10;5M'); // up
    sendData(stream, '\x1b[<65;10;5M'); // down
    sendData(stream, '\x1b[<64;10;5M'); // up
    sendData(stream, '\x1b[<65;10;5M'); // down

    assert.equal(up, 3);
    assert.equal(down, 2);

    cleanup();
  });

  it('does not crash on short data (< 6 bytes)', () => {
    const stream = createMockStream();
    let up = 0;
    let down = 0;

    const cleanup = installMouseHandler(stream, {
      onScrollUp: () => up++,
      onScrollDown: () => down++,
    });

    // The handler has a fast-path: `data.length < 6` returns early
    sendData(stream, Buffer.from([0x1b, 0x5b, 0x3c, 0x30])); // \x1b[<0 (5 bytes)
    sendData(stream, Buffer.from([0x1b])); // 1 byte
    sendData(stream, Buffer.from([])); // 0 bytes

    assert.equal(up, 0);
    assert.equal(down, 0);

    cleanup();
  });

  it('does not crash on data starting with 0x1B but not mouse', () => {
    const stream = createMockStream();
    let up = 0;
    let down = 0;

    const cleanup = installMouseHandler(stream, {
      onScrollUp: () => up++,
      onScrollDown: () => down++,
    });

    // Data starts with 0x1B but is an arrow key, not mouse
    sendData(stream, Buffer.from([0x1b, 0x5b, 0x41])); // \x1b[A (up arrow)

    assert.equal(up, 0);
    assert.equal(down, 0);

    cleanup();
  });

  it('does not call callbacks after cleanup', () => {
    const stream = createMockStream();
    let up = 0;
    let down = 0;

    const cleanup = installMouseHandler(stream, {
      onScrollUp: () => up++,
      onScrollDown: () => down++,
    });

    cleanup();

    sendData(stream, '\x1b[<64;10;5M');
    sendData(stream, '\x1b[<65;10;5M');

    assert.equal(up, 0);
    assert.equal(down, 0);
  });
});
