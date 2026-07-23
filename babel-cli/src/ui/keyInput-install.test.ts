import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { installKeyHandler, type KeyEvent } from './keyInput.js';

// ─── Mock ReadStream factory ─────────────────────────────────────────────────

function createMockStream() {
  const listeners = new Map<string, Set<(...args: any[]) => void>>();
  let raw = false;
  let paused = false;
  return {
    isTTY: true,
    get isRaw() {
      return raw;
    },
    isPaused: () => paused,
    setRawMode: (mode: boolean) => {
      raw = mode;
      return {} as any;
    },
    resume: () => {
      paused = false;
    },
    pause: () => {
      paused = true;
    },
    on: (event: string, listener: (...args: any[]) => void) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(listener);
      return {} as any;
    },
    off: (event: string, listener: (...args: any[]) => void) => {
      listeners.get(event)?.delete(listener);
      return {} as any;
    },
    removeListener: (event: string, listener: (...args: any[]) => void) => {
      listeners.get(event)?.delete(listener);
      return {} as any;
    },
    emit: (event: string, ...args: any[]) => {
      listeners.get(event)?.forEach((l) => l(...args));
    },
  } as unknown as NodeJS.ReadStream;
}

/** Emit a 'data' event on the mock stream with the given bytes. */
function sendBytes(stream: NodeJS.ReadStream, bytes: Uint8Array | string): void {
  const buf = typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : Buffer.from(bytes);
  (stream as any).emit('data', buf);
}

// ─── Test lifecycle ──────────────────────────────────────────────────────────

test.beforeEach(() => {
  mock.timers.enable({ apis: ['setTimeout'] });
});

test.afterEach(() => {
  mock.timers.reset();
});

// ─── Tests ───────────────────────────────────────────────────────────────────

test('single byte -> callback invoked with correct KeyEvent', () => {
  const stream = createMockStream();
  const events: KeyEvent[] = [];

  const cleanup = installKeyHandler(stream, (ev) => {
    events.push(ev);
  });

  sendBytes(stream, Buffer.from([0x61])); // 'a'

  assert.equal(events.length, 1);
  assert.equal(events[0]!.name, 'a');
  assert.equal(events[0]!.ctrl, false);
  assert.equal(events[0]!.meta, false);
  assert.equal(events[0]!.shift, false);
  assert.equal(events[0]!.sequence, 'a');

  cleanup();
});

test('multi-byte CSI sequence -> one callback, not multiple', () => {
  const stream = createMockStream();
  const events: KeyEvent[] = [];

  const cleanup = installKeyHandler(stream, (ev) => {
    events.push(ev);
  });

  sendBytes(stream, Buffer.from('\x1b[A')); // Up arrow

  assert.equal(events.length, 1);
  assert.equal(events[0]!.name, 'up');
  assert.equal(events[0]!.sequence, '\x1b[A');

  cleanup();
});

test('bare ESC -> callback after 50ms timeout', () => {
  const stream = createMockStream();
  const events: KeyEvent[] = [];

  const cleanup = installKeyHandler(stream, (ev) => {
    events.push(ev);
  });

  sendBytes(stream, Buffer.from([0x1b])); // bare ESC

  // No callback yet -- waiting for disambiguation
  assert.equal(events.length, 0);

  // Advance 50ms past the bare-escape timeout
  mock.timers.tick(51);

  assert.equal(events.length, 1);
  assert.equal(events[0]!.name, 'escape');
  assert.equal(events[0]!.sequence, '\x1b');

  cleanup();
});

test('ESC + more bytes within 50ms -> treated as sequence, not bare escape', () => {
  const stream = createMockStream();
  const events: KeyEvent[] = [];

  const cleanup = installKeyHandler(stream, (ev) => {
    events.push(ev);
  });

  // Send bare ESC first
  sendBytes(stream, Buffer.from([0x1b]));
  assert.equal(events.length, 0);

  // Send the rest of the CSI sequence within the 50ms window
  sendBytes(stream, Buffer.from('[C')); // completes \x1b[C = right arrow

  // The escape timeout should have been cleared and the sequence parsed
  assert.equal(events.length, 1);
  assert.equal(events[0]!.name, 'right');
  assert.equal(events[0]!.sequence, '\x1b[C');

  cleanup();
});

test('bracketed paste -> single paste event', () => {
  const stream = createMockStream();
  const events: KeyEvent[] = [];

  const cleanup = installKeyHandler(stream, (ev) => {
    events.push(ev);
  });

  // Bracketed paste start \x1b[200~
  sendBytes(stream, Buffer.from('\x1b[200~'));
  assert.equal(events.length, 0); // Not emitted yet

  // Paste content
  sendBytes(stream, Buffer.from('hello world'));

  // Bracketed paste end \x1b[201~
  sendBytes(stream, Buffer.from('\x1b[201~'));

  assert.equal(events.length, 1);
  assert.equal(events[0]!.name, 'paste');
  assert.equal(events[0]!.ctrl, false);
  assert.equal(events[0]!.meta, false);
  assert.equal(events[0]!.shift, false);
  assert.equal(events[0]!.sequence, 'hello world');

  cleanup();
});

test('SGR mouse sequences consumed silently, no callback', () => {
  const stream = createMockStream();
  const events: KeyEvent[] = [];

  const cleanup = installKeyHandler(stream, (ev) => {
    events.push(ev);
  });

  // SGR mouse press: \x1b[<0;10;5M
  sendBytes(stream, Buffer.from('\x1b[<0;10;5M'));
  // SGR mouse release: \x1b[<0;10;5m
  sendBytes(stream, Buffer.from('\x1b[<0;10;5m'));

  // After both, no key event should have been emitted
  assert.equal(events.length, 0);

  // But the handler should still work for real keys
  sendBytes(stream, Buffer.from([0x61])); // 'a'
  assert.equal(events.length, 1);
  assert.equal(events[0]!.name, 'a');

  cleanup();
});

test('cleanup restores raw mode, removes data listener, resets timeout', () => {
  const stream = createMockStream();
  const events: KeyEvent[] = [];

  const cleanup = installKeyHandler(stream, (ev) => {
    events.push(ev);
  });

  // Verify raw mode was set
  assert.equal((stream as any).isRaw, true);

  // Send a bare escape to create a pending timeout
  sendBytes(stream, Buffer.from([0x1b]));
  assert.equal(events.length, 0);

  // Cleanup
  cleanup();

  // Raw mode should be restored to its original value (false)
  assert.equal((stream as any).isRaw, false);

  // After cleanup, data events should be ignored
  sendBytes(stream, Buffer.from([0x61]));
  assert.equal(events.length, 0);

  // The pending escape timeout should have been cancelled, so no event after time passes
  mock.timers.tick(100);
  assert.equal(events.length, 0);
});

test('multiple cleanup calls are idempotent, no crash', () => {
  const stream = createMockStream();
  const events: KeyEvent[] = [];

  const cleanup = installKeyHandler(stream, (ev) => {
    events.push(ev);
  });

  // Call cleanup multiple times
  cleanup();
  cleanup();
  cleanup();

  // After multiple cleanups, data events should still be ignored
  sendBytes(stream, Buffer.from([0x61]));
  assert.equal(events.length, 0);

  // And no crash or throw
  assert.ok(true);
});

test('callback that throws -> error swallowed, handler still functional', () => {
  const stream = createMockStream();
  const events: KeyEvent[] = [];

  const cleanup = installKeyHandler(stream, (ev) => {
    if (ev.name === 'a') throw new Error('test error');
    events.push(ev);
  });

  // This one throws internally but should be swallowed
  sendBytes(stream, Buffer.from([0x61]));

  // Handler should still be alive for subsequent events
  sendBytes(stream, Buffer.from([0x62])); // 'b'

  assert.equal(events.length, 1);
  assert.equal(events[0]!.name, 'b');

  cleanup();
});

test('data events after cleanup -> early return, no callback', () => {
  const stream = createMockStream();
  const events: KeyEvent[] = [];

  const cleanup = installKeyHandler(stream, (ev) => {
    events.push(ev);
  });
  cleanup();

  // Multiple data events after cleanup
  sendBytes(stream, Buffer.from([0x61]));
  sendBytes(stream, Buffer.from('\x1b[A'));
  sendBytes(stream, Buffer.from('\x1b[200~hello\x1b[201~'));

  assert.equal(events.length, 0);
});

// ─── Edge: partial SGR mouse (incomplete) -> not consumed, no crash ──────────

test('partial SGR mouse sequence -> not consumed, no crash', () => {
  const stream = createMockStream();
  const events: KeyEvent[] = [];

  const cleanup = installKeyHandler(stream, (ev) => {
    events.push(ev);
  });

  // Only the prefix of an SGR mouse sequence (missing terminator)
  sendBytes(stream, Buffer.from('\x1b[<0;10;'));

  // No events should fire
  assert.equal(events.length, 0);

  // Now send a regular key to verify the handler still works
  sendBytes(stream, Buffer.from([0x61]));
  assert.equal(events.length, 1);
  assert.equal(events[0]!.name, 'a');

  cleanup();
});

// ─── Burst detection (fallback for terminals without DECSET 2004) ──────────

test('burst detection: 5+ consecutive printable chars in one chunk -> single paste event', () => {
  const stream = createMockStream();
  const events: KeyEvent[] = [];

  const cleanup = installKeyHandler(stream, (ev) => {
    events.push(ev);
  });

  sendBytes(stream, 'hello');

  assert.equal(events.length, 1);
  assert.equal(events[0]!.name, 'paste');
  assert.equal(events[0]!.ctrl, false);
  assert.equal(events[0]!.meta, false);
  assert.equal(events[0]!.shift, false);
  assert.equal(events[0]!.sequence, 'hello');

  cleanup();
});

test('burst detection: single char -> individual event (below threshold)', () => {
  const stream = createMockStream();
  const events: KeyEvent[] = [];

  const cleanup = installKeyHandler(stream, (ev) => {
    events.push(ev);
  });

  sendBytes(stream, 'h');

  assert.equal(events.length, 1);
  assert.equal(events[0]!.name, 'h');
  assert.equal(events[0]!.ctrl, false);
  assert.equal(events[0]!.meta, false);
  assert.equal(events[0]!.shift, false);
  assert.equal(events[0]!.sequence, 'h');

  cleanup();
});

test('burst detection: 3 chars below threshold -> individual events', () => {
  const stream = createMockStream();
  const events: KeyEvent[] = [];

  const cleanup = installKeyHandler(stream, (ev) => {
    events.push(ev);
  });

  sendBytes(stream, 'hel');

  assert.equal(events.length, 3);
  assert.equal(events[0]!.name, 'h');
  assert.equal(events[0]!.sequence, 'h');
  assert.equal(events[1]!.name, 'e');
  assert.equal(events[1]!.sequence, 'e');
  assert.equal(events[2]!.name, 'l');
  assert.equal(events[2]!.sequence, 'l');

  cleanup();
});

test('burst detection: newline (0x0A) breaks burst accumulation', () => {
  const stream = createMockStream();
  const events: KeyEvent[] = [];

  const cleanup = installKeyHandler(stream, (ev) => {
    events.push(ev);
  });

  // 3 chars (below threshold) + newline + 3 chars (below threshold)
  // Each group stays below threshold -> individual events
  sendBytes(stream, 'abc\nxyz');

  assert.equal(events.length, 7);
  assert.equal(events[0]!.name, 'a');
  assert.equal(events[1]!.name, 'b');
  assert.equal(events[2]!.name, 'c');
  assert.equal(events[3]!.name, 'enter');
  assert.equal(events[4]!.name, 'x');
  assert.equal(events[5]!.name, 'y');
  assert.equal(events[6]!.name, 'z');

  cleanup();
});

test('burst detection: pauses between chunks -> per-chunk detection', () => {
  const stream = createMockStream();
  const events: KeyEvent[] = [];

  const cleanup = installKeyHandler(stream, (ev) => {
    events.push(ev);
  });

  // "he" in first chunk: 2 chars, below threshold -> individual
  sendBytes(stream, 'he');
  assert.equal(events.length, 2);
  assert.equal(events[0]!.name, 'h');
  assert.equal(events[1]!.name, 'e');

  // "llo" in second chunk: 3 chars, below threshold -> individual
  sendBytes(stream, 'llo');
  assert.equal(events.length, 5);
  assert.equal(events[2]!.name, 'l');
  assert.equal(events[3]!.name, 'l');
  assert.equal(events[4]!.name, 'o');

  cleanup();
});

test('burst detection: interleaved with CSI sequences -> correct event types', () => {
  const stream = createMockStream();
  const events: KeyEvent[] = [];

  const cleanup = installKeyHandler(stream, (ev) => {
    events.push(ev);
  });

  // "hello" (5 chars -> paste) then up arrow then "world" (5 chars -> paste)
  sendBytes(stream, 'hello\x1b[Aworld');

  assert.equal(events.length, 3);
  assert.equal(events[0]!.name, 'paste');
  assert.equal(events[0]!.sequence, 'hello');
  assert.equal(events[1]!.name, 'up');
  assert.equal(events[2]!.name, 'paste');
  assert.equal(events[2]!.sequence, 'world');

  cleanup();
});

test('burst detection: does not conflict with bracketed paste', () => {
  const stream = createMockStream();
  const events: KeyEvent[] = [];

  const cleanup = installKeyHandler(stream, (ev) => {
    events.push(ev);
  });

  // Bracketed paste with content below burst threshold
  sendBytes(stream, '\x1b[200~hi\x1b[201~');

  assert.equal(events.length, 1);
  assert.equal(events[0]!.name, 'paste');
  assert.equal(events[0]!.sequence, 'hi');

  cleanup();
});

test('burst detection: space and punctuation included in burst', () => {
  const stream = createMockStream();
  const events: KeyEvent[] = [];

  const cleanup = installKeyHandler(stream, (ev) => {
    events.push(ev);
  });

  // 5+ chars including spaces and punctuation
  sendBytes(stream, 'a b,c!');

  assert.equal(events.length, 1);
  assert.equal(events[0]!.name, 'paste');
  assert.equal(events[0]!.sequence, 'a b,c!');

  cleanup();
});

test('burst detection: non-printable byte stops accumulation', () => {
  const stream = createMockStream();
  const events: KeyEvent[] = [];

  const cleanup = installKeyHandler(stream, (ev) => {
    events.push(ev);
  });

  // 5 chars then backspace (0x08) then 3 chars (below threshold)
  // The backspace breaks the burst, so "hello" (5) is paste, then 0x08 is backspace
  // "abc" (3) is below threshold so emitted individually
  sendBytes(stream, 'hello\x08abc');

  assert.equal(events.length, 5); // paste(hello) + backspace + a + b + c
  assert.equal(events[0]!.name, 'paste');
  assert.equal(events[0]!.sequence, 'hello');
  assert.equal(events[1]!.name, 'backspace');
  assert.equal(events[2]!.name, 'a');
  assert.equal(events[3]!.name, 'b');
  assert.equal(events[4]!.name, 'c');

  cleanup();
});
