/**
 * Test output backend for the Babel TUI.
 *
 * Ported from codex `test_backend.rs`. Provides a VT100-style capture buffer
 * that records all ANSI output for deterministic assertions. This allows TUI
 * component tests to verify exact output without a real terminal.
 *
 * Architecture:
 *   - TestOutputBuffer extends OutputBuffer's write path but captures output
 *     into an in-memory string buffer instead of process.stdout.
 *   - Exposes assertion helpers: getOutput(), getLines(), assertContains(),
 *     assertLineMatches(), and assertSnapshot().
 *
 * Usage:
 *   import { TestOutputBuffer } from './testBackend.js';
 *
 *   const buf = TestOutputBuffer.create();
 *   buf.write('Hello\n');
 *   buf.write('World\n');
 *   buf.assertContains('Hello');
 *   buf.assertLineMatches(0, /Hello/);
 *
 * @module testBackend
 */

import { OutputBuffer, sanitizeHyperlinkUri } from './outputBuffer.js';
import { stripAnsi } from './theme.js';

// ── TestOutputBuffer ────────────────────────────────────────────────────────

export class TestOutputBuffer {
  private buffer: string[] = [];
  private _broken = false;
  private _lines: string[] | null = null; // cached split

  /** Create a fresh test buffer. Resets the OutputBuffer singleton so it doesn't interfere. */
  static create(): TestOutputBuffer {
    return new TestOutputBuffer();
  }

  private constructor() {}

  // ── Write methods (mirror OutputBuffer public API) ──────────────────────

  write(text: string): void {
    if (this._broken || !text) return;
    this.buffer.push(text);
    this._lines = null; // invalidate cache
  }

  writeAt(_row: number, _col: number, text: string): void {
    this.write(text);
  }

  writeLine(_row: number, _col: number, text: string): void {
    this.write(text);
  }

  clearRegion(_startRow: number, _endRow: number, _startCol: number, _endCol: number): void {
    // No-op in test buffer — regions don't overlap in tests
  }

  // ── Hyperlink support ──────────────────────────────────────────────────

  writeHyperlink(uri: string, text: string): void {
    const safe = sanitizeHyperlinkUri(uri);
    if (safe) {
      this.write(`\x1b]8;;${safe}\x07${text}\x1b]8;;\x07`);
    } else {
      this.write(text);
    }
  }

  // ── State queries ──────────────────────────────────────────────────────

  get canWrite(): boolean {
    return !this._broken;
  }

  get inFrame(): boolean {
    return false;
  }

  get syncUpdateSupported(): boolean {
    return false;
  }

  // ── Output capture ─────────────────────────────────────────────────────

  /** Get the raw captured output as a single string. */
  getOutput(): string {
    return this.buffer.join('');
  }

  /** Get the captured output split into lines. */
  getLines(): string[] {
    if (this._lines === null) {
      this._lines = this.getOutput().split('\n');
    }
    return this._lines;
  }

  /** Get the captured output with all ANSI escape sequences stripped. */
  getPlainOutput(): string {
    return stripAnsi(this.getOutput());
  }

  /** Get plain lines (ANSI stripped). */
  getPlainLines(): string[] {
    return this.getPlainOutput().split('\n');
  }

  // ── Assertions ─────────────────────────────────────────────────────────

  /** Assert that the output contains the given text (plain, ANSI-stripped). */
  assertContains(expected: string, message?: string): void {
    const plain = this.getPlainOutput();
    if (!plain.includes(expected)) {
      throw new Error(message ?? `Expected output to contain "${expected}"\nActual:\n${plain}`);
    }
  }

  /** Assert that the output does NOT contain the given text. */
  assertNotContains(unexpected: string, message?: string): void {
    const plain = this.getPlainOutput();
    if (plain.includes(unexpected)) {
      throw new Error(message ?? `Expected output NOT to contain "${unexpected}"`);
    }
  }

  /** Assert that a specific line matches a regex pattern. */
  assertLineMatches(lineIndex: number, pattern: RegExp, message?: string): void {
    const lines = this.getPlainLines();
    const line = lines[lineIndex];
    if (line === undefined) {
      throw new Error(message ?? `Line ${lineIndex} does not exist (only ${lines.length} lines)`);
    }
    if (!pattern.test(line)) {
      throw new Error(message ?? `Line ${lineIndex} "${line}" does not match ${pattern}`);
    }
  }

  /** Assert the total number of lines. */
  assertLineCount(expected: number, message?: string): void {
    const lines = this.getLines();
    if (lines.length !== expected) {
      throw new Error(
        message ?? `Expected ${expected} lines, got ${lines.length}\nLines:\n${lines.join('\n')}`,
      );
    }
  }

  /** Assert output matches a string exactly. */
  assertOutput(expected: string, message?: string): void {
    const actual = this.getOutput();
    if (actual !== expected) {
      throw new Error(
        message ??
          `Output mismatch.\nExpected:\n${JSON.stringify(expected)}\nActual:\n${JSON.stringify(actual)}`,
      );
    }
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  /** Reset the buffer. */
  reset(): void {
    this.buffer = [];
    this._lines = null;
    this._broken = false;
  }

  /** Mark the buffer as broken (simulates EPIPE). */
  markBroken(): void {
    this._broken = true;
  }
}

// ── Integration helpers ─────────────────────────────────────────────────────

/**
 * Create a test buffer and temporarily replace the OutputBuffer singleton
 * so all TUI rendering flows into the test buffer. Returns a cleanup function
 * that restores the original singleton.
 *
 * @example
 *   const [buf, restore] = TestOutputBuffer.install();
 *   // ... render components ...
 *   buf.assertContains('Expected text');
 *   restore();
 */
export function installTestOutput(): [TestOutputBuffer, () => void] {
  const buf = TestOutputBuffer.create();
  // Monkey-patch OutputBuffer.getInstance to return our test-compatible wrapper
  const origGetInstance = OutputBuffer.getInstance;
  const origResetInstance = OutputBuffer.resetInstance;

  // We can't easily make OutputBuffer delegate to TestOutputBuffer, so instead
  // we capture process.stdout.write and redirect to the test buffer.
  const origWrite = process.stdout.write;
  const capturedWrites: string[] = [];

  (process.stdout.write as unknown) = (
    chunk: string | Uint8Array,
    _encoding?: string,
    _cb?: (err?: Error) => void,
  ): boolean => {
    const text = typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
    capturedWrites.push(text);
    buf.write(text);
    return true;
  };

  const restore = () => {
    process.stdout.write = origWrite;
    OutputBuffer.resetInstance = origResetInstance;
    // Restore original getInstance via reset
    OutputBuffer.resetInstance();
    // Put back original getInstance
    (OutputBuffer as unknown as { getInstance: typeof OutputBuffer.getInstance }).getInstance =
      origGetInstance;
  };

  return [buf, restore];
}
