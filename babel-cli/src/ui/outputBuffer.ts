/**
 * OutputBuffer — unified output path for the Babel TUI.
 *
 * Replaces scattered process.stdout.write() calls, log-update usage, and raw
 * ANSI sequences with a single coordinated path that supports DEC 2026
 * Synchronized Update for tear-free rendering.
 *
 * Architecture:
 *   - Singleton (getInstance()) like FrameScheduler
 *   - Frame buffering: beginFrame()/endFrame() collect writes into a single
 *     buffer flushed atomically within DEC 2026 delimiters
 *   - Outside frames: writes go directly to stdout (backward compatible)
 *   - Error handling: EPIPE / ERR_STREAM_DESTROYED / ENOTCONN are caught and
 *     stored as a broken state so callers can check canWrite
 *   - Cursor and screen management via ANSI escape sequences
 *   - All row/col positions are 1-based (matching ANSI terminal conventions)
 */

import { isA11yMode, sanitizeForA11y } from './a11y.js';
import { probeTerminalCapabilities, terminalCapsCompat } from './terminalProbe.js';

// ── Error handling ──────────────────────────────────────────────────────────

/** Error codes from stdout writes that indicate the stream is broken. */
const BROKEN_STDOUT_CODES: ReadonlySet<string> = new Set([
  'EPIPE',
  'ERR_STREAM_DESTROYED',
  'ENOTCONN',
]);

export function isBrokenStdoutError(error: unknown): boolean {
  if (error && typeof error === 'object' && 'code' in error) {
    return BROKEN_STDOUT_CODES.has((error as { code: string }).code);
  }
  return false;
}

/**
 * Sanitize a URI for use in OSC 8 hyperlink escape sequences.
 * Only http and https URLs are considered safe for terminal hyperlinks.
 * Returns null for non-web destinations (mailto:, file:, etc.).
 */
export function sanitizeHyperlinkUri(uri: string): string | null {
  const safe = uri.replace(/[\x00-\x1f\x7f]/g, '');
  try {
    const url = new URL(safe);
    if ((url.protocol === 'http:' || url.protocol === 'https:') && url.hostname) {
      return safe;
    }
    return null;
  } catch {
    return null;
  }
}

// ── DEC 2026 escape sequences ───────────────────────────────────────────────

import { DEC_2026_BEGIN, DEC_2026_END } from './terminalEscapeSequences.js';

// ── ANSI escape helpers ─────────────────────────────────────────────────────

/** Move cursor to 1-based row, column. */
function cursorPos(row: number, col: number): string {
  return `\x1b[${row};${col}H`;
}

/** Clear from cursor to end of line. */
const CLEAR_TO_EOL = '\x1b[K';

/** Hide cursor. */
const CURSOR_HIDE = '\x1b[?25l';

/** Show cursor. */
const CURSOR_SHOW = '\x1b[?25h';

/** Save cursor position. */
const CURSOR_SAVE = '\x1b[s';

/** Restore cursor position. */
const CURSOR_RESTORE = '\x1b[u';

// ── Metrics types ───────────────────────────────────────────────────────────

/** Per-frame output metrics recorded after each endFrame(). */
export interface OutputFrameMetrics {
  bytesWritten: number;
  timestamp: number;
  wasSyncUpdate: boolean;
}

// ── OutputBuffer class ──────────────────────────────────────────────────────

export class OutputBuffer {
  private static instance: OutputBuffer | null = null;

  /** Maximum number of frames retained in the history buffer. */
  private static readonly MAX_FRAME_HISTORY = 60;

  /** Whether the terminal supports DEC 2026 synchronized update. */
  private readonly _supportsSyncUpdate: boolean;

  /** True after a broken-stdout error (EPIPE etc.) is caught. */
  private _broken = false;

  /** Whether we are inside a beginFrame() / endFrame() pair. */
  private _inFrame = false;

  /** Accumulated output during an active frame. */
  private _frameBuffer: string[] = [];

  // ── Metrics ─────────────────────────────────────────────────────────────

  /** Total bytes written through writeRaw() since instantiation or last resetStats(). */
  private _totalBytesWritten = 0;

  /** Bytes written in the current frame (accumulated across writeRaw calls). */
  private _frameBytes = 0;

  /** Circular buffer of per-frame metrics. */
  private _frameHistory: OutputFrameMetrics[] = [];

  // ── Resize handling ───────────────────────────────────────────────────────

  /** Registered resize callbacks. */
  private _resizeCallbacks: Array<(width: number, height: number) => void> = [];

  /** Debounce timer for resize events. */
  private _resizeTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Internal resize handler bound once on first registration.
   * Debounces resize events (100ms) before notifying callbacks.
   */
  private _handleResize = (): void => {
    if (this._resizeTimer) clearTimeout(this._resizeTimer);
    this._resizeTimer = setTimeout(() => {
      const size = OutputBuffer.getTerminalSize();
      for (const cb of this._resizeCallbacks) {
        try {
          cb(size.cols, size.rows);
        } catch {
          // Isolate callback failures — one bad callback must not break others
        }
      }
    }, 100);
  };

  // ── Singleton ─────────────────────────────────────────────────────────────

  private constructor() {
    this._supportsSyncUpdate = OutputBuffer.detectSyncUpdate();
  }

  /** Get the singleton instance. */
  static getInstance(): OutputBuffer {
    if (!OutputBuffer.instance) {
      OutputBuffer.instance = new OutputBuffer();
    }
    return OutputBuffer.instance;
  }

  /** Reset the singleton (for testing or terminal restore). */
  static resetInstance(): void {
    OutputBuffer.instance = null;
  }

  // ── DEC 2026 detection ────────────────────────────────────────────────────

  /**
   * Check whether the terminal supports DEC 2026 Synchronized Update.
   * Delegates to the centralized terminal capability probe.
   */
  private static detectSyncUpdate(): boolean {
    return probeTerminalCapabilities().syncUpdate;
  }

  /**
   * Static helper so consumers can check up front (mirrors the instance check).
   */
  static supportsSyncUpdate(): boolean {
    return OutputBuffer.getInstance()._supportsSyncUpdate;
  }

  // ── Frame management (DEC 2026 Synchronized Update) ───────────────────────

  /**
   * Begin a synchronized update frame.
   *
   * All subsequent writes are buffered and flushed atomically when endFrame()
   * is called. On terminals that support DEC 2026, emits the begin sequence.
   *
   * Nested frames are silently merged into the outer frame — only the outermost
   * beginFrame/endFrame pair controls DEC 2026 delimiters and flush.
   */
  beginFrame(): void {
    if (this._inFrame) {
      // Nested frame: merge into the active outer frame
      return;
    }
    this._inFrame = true;
    this._frameBuffer = [];

    if (this._supportsSyncUpdate) {
      const caps = terminalCapsCompat();
      if (caps.dec2026Sync) {
        this._frameBuffer.push(DEC_2026_BEGIN);
      }
    }
  }

  /**
   * End a synchronized update frame.
   *
   * Flushes all buffered output in a single process.stdout.write() call,
   * wrapped in DEC 2026 end sequence if supported. If frames were nested,
   * only the outermost call performs the actual flush.
   */
  endFrame(): void {
    if (!this._inFrame) {
      // endFrame() without beginFrame() is a no-op
      return;
    }

    // Flush buffered content through the normal path (respects _broken).
    const output = this._frameBuffer.join('');
    this._frameBuffer = [];

    if (output) {
      this.writeRaw(output);
    }

    // Always send DEC 2026 END, even if stdout is broken. The terminal
    // MUST be unlocked from synchronized-update mode or it will buffer
    // all subsequent output invisibly.
    if (this._supportsSyncUpdate) {
      const caps = terminalCapsCompat();
      if (caps.dec2026Sync) {
        this.writeRawUnchecked(DEC_2026_END);
      }
    }

    // Record frame metrics (after flush so writeRaw has counted the bytes).
    // _inFrame must still be true during writeRaw so _frameBytes is incremented;
    // clear it now that the frame is fully committed.
    this._frameHistory.push({
      bytesWritten: this._frameBytes,
      timestamp: Date.now(),
      wasSyncUpdate: this._supportsSyncUpdate,
    });
    if (this._frameHistory.length > OutputBuffer.MAX_FRAME_HISTORY) {
      this._frameHistory.shift();
    }
    this._frameBytes = 0;
    this._inFrame = false;
  }

  // ── Writing ─────────────────────────────────────────────────────────────

  /**
   * Write text at the current cursor position.
   *
   * When inside a beginFrame()/endFrame() block, the text is buffered.
   * Otherwise it is written to stdout immediately.
   */
  write(text: string): void {
    if (!text) return;
    if (this._inFrame) {
      this._frameBuffer.push(text);
    } else {
      this.writeRaw(text);
    }
  }

  /**
   * Write terminal protocol / layout control sequences that must never be
   * stripped by a11y sanitization (alt-screen, cursor show/hide, clear, etc.).
   *
   * Prefer this over write() for CSI mode switches. Content and SGR styling
   * should still go through write().
   */
  writeControl(text: string): void {
    if (!text || this._broken) return;
    this._totalBytesWritten += text.length;
    if (this._inFrame) {
      // Control sequences must flush immediately so frame content lands after
      // mode switches (e.g. enter alt-screen before drawing the frame).
      this.writeRawUnchecked(text);
      return;
    }
    try {
      process.stdout.write(text);
    } catch (error: unknown) {
      if (isBrokenStdoutError(error)) {
        this._broken = true;
      }
    }
  }

  /**
   * Write text at an absolute cursor position (1-based row and column).
   *
   * Moves the cursor to (row, col), writes the text, then restores the
   * cursor to its original position. Always buffered during a frame.
   */
  writeAt(row: number, col: number, text: string): void {
    if (!text) return;
    const seq = `${CURSOR_SAVE}${cursorPos(row, col)}${text}${CURSOR_RESTORE}`;
    if (this._inFrame) {
      this._frameBuffer.push(seq);
    } else {
      this.writeRaw(seq);
    }
  }

  /**
   * Clear from cursor to end of line, then write text at an absolute
   * position. Equivalent to "clear this line region and write".
   */
  writeLine(row: number, col: number, text: string): void {
    const seq = `${CURSOR_SAVE}${cursorPos(row, col)}${CLEAR_TO_EOL}${text}${CURSOR_RESTORE}`;
    if (this._inFrame) {
      this._frameBuffer.push(seq);
    } else {
      this.writeRaw(seq);
    }
  }

  /**
   * Clear a rectangular region by writing spaces over each line.
   *
   * Operates on inclusive row/col ranges. Each line in the region is
   * cleared to end-of-line first, then spaces fill the column range.
   */
  clearRegion(startRow: number, endRow: number, startCol: number, endCol: number): void {
    const parts: string[] = [];
    for (let r = startRow; r <= endRow; r++) {
      parts.push(CURSOR_SAVE);
      parts.push(cursorPos(r, startCol));
      parts.push(CLEAR_TO_EOL);
      if (endCol > startCol) {
        const width = endCol - startCol + 1;
        parts.push(' '.repeat(width));
      }
      parts.push(CURSOR_RESTORE);
    }
    const seq = parts.join('');
    if (this._inFrame) {
      this._frameBuffer.push(seq);
    } else {
      this.writeRaw(seq);
    }
  }

  // ── Cursor management ───────────────────────────────────────────────────

  /** Hide cursor. */
  hideCursor(): void {
    this.write(CURSOR_HIDE);
  }

  /** Show cursor. */
  showCursor(): void {
    this.write(CURSOR_SHOW);
  }

  /**
   * Move cursor to an absolute position (1-based).
   */
  moveCursor(row: number, col: number): void {
    this.write(cursorPos(row, col));
  }

  /** Save cursor position. */
  saveCursor(): void {
    this.write(CURSOR_SAVE);
  }

  /** Restore cursor position. */
  restoreCursor(): void {
    this.write(CURSOR_RESTORE);
  }

  // ── Screen management ───────────────────────────────────────────────────

  /**
   * Set the scroll region to the given line range (1-based, inclusive).
   * After setting, the cursor is moved to (top, 1).
   */
  setScrollRegion(top: number, bottom: number): void {
    this.writeRaw(`\x1b[${top};${bottom}r`);
  }

  /** Reset scroll region to the full screen. */
  resetScrollRegion(): void {
    this.writeRaw('\x1b[r');
  }

  // ── Hyperlink support (OSC 8) ───────────────────────────────────────────

  /**
   * Write text as a clickable OSC 8 hyperlink.
   *
   * Only emits OSC 8 sequences for valid http/https URLs. Non-web
   * destinations are written as plain text. The OSC 8 bytes are tracked
   * separately and do not affect string-width calculations.
   *
   * Supported on: iTerm2, WezTerm, kitty, Ghostty, Windows Terminal,
   * VS Code integrated terminal.
   *
   * @param uri - The URL to link to (http/https only)
   * @param text - The visible text to display
   */
  writeHyperlink(uri: string, text: string): void {
    if (!text) return;
    const safe = sanitizeHyperlinkUri(uri);
    if (!safe) {
      this.write(text);
      return;
    }
    const osc = `\x1b]8;;${safe}\x07${text}\x1b]8;;\x07`;
    if (this._inFrame) {
      this._frameBuffer.push(osc);
    } else {
      this.writeRaw(osc);
    }
  }

  /**
   * Write text at an absolute cursor position as a clickable hyperlink.
   *
   * Combines writeAt positioning with OSC 8 hyperlink annotation.
   */
  writeHyperlinkAt(row: number, col: number, uri: string, text: string): void {
    if (!text) return;
    const safe = sanitizeHyperlinkUri(uri);
    if (!safe) {
      this.writeAt(row, col, text);
      return;
    }
    const osc = `\x1b]8;;${safe}\x07${text}\x1b]8;;\x07`;
    const seq = `${CURSOR_SAVE}${cursorPos(row, col)}${osc}${CURSOR_RESTORE}`;
    if (this._inFrame) {
      this._frameBuffer.push(seq);
    } else {
      this.writeRaw(seq);
    }
  }

  // ── Resize handling ──────────────────────────────────────────────────────

  /**
   * Register a callback invoked when the terminal is resized.
   *
   * The callback receives the new (cols, rows) dimensions. Resize events are
   * debounced at 100ms to avoid excessive re-renders during rapid resizing.
   * On Windows, `process.stdout.on('resize', ...)` is used natively.
   *
   * Returns an unregister function so callers can clean up in stop()/destroy().
   */
  onResize(callback: (width: number, height: number) => void): () => void {
    this._resizeCallbacks.push(callback);

    // First registration sets up the backing listener
    if (this._resizeCallbacks.length === 1) {
      process.stdout.on('resize', this._handleResize);
    }

    return () => {
      const idx = this._resizeCallbacks.indexOf(callback);
      if (idx >= 0) this._resizeCallbacks.splice(idx, 1);
      if (this._resizeCallbacks.length === 0) {
        process.stdout.off('resize', this._handleResize);
      }
    };
  }

  /**
   * Current known terminal size.
   */
  static getTerminalSize(): { cols: number; rows: number } {
    return {
      cols: process.stdout.columns ?? 88,
      rows: process.stdout.rows ?? 24,
    };
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  /**
   * Flush any pending output immediately.
   *
   * If a frame is active, the frame buffer is written (wrapped in DEC 2026
   * if supported) but the frame remains open for further writes.
   */
  flush(): void {
    if (this._inFrame && this._frameBuffer.length > 0) {
      const output = this._frameBuffer.join('');
      this._frameBuffer = [];
      this.writeRaw(output);
    }
    // Outside a frame, there is nothing to flush — writes go directly.
  }

  /**
   * Reset internal state. Call on terminal restore.
   *
   * Unlocks DEC 2026 synchronized-update mode (if active), clears the
   * frame buffer, resets the broken flag, and shows the cursor.
   */
  reset(): void {
    // Unlock DEC 2026 synchronized update before resetting state.
    // The terminal may be stuck in sync mode from a prior EPIPE error;
    // this terminator MUST reach stdout even if _broken is set.
    if (this._supportsSyncUpdate && this._inFrame) {
      const caps = terminalCapsCompat();
      if (caps.dec2026Sync) {
        this.writeRawUnchecked(DEC_2026_END);
      }
    }
    this._inFrame = false;
    this._frameBuffer = [];
    this._broken = false;
    this._frameBytes = 0;
    this.writeRaw(CURSOR_SHOW);
  }

  /**
   * Reset all metrics counters. Does not affect frame state or broken flag.
   */
  resetStats(): void {
    this._totalBytesWritten = 0;
    this._frameBytes = 0;
    this._frameHistory = [];
  }

  // ── State queries ─────────────────────────────────────────────────────────

  /** Whether the output stream is usable (no EPIPE etc.). */
  get canWrite(): boolean {
    return !this._broken;
  }

  /** Whether we are currently inside a synchronized update frame. */
  get inFrame(): boolean {
    return this._inFrame;
  }

  /** Whether the terminal supports DEC 2026 synchronized updates. */
  get syncUpdateSupported(): boolean {
    return this._supportsSyncUpdate;
  }

  /** Total bytes written through the output path since instantiation or last resetStats(). */
  get totalBytesWritten(): number {
    return this._totalBytesWritten;
  }

  /** Per-frame metrics history (circular buffer, most recent last). */
  get frameHistory(): readonly OutputFrameMetrics[] {
    return this._frameHistory;
  }

  /** Bytes written in the most recent completed frame, or 0 if no frames yet. */
  get lastFrameBytes(): number {
    const last = this._frameHistory[this._frameHistory.length - 1];
    return last?.bytesWritten ?? 0;
  }

  // ── Low-level write (internal) ──────────────────────────────────────────

  /**
   * Write a string directly to stdout, catching broken-pipe errors.
   *
   * This is the single choke-point through which all output flows. On the
   * first broken-stdout error, _broken is set to true and further writes
   * are suppressed (the renderers check canWrite and stop their loops).
   */
  private writeRaw(text: string): void {
    if (!text || this._broken) return;
    // In a11y mode, strip all ANSI escape sequences for screen-reader compatibility
    const output = isA11yMode() ? sanitizeForA11y(text) : text;
    if (!output) return;
    // Count bytes before writing (use the raw text length so the count is
    // consistent regardless of a11y mode)
    this._totalBytesWritten += text.length;
    if (this._inFrame) {
      this._frameBytes += text.length;
    }
    try {
      process.stdout.write(output);
    } catch (error: unknown) {
      if (isBrokenStdoutError(error)) {
        this._broken = true;
      }
    }
  }

  /**
   * Write a critical protocol terminator directly to stdout, bypassing the
   * `_broken` guard. Used ONLY for sequences that must reach the terminal to
   * recover from error states (e.g. DEC 2026 end to unlock sync mode).
   *
   * Unlike writeRaw(), this does not check `_broken` — the terminal MUST
   * receive protocol terminators even when the stream previously errored.
   * It still catches EPIPE errors to update `_broken` for subsequent writes.
   */
  private writeRawUnchecked(text: string): void {
    if (!text) return;
    const output = isA11yMode() ? sanitizeForA11y(text) : text;
    if (!output) return;
    this._totalBytesWritten += text.length;
    if (this._inFrame) {
      this._frameBytes += text.length;
    }
    try {
      process.stdout.write(output);
    } catch (error: unknown) {
      if (isBrokenStdoutError(error)) {
        this._broken = true;
      }
    }
  }
}
