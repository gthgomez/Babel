import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseKeypress, createCompositionHandler } from './keyInput.js';

// ─── Helper ──────────────────────────────────────────────────────────────────

function ctrl(byte: number): Buffer {
  return Buffer.from([byte]);
}

// ─── Single-byte keys ────────────────────────────────────────────────────────

describe('parseKeypress — single-byte keys', () => {
  it('parses Tab (0x09)', () => {
    assert.deepEqual(parseKeypress(Buffer.from([0x09])), {
      name: 'tab',
      ctrl: false,
      meta: false,
      shift: false,
      sequence: '\t',
    });
  });

  it('parses Enter via LF (0x0A)', () => {
    assert.deepEqual(parseKeypress(Buffer.from([0x0a])), {
      name: 'enter',
      ctrl: false,
      meta: false,
      shift: false,
      sequence: '\n',
    });
  });

  it('parses Enter via CR (0x0D)', () => {
    assert.deepEqual(parseKeypress(Buffer.from([0x0d])), {
      name: 'enter',
      ctrl: false,
      meta: false,
      shift: false,
      sequence: '\r',
    });
  });

  it('parses Backspace via BS (0x08)', () => {
    assert.deepEqual(parseKeypress(Buffer.from([0x08])), {
      name: 'backspace',
      ctrl: false,
      meta: false,
      shift: false,
      sequence: '\x08',
    });
  });

  it('parses Backspace via DEL (0x7F)', () => {
    assert.deepEqual(parseKeypress(Buffer.from([0x7f])), {
      name: 'backspace',
      ctrl: false,
      meta: false,
      shift: false,
      sequence: '\x7f',
    });
  });

  it('parses Ctrl+A (0x01) — letter a with ctrl flag', () => {
    assert.deepEqual(parseKeypress(ctrl(0x01)), {
      name: 'a',
      ctrl: true,
      meta: false,
      shift: false,
      sequence: '\x01',
    });
  });

  it('parses Ctrl+E (0x05)', () => {
    assert.deepEqual(parseKeypress(ctrl(0x05)), {
      name: 'e',
      ctrl: true,
      meta: false,
      shift: false,
      sequence: '\x05',
    });
  });

  it('parses Ctrl+K (0x0B) — not intercepted by Tab/Enter/Backspace handlers', () => {
    assert.deepEqual(parseKeypress(ctrl(0x0b)), {
      name: 'k',
      ctrl: true,
      meta: false,
      shift: false,
      sequence: '\x0b',
    });
  });

  it('parses Ctrl+L (0x0C) — not intercepted by Tab/Enter/Backspace handlers', () => {
    assert.deepEqual(parseKeypress(ctrl(0x0c)), {
      name: 'l',
      ctrl: true,
      meta: false,
      shift: false,
      sequence: '\x0c',
    });
  });

  it('parses Ctrl+Z (0x1A) — suspend signal', () => {
    assert.deepEqual(parseKeypress(ctrl(0x1a)), {
      name: 'suspend',
      ctrl: true,
      meta: false,
      shift: false,
      sequence: '\x1a',
    });
  });

  it('parses Space (0x20)', () => {
    assert.deepEqual(parseKeypress(Buffer.from([0x20])), {
      name: 'space',
      ctrl: false,
      meta: false,
      shift: false,
      sequence: ' ',
    });
  });

  it('parses lowercase a (0x61) — printable ASCII, no shift', () => {
    assert.deepEqual(parseKeypress(Buffer.from([0x61])), {
      name: 'a',
      ctrl: false,
      meta: false,
      shift: false,
      sequence: 'a',
    });
  });

  it('parses uppercase A (0x41) — shift flag set', () => {
    assert.deepEqual(parseKeypress(Buffer.from([0x41])), {
      name: 'a',
      ctrl: false,
      meta: false,
      shift: true,
      sequence: 'A',
    });
  });

  it('parses uppercase Z (0x5A) — shift flag set', () => {
    assert.deepEqual(parseKeypress(Buffer.from([0x5a])), {
      name: 'z',
      ctrl: false,
      meta: false,
      shift: true,
      sequence: 'Z',
    });
  });

  it('parses digit 0 (0x30) — printable ASCII, no shift for digit', () => {
    assert.deepEqual(parseKeypress(Buffer.from([0x30])), {
      name: '0',
      ctrl: false,
      meta: false,
      shift: false,
      sequence: '0',
    });
  });

  it('parses punctuation ! (0x21)', () => {
    assert.deepEqual(parseKeypress(Buffer.from([0x21])), {
      name: '!',
      ctrl: false,
      meta: false,
      shift: false,
      sequence: '!',
    });
  });

  it('parses punctuation ~ (0x7E) — last printable ASCII byte', () => {
    assert.deepEqual(parseKeypress(Buffer.from([0x7e])), {
      name: '~',
      ctrl: false,
      meta: false,
      shift: false,
      sequence: '~',
    });
  });
});

// ─── CSI sequences ───────────────────────────────────────────────────────────

describe('parseKeypress — CSI sequences', () => {
  it('parses arrow up via \\x1b[A', () => {
    assert.deepEqual(parseKeypress(Buffer.from('\x1b[A')), {
      name: 'up',
      ctrl: false,
      meta: false,
      shift: false,
      sequence: '\x1b[A',
    });
  });

  it('parses arrow down via \\x1b[B', () => {
    assert.deepEqual(parseKeypress(Buffer.from('\x1b[B')), {
      name: 'down',
      ctrl: false,
      meta: false,
      shift: false,
      sequence: '\x1b[B',
    });
  });

  it('parses arrow right via \\x1b[C', () => {
    assert.deepEqual(parseKeypress(Buffer.from('\x1b[C')), {
      name: 'right',
      ctrl: false,
      meta: false,
      shift: false,
      sequence: '\x1b[C',
    });
  });

  it('parses arrow left via \\x1b[D', () => {
    assert.deepEqual(parseKeypress(Buffer.from('\x1b[D')), {
      name: 'left',
      ctrl: false,
      meta: false,
      shift: false,
      sequence: '\x1b[D',
    });
  });

  it('parses Home via \\x1b[H', () => {
    assert.deepEqual(parseKeypress(Buffer.from('\x1b[H')), {
      name: 'home',
      ctrl: false,
      meta: false,
      shift: false,
      sequence: '\x1b[H',
    });
  });

  it('parses End via \\x1b[F', () => {
    assert.deepEqual(parseKeypress(Buffer.from('\x1b[F')), {
      name: 'end',
      ctrl: false,
      meta: false,
      shift: false,
      sequence: '\x1b[F',
    });
  });

  it('parses Insert via \\x1b[2~', () => {
    assert.deepEqual(parseKeypress(Buffer.from('\x1b[2~')), {
      name: 'insert',
      ctrl: false,
      meta: false,
      shift: false,
      sequence: '\x1b[2~',
    });
  });

  it('parses Delete via \\x1b[3~', () => {
    assert.deepEqual(parseKeypress(Buffer.from('\x1b[3~')), {
      name: 'delete',
      ctrl: false,
      meta: false,
      shift: false,
      sequence: '\x1b[3~',
    });
  });

  it('parses PageUp via \\x1b[5~', () => {
    assert.deepEqual(parseKeypress(Buffer.from('\x1b[5~')), {
      name: 'pageup',
      ctrl: false,
      meta: false,
      shift: false,
      sequence: '\x1b[5~',
    });
  });

  it('parses PageDown via \\x1b[6~', () => {
    assert.deepEqual(parseKeypress(Buffer.from('\x1b[6~')), {
      name: 'pagedown',
      ctrl: false,
      meta: false,
      shift: false,
      sequence: '\x1b[6~',
    });
  });

  it('parses F1 via \\x1b[11~', () => {
    assert.deepEqual(parseKeypress(Buffer.from('\x1b[11~')), {
      name: 'f1',
      ctrl: false,
      meta: false,
      shift: false,
      sequence: '\x1b[11~',
    });
  });

  it('parses F2 via \\x1b[12~', () => {
    assert.deepEqual(parseKeypress(Buffer.from('\x1b[12~')), {
      name: 'f2',
      ctrl: false,
      meta: false,
      shift: false,
      sequence: '\x1b[12~',
    });
  });

  it('parses F3 via \\x1b[13~', () => {
    assert.deepEqual(parseKeypress(Buffer.from('\x1b[13~')), {
      name: 'f3',
      ctrl: false,
      meta: false,
      shift: false,
      sequence: '\x1b[13~',
    });
  });

  it('parses F4 via \\x1b[14~', () => {
    assert.deepEqual(parseKeypress(Buffer.from('\x1b[14~')), {
      name: 'f4',
      ctrl: false,
      meta: false,
      shift: false,
      sequence: '\x1b[14~',
    });
  });

  it('parses F5 via \\x1b[15~', () => {
    assert.deepEqual(parseKeypress(Buffer.from('\x1b[15~')), {
      name: 'f5',
      ctrl: false,
      meta: false,
      shift: false,
      sequence: '\x1b[15~',
    });
  });

  it('parses F6 via \\x1b[17~', () => {
    assert.deepEqual(parseKeypress(Buffer.from('\x1b[17~')), {
      name: 'f6',
      ctrl: false,
      meta: false,
      shift: false,
      sequence: '\x1b[17~',
    });
  });

  it('parses F7 via \\x1b[18~', () => {
    assert.deepEqual(parseKeypress(Buffer.from('\x1b[18~')), {
      name: 'f7',
      ctrl: false,
      meta: false,
      shift: false,
      sequence: '\x1b[18~',
    });
  });

  it('parses F8 via \\x1b[19~', () => {
    assert.deepEqual(parseKeypress(Buffer.from('\x1b[19~')), {
      name: 'f8',
      ctrl: false,
      meta: false,
      shift: false,
      sequence: '\x1b[19~',
    });
  });

  it('parses F9 via \\x1b[20~', () => {
    assert.deepEqual(parseKeypress(Buffer.from('\x1b[20~')), {
      name: 'f9',
      ctrl: false,
      meta: false,
      shift: false,
      sequence: '\x1b[20~',
    });
  });

  it('parses F10 via \\x1b[21~', () => {
    assert.deepEqual(parseKeypress(Buffer.from('\x1b[21~')), {
      name: 'f10',
      ctrl: false,
      meta: false,
      shift: false,
      sequence: '\x1b[21~',
    });
  });

  it('parses F11 via \\x1b[23~', () => {
    assert.deepEqual(parseKeypress(Buffer.from('\x1b[23~')), {
      name: 'f11',
      ctrl: false,
      meta: false,
      shift: false,
      sequence: '\x1b[23~',
    });
  });

  it('parses F12 via \\x1b[24~', () => {
    assert.deepEqual(parseKeypress(Buffer.from('\x1b[24~')), {
      name: 'f12',
      ctrl: false,
      meta: false,
      shift: false,
      sequence: '\x1b[24~',
    });
  });
});

// ─── SS3 sequences ───────────────────────────────────────────────────────────

describe('parseKeypress — SS3 sequences (F1–F4)', () => {
  it('parses F1 via \\x1bOP', () => {
    assert.deepEqual(parseKeypress(Buffer.from('\x1bOP')), {
      name: 'f1',
      ctrl: false,
      meta: false,
      shift: false,
      sequence: '\x1bOP',
    });
  });

  it('parses F2 via \\x1bOQ', () => {
    assert.deepEqual(parseKeypress(Buffer.from('\x1bOQ')), {
      name: 'f2',
      ctrl: false,
      meta: false,
      shift: false,
      sequence: '\x1bOQ',
    });
  });

  it('parses F3 via \\x1bOR', () => {
    assert.deepEqual(parseKeypress(Buffer.from('\x1bOR')), {
      name: 'f3',
      ctrl: false,
      meta: false,
      shift: false,
      sequence: '\x1bOR',
    });
  });

  it('parses F4 via \\x1bOS', () => {
    assert.deepEqual(parseKeypress(Buffer.from('\x1bOS')), {
      name: 'f4',
      ctrl: false,
      meta: false,
      shift: false,
      sequence: '\x1bOS',
    });
  });
});

// ─── Alt/Meta combinations ───────────────────────────────────────────────────

describe('parseKeypress — Alt/Meta combinations', () => {
  it('parses Alt+a (\\x1ba) — meta flag, no shift', () => {
    assert.deepEqual(parseKeypress(Buffer.from('\x1ba')), {
      name: 'a',
      ctrl: false,
      meta: true,
      shift: false,
      sequence: '\x1ba',
    });
  });

  it('parses Alt+A (\\x1bA) — meta flag with shift', () => {
    assert.deepEqual(parseKeypress(Buffer.from('\x1bA')), {
      name: 'a',
      ctrl: false,
      meta: true,
      shift: true,
      sequence: '\x1bA',
    });
  });

  it('parses Alt+1 (\\x1b1) — meta flag', () => {
    assert.deepEqual(parseKeypress(Buffer.from('\x1b1')), {
      name: '1',
      ctrl: false,
      meta: true,
      shift: false,
      sequence: '\x1b1',
    });
  });

  it('parses Alt+Space (\\x1b ) — second byte 0x20 treated as Alt+char', () => {
    const event = parseKeypress(Buffer.from([0x1b, 0x20]));
    assert.notEqual(event, null);
    assert.equal(event!.name, ' ');
    assert.equal(event!.meta, true);
    assert.equal(event!.ctrl, false);
    assert.equal(event!.shift, false);
    assert.equal(event!.sequence, '\x1b ');
  });

  it('parses Alt+~ (\\x1b~) — last printable ASCII via meta', () => {
    assert.deepEqual(parseKeypress(Buffer.from('\x1b~')), {
      name: '~',
      ctrl: false,
      meta: true,
      shift: false,
      sequence: '\x1b~',
    });
  });
});

// ─── Edge cases and unrecognized input ───────────────────────────────────────

describe('parseKeypress — edge cases and unrecognized input', () => {
  it('returns null for empty buffer', () => {
    assert.equal(parseKeypress(Buffer.alloc(0)), null);
  });

  it('returns null for NUL byte (0x00)', () => {
    assert.equal(parseKeypress(Buffer.from([0x00])), null);
  });

  it('returns null for 0xFF', () => {
    assert.equal(parseKeypress(Buffer.from([0xff])), null);
  });

  it('returns null for 0x1C (Ctrl+\\) — outside ctrl range 0x01–0x1A', () => {
    assert.equal(parseKeypress(Buffer.from([0x1c])), null);
  });

  it('returns null for 0x1F (Ctrl/_) — outside ctrl range 0x01–0x1A', () => {
    assert.equal(parseKeypress(Buffer.from([0x1f])), null);
  });

  it('returns null for bare Escape (\\x1b) — needs more bytes for disambiguation', () => {
    assert.equal(parseKeypress(Buffer.from([0x1b])), null);
  });

  it('returns null for incomplete CSI (\\x1b[) — missing terminator', () => {
    assert.equal(parseKeypress(Buffer.from([0x1b, 0x5b])), null);
  });

  it('returns null for \\x1b[2 (partial tilde sequence) — missing \\x7E', () => {
    assert.equal(parseKeypress(Buffer.from([0x1b, 0x5b, 0x32])), null);
  });

  it('returns null for \\x1b[1;2 (partial sequence with parameters but no terminator)', () => {
    assert.equal(parseKeypress(Buffer.from([0x1b, 0x5b, 0x31, 0x3b, 0x32])), null);
  });

  it('returns null for partial SS3 (\\x1bO) — missing third byte', () => {
    assert.equal(parseKeypress(Buffer.from([0x1b, 0x4f])), null);
  });

  it('returns null for unrecognized SS3 (\\x1bOX) — third byte not P/Q/R/S', () => {
    assert.equal(parseKeypress(Buffer.from([0x1b, 0x4f, 0x58])), null);
  });

  it('returns null for unrecognized CSI terminator (\\x1b[Z)', () => {
    assert.equal(parseKeypress(Buffer.from([0x1b, 0x5b, 0x5a])), null);
  });

  it('returns null for SGR mouse sequence (\\x1b[<0;10;5M) — parsed as CSI but no key mapping', () => {
    assert.equal(parseKeypress(Buffer.from('\x1b[<0;10;5M')), null);
  });

  it('returns null for SGR mouse release (\\x1b[<0;10;5m) — lowercase m terminator', () => {
    assert.equal(parseKeypress(Buffer.from('\x1b[<0;10;5m')), null);
  });

  it('returns single Escape for double Escape (\\x1b\\x1b) — first escape consumed, second deferred', () => {
    assert.deepEqual(parseKeypress(Buffer.from([0x1b, 0x1b])), {
      name: 'escape',
      ctrl: false,
      meta: false,
      shift: false,
      sequence: '\x1b',
    });
  });

  it('returns null for unrecognized escape continuation (\\x1b\\x00)', () => {
    assert.equal(parseKeypress(Buffer.from([0x1b, 0x00])), null);
  });

  it('returns null for unrecognized escape continuation (\\x1b\\x01)', () => {
    assert.equal(parseKeypress(Buffer.from([0x1b, 0x01])), null);
  });
});

// ─── Multi-byte UTF-8 / IME input ─────────────────────────────────────────────

describe('parseKeypress — multi-byte UTF-8 / IME input', () => {
  it('parses Chinese character 你 (3-byte UTF-8)', () => {
    const buf = Buffer.from('你', 'utf8');
    assert.equal(buf.length, 3);
    assert.deepEqual(parseKeypress(buf), {
      name: '你',
      ctrl: false,
      meta: false,
      shift: false,
      sequence: '你',
    });
  });

  it('parses Chinese character 好 (3-byte UTF-8)', () => {
    const buf = Buffer.from('好', 'utf8');
    assert.equal(buf.length, 3);
    assert.deepEqual(parseKeypress(buf), {
      name: '好',
      ctrl: false,
      meta: false,
      shift: false,
      sequence: '好',
    });
  });

  it('parses Japanese character こ (3-byte UTF-8)', () => {
    const buf = Buffer.from('こ', 'utf8');
    assert.equal(buf.length, 3);
    assert.deepEqual(parseKeypress(buf), {
      name: 'こ',
      ctrl: false,
      meta: false,
      shift: false,
      sequence: 'こ',
    });
  });

  it('parses Korean character 안 (3-byte UTF-8)', () => {
    const buf = Buffer.from('안', 'utf8');
    assert.equal(buf.length, 3);
    assert.deepEqual(parseKeypress(buf), {
      name: '안',
      ctrl: false,
      meta: false,
      shift: false,
      sequence: '안',
    });
  });

  it('parses emoji 😀 (4-byte UTF-8)', () => {
    const buf = Buffer.from('😀', 'utf8');
    assert.equal(buf.length, 4);
    assert.deepEqual(parseKeypress(buf), {
      name: '😀',
      ctrl: false,
      meta: false,
      shift: false,
      sequence: '😀',
    });
  });

  it('parses emoji 🔥 (4-byte UTF-8)', () => {
    const buf = Buffer.from('🔥', 'utf8');
    assert.equal(buf.length, 4);
    assert.deepEqual(parseKeypress(buf), {
      name: '🔥',
      ctrl: false,
      meta: false,
      shift: false,
      sequence: '🔥',
    });
  });

  it('parses accented é (2-byte UTF-8)', () => {
    const buf = Buffer.from('é', 'utf8');
    assert.equal(buf.length, 2);
    assert.deepEqual(parseKeypress(buf), {
      name: 'é',
      ctrl: false,
      meta: false,
      shift: false,
      sequence: 'é',
    });
  });

  it('parses accented ü (2-byte UTF-8)', () => {
    const buf = Buffer.from('ü', 'utf8');
    assert.equal(buf.length, 2);
    assert.deepEqual(parseKeypress(buf), {
      name: 'ü',
      ctrl: false,
      meta: false,
      shift: false,
      sequence: 'ü',
    });
  });

  it('parses first ASCII char when buffer has mixed ASCII and multi-byte (hello 世界)', () => {
    // Buffer contains 'hello 世界'; parseKeypress returns only the first event
    const buf = Buffer.from('hello 世界', 'utf8');
    assert.deepEqual(parseKeypress(buf), {
      name: 'h',
      ctrl: false,
      meta: false,
      shift: false,
      sequence: 'h',
    });
  });

  it('emits first CJK character when buffer has multiple CJK chars (你好)', () => {
    const buf = Buffer.from('你好', 'utf8'); // 6 bytes total (two 3-byte chars)
    assert.deepEqual(parseKeypress(buf), {
      name: '你',
      ctrl: false,
      meta: false,
      shift: false,
      sequence: '你',
    });
  });

  it('emits first emoji when buffer has multiple emoji (😀🔥)', () => {
    const buf = Buffer.from('😀🔥', 'utf8');
    assert.equal(parseKeypress(buf)!.name, '😀');
    assert.equal(parseKeypress(buf)!.sequence, '😀');
  });

  it('returns null for lone continuation byte 0x80 (not a lead byte)', () => {
    assert.equal(parseKeypress(Buffer.from([0x80])), null);
  });

  it('returns null for lone continuation byte 0xBF (not a lead byte)', () => {
    assert.equal(parseKeypress(Buffer.from([0xbf])), null);
  });
});

// ─── Stateless property: parseKeypress does not accumulate buffers ───────────

describe('parseKeypress — stateless buffer handling', () => {
  it('parses first complete sequence when buffer contains extra trailing data', () => {
    // \x1b[A\x1b[B contains two full sequences; only 'up' is returned
    assert.deepEqual(parseKeypress(Buffer.from('\x1b[A\x1b[B')), {
      name: 'up',
      ctrl: false,
      meta: false,
      shift: false,
      sequence: '\x1b[A',
    });
  });

  it('returns null for \\x1b[ (incomplete) then same data returns null again — no state retained', () => {
    const buf = Buffer.from('\x1b[');
    assert.equal(parseKeypress(buf), null);
    // Calling again with identical data still returns null (no accumulation)
    assert.equal(parseKeypress(buf), null);
  });

  it('parses Ctrl+A (0x01) correctly when preceded by an incomplete CSI that is not in the buffer', () => {
    // parseKeypress has no memory of prior calls
    assert.deepEqual(parseKeypress(Buffer.from([0x01])), {
      name: 'a',
      ctrl: true,
      meta: false,
      shift: false,
      sequence: '\x01',
    });
  });
});

// ─── createCompositionHandler — IME composition support ────────────────────────

describe('createCompositionHandler', () => {
  it('calls onCompose with pre-edit text for multi-byte input', () => {
    const composes: string[] = [];
    const commits: string[] = [];
    const handler = createCompositionHandler(
      (t) => {
        composes.push(t);
      },
      (t) => {
        commits.push(t);
      },
    );

    handler.handleData(Buffer.from('你', 'utf8'));

    assert.equal(handler.isComposing(), true);
    assert.deepEqual(composes, ['你']);
    assert.deepEqual(commits, []);
    handler.reset();
  });

  it('calls onCommit with composed text on Enter in manual mode', () => {
    const composes: string[] = [];
    const commits: string[] = [];
    const handler = createCompositionHandler(
      (t) => {
        composes.push(t);
      },
      (t) => {
        commits.push(t);
      },
    );

    handler.toggleCompositionMode(); // Enter manual mode
    handler.handleData(Buffer.from('你', 'utf8'));
    assert.equal(composes.length, 1);
    assert.equal(composes[0], '你');

    handler.handleData(Buffer.from([0x0a])); // Enter commits

    assert.equal(commits.length, 1);
    assert.equal(commits[0], '你');
    assert.equal(handler.isComposing(), false);
  });

  it('reset clears composition state without committing', () => {
    const composes: string[] = [];
    const commits: string[] = [];
    const handler = createCompositionHandler(
      (t) => {
        composes.push(t);
      },
      (t) => {
        commits.push(t);
      },
    );

    handler.handleData(Buffer.from('你', 'utf8'));
    assert.equal(handler.isComposing(), true);

    handler.reset();

    assert.equal(handler.isComposing(), false);
    assert.equal(composes.length, 1); // onCompose was called once
    assert.equal(commits.length, 0); // onCommit was NOT called
  });

  it('isComposing reflects current composition state', () => {
    const handler = createCompositionHandler(
      () => {},
      () => {},
    );

    assert.equal(handler.isComposing(), false);

    handler.toggleCompositionMode();
    handler.handleData(Buffer.from('好', 'utf8'));
    assert.equal(handler.isComposing(), true);

    handler.handleData(Buffer.from([0x0a])); // Enter commits
    assert.equal(handler.isComposing(), false);

    handler.toggleCompositionMode(); // Back to auto mode
  });

  it('existing parseKeypress results have no isComposing field (backward compat)', () => {
    const event = parseKeypress(Buffer.from([0x61])); // 'a'
    assert.equal(event?.isComposing, undefined);
    assert.equal(event?.composeSequence, undefined);
  });

  it('rapid CJK input does not crash', () => {
    const composes: string[] = [];
    const commits: string[] = [];
    const handler = createCompositionHandler(
      (t) => {
        composes.push(t);
      },
      (t) => {
        commits.push(t);
      },
    );

    // Feed multiple CJK characters synchronously (simulates rapid typing)
    const inputs = ['你', '好', '世', '界'];
    for (const char of inputs) {
      handler.handleData(Buffer.from(char, 'utf8'));
    }

    assert.equal(handler.isComposing(), true);
    assert.equal(composes.length, 4);
    assert.equal(composes[composes.length - 1], '你好世界');

    handler.reset();
  });

  it('empty composition does not call onCommit', () => {
    const composes: string[] = [];
    const commits: string[] = [];
    const handler = createCompositionHandler(
      (t) => {
        composes.push(t);
      },
      (t) => {
        commits.push(t);
      },
    );

    handler.toggleCompositionMode();
    // Enter without any text
    handler.handleData(Buffer.from([0x0a]));

    assert.equal(composes.length, 0);
    assert.equal(commits.length, 0);
    assert.equal(handler.isComposing(), false);
  });

  it('Escape cancels composition without committing', () => {
    const composes: string[] = [];
    const commits: string[] = [];
    const handler = createCompositionHandler(
      (t) => {
        composes.push(t);
      },
      (t) => {
        commits.push(t);
      },
    );

    handler.toggleCompositionMode();
    handler.handleData(Buffer.from('你', 'utf8'));
    assert.equal(handler.isComposing(), true);

    handler.handleData(Buffer.from([0x1b])); // Escape cancels

    assert.equal(handler.isComposing(), false);
    assert.equal(commits.length, 0); // Not committed
    assert.equal(composes.length, 1); // Was composed briefly before cancel
  });
});
