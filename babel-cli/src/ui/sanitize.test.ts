/**
 * sanitize.test.ts — Terminal escape sequence sanitization tests.
 *
 * All LLM output passes through these functions before reaching stdout.
 * This test suite verifies that terminal control sequences are stripped
 * while OSC 8 hyperlinks are preserved.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { stripControlSequences, sanitizeLlmOutput, sanitizeCodeLine } from './sanitize.js';

// ═══════════════════════════════════════════════════════════════════════════════
// stripControlSequences
// ═══════════════════════════════════════════════════════════════════════════════

describe('stripControlSequences', () => {
  // ── CSI sequences ─────────────────────────────────────────────────────────

  it('strips simple SGR CSI: \\x1b[31m', () => {
    assert.equal(stripControlSequences('\x1b[31mred'), 'red');
  });

  it('strips reset SGR: \\x1b[0m', () => {
    assert.equal(stripControlSequences('\x1b[0mnormal'), 'normal');
  });

  it('strips multi-parameter SGR: \\x1b[1;31m', () => {
    assert.equal(stripControlSequences('\x1b[1;31mbold red'), 'bold red');
  });

  it('strips CSI sequences with parameter bytes (0x30-0x3F)', () => {
    assert.equal(stripControlSequences('\x1b[?25h'), '');
    assert.equal(stripControlSequences('\x1b[?1006l'), '');
    assert.equal(stripControlSequences('\x1b[2J'), '');
  });

  it('strips CSI sequences with intermediate bytes (0x20-0x2F)', () => {
    // CSI with space intermediate byte, e.g. \x1b[1 space 0 q (modify char attributes)
    assert.equal(stripControlSequences('\x1b[1 q'), '');
  });

  it('strips malformed but partially valid CSI', () => {
    // CSI with only parameter bytes and terminator
    assert.equal(stripControlSequences('\x1b[;m'), '');
  });

  // ── OSC sequences ─────────────────────────────────────────────────────────

  it('strips OSC 0 (set title) terminated with BEL', () => {
    assert.equal(stripControlSequences('\x1b]0;My Terminal Title\x07'), '');
  });

  it('strips OSC 2 (set title) terminated with ST', () => {
    assert.equal(stripControlSequences('\x1b]2;My Title\x1b\\'), '');
  });

  it('strips OSC 7 (working directory) with BEL terminator', () => {
    assert.equal(stripControlSequences('\x1b]7;file://host/path\x07'), '');
  });

  it('strips OSC 10 (foreground color) with ST terminator', () => {
    assert.equal(stripControlSequences('\x1b]10;rgb:0000/0000/0000\x1b\\'), '');
  });

  it('strips OSC containing semicolons in data', () => {
    assert.equal(stripControlSequences('\x1b]4;0;rgb:ffff/ffff/ffff\x07'), '');
  });

  // ── OSC 8 hyperlinks PRESERVED ────────────────────────────────────────────

  it('preserves OSC 8 hyperlinks (critical!)', () => {
    const input = '\x1b]8;;https://example.com\x1b\\link text\x1b]8;;\x1b\\';
    // Opener preserved, closer stripped
    const expected = '\x1b]8;;https://example.com\x1b\\link text';
    assert.equal(stripControlSequences(input), expected);
  });

  it('preserves multiple OSC 8 hyperlinks in same text', () => {
    const input =
      '\x1b]8;;https://a.com\x1b\\A\x1b]8;;\x1b\\ \x1b]8;;https://b.com\x1b\\B\x1b]8;;\x1b\\';
    // Openers preserved, closers stripped, spaces between links preserved
    const expected = '\x1b]8;;https://a.com\x1b\\A \x1b]8;;https://b.com\x1b\\B';
    assert.equal(stripControlSequences(input), expected);
  });

  it('preserves OSC 8 hyperlink with only URI (closer stripped per note)', () => {
    // The spec says OSC 8 closers (ESC ] 8 ;; ESC \) are stripped.
    // But hyperlinks with just the opener should still be preserved.
    const input = '\x1b]8;;https://example.com\x1b\\click me';
    const expected = '\x1b]8;;https://example.com\x1b\\click me';
    assert.equal(stripControlSequences(input), expected);
  });

  it('preserves text around OSC 8 hyperlinks', () => {
    const input = 'before \x1b]8;;https://x.com\x1b\\link\x1b]8;;\x1b\\ after';
    // Opener preserved, closer stripped, surrounding text preserved
    const expected = 'before \x1b]8;;https://x.com\x1b\\link after';
    assert.equal(stripControlSequences(input), expected);
  });

  // ── DCS sequences ─────────────────────────────────────────────────────────

  it('strips DCS sequences: ESC P ... ST', () => {
    assert.equal(stripControlSequences('\x1bP0;0;0t\x1b\\'), '');
  });

  it('strips DCS with data payload', () => {
    assert.equal(stripControlSequences('\x1bP1;1;1q#0:0;0;0;0;0\x1b\\'), '');
  });

  // ── C1 escape sequences ───────────────────────────────────────────────────

  it('strips C1 escape + single char: \\x1bN (SS2)', () => {
    assert.equal(stripControlSequences('\x1bN'), '');
  });

  it('strips C1 escape + single char: \\x1bO (SS3)', () => {
    assert.equal(stripControlSequences('\x1bO'), '');
  });

  it('strips \\x1bX with trailing char', () => {
    assert.equal(stripControlSequences('\x1bXhello'), 'hello');
  });

  // ── C0 control codes ──────────────────────────────────────────────────────

  it('preserves TAB (0x09)', () => {
    assert.equal(stripControlSequences('\t'), '\t');
  });

  it('preserves LF (0x0A)', () => {
    assert.equal(stripControlSequences('\n'), '\n');
  });

  it('preserves CR (0x0D)', () => {
    assert.equal(stripControlSequences('\r'), '\r');
  });

  it('strips NUL (0x00)', () => {
    assert.equal(stripControlSequences('\x00'), '');
  });

  it('strips BEL (0x07) when not part of OSC', () => {
    assert.equal(stripControlSequences('\x07'), '');
  });

  it('strips VT (0x0B)', () => {
    assert.equal(stripControlSequences('\x0B'), '');
  });

  it('strips FF (0x0C)', () => {
    assert.equal(stripControlSequences('\x0C'), '');
  });

  it('strips SO (0x0E)', () => {
    assert.equal(stripControlSequences('\x0E'), '');
  });

  it('strips SI (0x0F)', () => {
    assert.equal(stripControlSequences('\x0F'), '');
  });

  it('strips all C0 controls except TAB, LF, CR', () => {
    const input =
      '\x00\x01\x02\x03\x04\x05\x06\x07\x08\x0B\x0C\x0E\x0F\x10\x11\x12\x13\x14\x15\x16\x17\x18\x19\x1A\x1B\x1C\x1D\x1E\x1F';
    const expected = '';
    assert.equal(stripControlSequences(input), expected);
  });

  // ── Plain text passthrough ─────────────────────────────────────────────────

  it('passes plain text unchanged', () => {
    const text = 'Hello, world! This is safe text with numbers 123 and symbols @#$%.';
    assert.equal(stripControlSequences(text), text);
  });

  it('passes text with newlines and tabs unchanged', () => {
    const text = 'line1\n\tline2\n\t\tline3';
    assert.equal(stripControlSequences(text), text);
  });

  // ── Mixed content ─────────────────────────────────────────────────────────

  it('strips injection mixed with safe text', () => {
    const input = 'Hello\x1b[31m World\x1b[0m!';
    assert.equal(stripControlSequences(input), 'Hello World!');
  });

  it('strips nested/layered escape sequences in artificial injection', () => {
    // Adversarial sequence: OSC within CSI-like content
    const input = '\x1b[31m\x1b]2;nope\x07\x1b[0mclean';
    assert.equal(stripControlSequences(input), 'clean');
  });

  it('strips sequences at start, middle, and end of text', () => {
    const input = '\x1b[1mBOLD\x1b[0m normal \x1b[31mRED\x1b[0m';
    assert.equal(stripControlSequences(input), 'BOLD normal RED');
  });

  // ── Edge cases ────────────────────────────────────────────────────────────

  it('returns empty string for empty input', () => {
    assert.equal(stripControlSequences(''), '');
  });

  it('returns input as-is for string with no control sequences', () => {
    assert.equal(stripControlSequences('no sequences'), 'no sequences');
  });

  it('handles large input strings (regex DoS resistance)', () => {
    // 100KB of plain text — should process quickly without catastrophic backtracking
    const base = 'A'.repeat(1000);
    const large = base.repeat(100); // 100KB
    const result = stripControlSequences(large);
    assert.equal(result, large);
  });

  it('handles large input with many sequences', () => {
    // 10KB of text with CSI sequences every 100 chars
    const safe = 'test';
    let input = '';
    for (let i = 0; i < 100; i++) {
      input += '\x1b[31m' + safe;
    }
    const result = stripControlSequences(input);
    assert.equal(result, safe.repeat(100));
  });

  it('strips only valid OSC 8 closers (ESC ] 8 ;; ESC \\)', () => {
    // Standalone OSC 8 closers are stripped per first pass
    const result = stripControlSequences('\x1b]8;;\x1b\\');
    assert.equal(result, '');
  });

  it('does not strip malformed OSC 8 (missing ;; after 8)', () => {
    // OSC sequence with only 8 but not properly formed — should be stripped like any other OSC
    const result = stripControlSequences('\x1b]8\x07');
    assert.equal(result, '');
  });

  it('strips OSC 1 (icon title) which is non-OSC8', () => {
    assert.equal(stripControlSequences('\x1b]1;icon\x07'), '');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// sanitizeLlmOutput
// ═══════════════════════════════════════════════════════════════════════════════

describe('sanitizeLlmOutput', () => {
  it('delegates to stripControlSequences', () => {
    assert.equal(sanitizeLlmOutput('\x1b[31mred'), 'red');
  });

  it('preserves OSC 8 hyperlinks', () => {
    const input = '\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\';
    // Opener preserved, closer stripped
    const expected = '\x1b]8;;https://example.com\x1b\\link';
    assert.equal(sanitizeLlmOutput(input), expected);
  });

  it('strips mixed dangerous content', () => {
    const input = 'INFO: \x1b[1muser data\x1b[0m loaded\x07';
    assert.equal(sanitizeLlmOutput(input), 'INFO: user data loaded');
  });

  it('handles empty string', () => {
    assert.equal(sanitizeLlmOutput(''), '');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// sanitizeCodeLine
// ═══════════════════════════════════════════════════════════════════════════════

describe('sanitizeCodeLine', () => {
  it('delegates to stripControlSequences', () => {
    assert.equal(sanitizeCodeLine('\x1b[31mcode\x1b[0m'), 'code');
  });

  it('preserves code indentation', () => {
    const code = '  function foo() {\n    return 1;\n  }';
    assert.equal(sanitizeCodeLine(code), code);
  });

  it('strips escape sequences from code lines', () => {
    assert.equal(sanitizeCodeLine('console.log(\x1b[32m"hello"\x1b[0m)'), 'console.log("hello")');
  });

  it('handles empty line', () => {
    assert.equal(sanitizeCodeLine(''), '');
  });
});
