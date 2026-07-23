/**
 * TwoRegionStreaming — hardware-scroll-region-based streaming output.
 *
 * Splits the terminal into two zones using DECSTBM scroll regions:
 *
 *   ┌──────────────────────────┐
 *   │  Scrollback Region       │  ← rows 1 to (N - streamingRows)
 *   │  (stable, scrolls via    │     completed content lives here,
 *   │   terminal hardware)     │     terminal handles scrolling naturally
 *   ├──────────────────────────┤
 *   │  Streaming Region        │  ← rows (N-streamingRows+1) to N
 *   │  (mutable tail)          │     MarkdownAccumulator renders here,
 *   │                          │     content updates in-place, then
 *   │                          │     "graduates" to scrollback on commit
 *   └──────────────────────────┘
 *
 * When DECSTBM is unavailable (Apple Terminal, tmux < 3.3, or
 * BABEL_SCROLL_REGIONS=0), falls back to the current cursor-up approach
 * where all content is written sequentially and in-place updates use
 * \x1b[N A cursor-up + clear-to-end sequences.
 *
 * Overflow graduation is monotonic: each logical line is written to the
 * scrollback region at most once. Full-content replaces (markdown rewrites,
 * resize reflow) re-paint the streaming area without re-dumping the already
 * graduated prefix — that was the "answer reprints N times as it grows" bug.
 *
 * Usage:
 *   const streaming = new TwoRegionStreaming();
 *   streaming.setup(process.stdout.rows, 12);
 *   streaming.writeStreaming(delta);
 *   streaming.writeStreaming(moreDelta);
 *   streaming.commitStreaming();
 *   streaming.teardown();
 *
 * @module twoRegionStreaming
 */

import { OutputBuffer } from './outputBuffer.js';
import { probeTerminalCapabilities } from './terminalProbe.js';

/** Default number of rows reserved for the mutable streaming area. */
const DEFAULT_STREAMING_ROWS = 12;

/** Minimum terminal height required for two-region mode. */
const MIN_TERMINAL_HEIGHT = 20;

export class TwoRegionStreaming {
  private buf: OutputBuffer;
  private useHardwareScroll: boolean;

  /** Top row of the streaming region (1-based). */
  private streamingTop = 0;
  /** Bottom row of the streaming region (1-based). */
  private streamingBottom = 0;
  /** Number of rows in the streaming region. */
  private streamingRows = DEFAULT_STREAMING_ROWS;
  /** Total terminal height at last setup. */
  private terminalHeight = 0;
  /** Terminal width at last setup/resize (for width-change detection). */
  private terminalWidth = 0;
  /** Whether setup() has been called and teardown() hasn't. */
  private _isActive = false;
  /** Whether we are in fallback (cursor-up) mode. */
  private fallbackMode = false;

  /**
   * Full logical lines of the current streaming message (including lines
   * already graduated to scrollback). Index 0 is the first line of the
   * answer; the visible streaming window is `lines.slice(graduatedCount)`.
   */
  private lines: string[] = [];

  /**
   * How many leading lines have already been written to the scrollback
   * region. Monotonic for a given turn — full replaces must not reset this
   * or the prefix is re-printed on every markdown rewrite.
   */
  private graduatedCount = 0;

  constructor() {
    this.buf = OutputBuffer.getInstance();
    const caps = probeTerminalCapabilities();
    this.useHardwareScroll = caps.scrollRegions;

    // Allow force-override for testing
    if (process.env['BABEL_SCROLL_REGIONS'] === '0') {
      this.useHardwareScroll = false;
    }
    if (process.env['BABEL_SCROLL_REGIONS'] === '1') {
      this.useHardwareScroll = true;
    }
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Set up the two-region layout.
   *
   * In hardware mode: sets DECSTBM scroll region to the scrollback area,
   * positions the cursor at the top of the streaming area.
   *
   * In fallback mode: is a no-op (caller uses existing cursor-up path).
   *
   * @param terminalHeight - Current terminal rows (process.stdout.rows)
   * @param streamingRows - Rows to reserve for the mutable streaming area
   */
  setup(
    terminalHeight: number,
    streamingRows: number = DEFAULT_STREAMING_ROWS,
    terminalWidth: number = 0,
  ): void {
    this.terminalHeight = terminalHeight;
    this.terminalWidth = terminalWidth;
    this.streamingRows = Math.max(4, Math.min(streamingRows, Math.floor(terminalHeight / 3)));
    this.streamingTop = terminalHeight - this.streamingRows + 1;
    this.streamingBottom = terminalHeight;
    this.lines = [];
    this.graduatedCount = 0;
    this._isActive = true;

    // Fall back to cursor-up mode if the terminal is too small or scroll
    // regions aren't supported
    if (!this.useHardwareScroll || terminalHeight < MIN_TERMINAL_HEIGHT) {
      this.fallbackMode = true;
      return;
    }

    this.fallbackMode = false;

    // Set scroll region to the scrollback area (rows 1 to streamingTop-1).
    // Content written above the streaming area will scroll naturally within
    // that region, leaving the streaming area fixed.
    if (this.streamingTop > 1) {
      this.buf.setScrollRegion(1, this.streamingTop - 1);
    }

    // Position cursor at the top of the streaming area
    this.buf.moveCursor(this.streamingTop, 1);
  }

  /**
   * Append a streaming delta into the full line buffer.
   *
   * Mid-line chunks (no leading/internal newline) extend the last line.
   * Newlines open subsequent lines. Previously every `split('\n')` piece
   * was pushed as a new row, so token-sized deltas like `" hello"` became
   * their own terminal rows — the vertical fragmentation seen in chat
   * stream output on hardware-scroll terminals (Windows Terminal, etc.).
   */
  private _appendStreamingDelta(text: string): void {
    let i = 0;
    while (i < text.length) {
      if (text[i] === '\n') {
        // Start a new logical line after the current one.
        this.lines.push('');
        i += 1;
        continue;
      }
      let j = text.indexOf('\n', i);
      if (j === -1) j = text.length;
      const piece = text.slice(i, j);
      if (this.lines.length === 0) {
        this.lines.push(piece);
      } else {
        const last = this.lines.length - 1;
        this.lines[last] = (this.lines[last] ?? '') + piece;
      }
      i = j;
    }
  }

  /**
   * Graduate newly overflowed lines to scrollback (at most once each) and
   * re-paint the streaming window with the ungraduated tail.
   *
   * Graduation is monotonic: we never decrease `graduatedCount` to re-show
   * lines already written to scrollback (that caused full-answer reprints).
   */
  private _syncOverflowAndRender(): void {
    const targetGraduated = Math.max(0, this.lines.length - this.streamingRows);

    // Grow graduation monotonically — never re-write already graduated lines.
    while (this.graduatedCount < targetGraduated) {
      this._writeToScrollback(this.lines[this.graduatedCount]!);
      this.graduatedCount += 1;
    }

    // Content shortened below the watermark (rare): clamp to line count.
    // Scrollback cannot un-write; those lines stay as historical output.
    if (this.graduatedCount > this.lines.length) {
      this.graduatedCount = this.lines.length;
    }

    this._renderStreamingArea();
  }

  /**
   * Write content to the streaming region.
   *
   * In hardware mode: merges the delta into the full line buffer,
   * graduates only newly overflowed lines, re-renders the streaming area.
   *
   * In fallback mode: writes directly to stdout (same as current behavior).
   *
   * @param text - The ANSI-formatted text to display in the streaming area
   */
  writeStreaming(text: string): void {
    if (!text || !this._isActive) return;

    if (this.fallbackMode) {
      // Fallback: write directly — caller handles cursor-up positioning.
      this.buf.write(text);
      return;
    }

    this._appendStreamingDelta(text);
    this._syncOverflowAndRender();
  }

  /**
   * Finalize streaming — reset scroll regions and "graduate" any remaining
   * streaming content to the normal terminal buffer.
   *
   * Hardware mode paints the streaming area with absolute cursor positioning.
   * Those cells are already visible. Committing without clearing first would
   * write a second copy of the same lines into the normal buffer (full answer
   * appears twice at end of turn). Clear the streaming rows, reset DECSTBM,
   * then write the not-yet-graduated lines once.
   */
  commitStreaming(): void {
    if (!this._isActive) return;

    if (!this.fallbackMode) {
      const remaining = this.lines.slice(this.graduatedCount);

      // Clear absolute-positioned streaming paint so graduation is the sole
      // remaining copy of these lines on screen.
      if (this.streamingTop > 0 && this.streamingRows > 0) {
        this.buf.beginFrame();
        try {
          for (let i = 0; i < this.streamingRows; i++) {
            this.buf.writeLine(this.streamingTop + i, 1, '');
          }
        } finally {
          this.buf.endFrame();
        }
      }

      // Reset scroll region to full screen
      this.buf.resetScrollRegion();

      // Graduate remaining (not-yet-overflowed) content into the normal buffer.
      if (remaining.length > 0) {
        this.buf.moveCursor(this.streamingTop, 1);
        for (const line of remaining) {
          this.buf.write(`${line}\n`);
        }
      }
    }

    this.lines = [];
    this.graduatedCount = 0;
    this._isActive = false;
  }

  /**
   * Handle terminal resize.
   *
   * Recalculates the streaming area position and re-renders.
   */
  onResize(newHeight: number, newWidth: number): void {
    if (!this._isActive) return;

    const oldStreamingTop = this.streamingTop;
    const oldRows = this.streamingRows; // capture before mutation
    const widthChanged = newWidth > 0 && newWidth !== this.terminalWidth;
    this.terminalHeight = newHeight;
    if (newWidth > 0) {
      this.terminalWidth = newWidth;
    }
    // Recalculate streaming rows with the same cap logic as setup()
    this.streamingRows = Math.max(4, Math.min(this.streamingRows, Math.floor(newHeight / 3)));
    this.streamingTop = newHeight - this.streamingRows + 1;
    this.streamingBottom = newHeight;

    if (this.fallbackMode) return;

    if (newHeight < MIN_TERMINAL_HEIGHT) {
      // Terminal too small — fall back
      this.fallbackMode = true;
      this.buf.resetScrollRegion();
      return;
    }

    // Re-set scroll region to new dimensions
    if (this.streamingTop > 1) {
      this.buf.setScrollRegion(1, this.streamingTop - 1);
    }

    // Clear old streaming area rows to prevent ghost text when the
    // streaming area position has moved.
    if (oldStreamingTop !== this.streamingTop && oldStreamingTop > 0) {
      for (let r = oldStreamingTop; r < oldStreamingTop + oldRows && r <= this.terminalHeight; r++) {
        this.buf.writeLine(r, 1, '');
      }
    }

    // Re-sync overflow (streamingRows may have changed) and re-render when
    // the streaming area moved or terminal width changed.
    if (this.lines.length > 0 && (this.streamingTop !== oldStreamingTop || widthChanged || oldRows !== this.streamingRows)) {
      this._syncOverflowAndRender();
    }
  }

  /**
   * Replace the full streaming message snapshot (resize reflow, markdown
   * rewrite). Re-paints the streaming window from the new text without
   * re-writing lines that already graduated to scrollback.
   *
   * This is the critical path for "answer reprints as the table grows":
   * each structural rewrite used to re-split the full message and dump
   * the overflow prefix into scrollback again.
   */
  replaceStreamingContent(text: string): void {
    if (!this._isActive || this.fallbackMode) return;

    this.lines = text ? text.split('\n') : [];
    // Keep graduatedCount — only newly overflowed indices are written.
    if (this.graduatedCount > this.lines.length) {
      this.graduatedCount = this.lines.length;
    }
    this._syncOverflowAndRender();
  }

  /**
   * Tear down the two-region layout. Resets scroll regions and clears state.
   * Safe to call multiple times.
   */
  teardown(): void {
    if (!this._isActive) return;

    if (!this.fallbackMode) {
      this.buf.resetScrollRegion();
    }

    this.lines = [];
    this.graduatedCount = 0;
    this._isActive = false;
    this.fallbackMode = false;
  }

  // ── State queries ───────────────────────────────────────────────────────────

  /** Whether the two-region layout is currently active. */
  get isActive(): boolean {
    return this._isActive;
  }

  /** Whether hardware scroll regions are being used (vs fallback mode). */
  get isHardwareMode(): boolean {
    return this._isActive && !this.fallbackMode;
  }

  /** Rows reserved for the streaming area. */
  get streamingAreaRows(): number {
    return this.streamingRows;
  }

  /** Lines already graduated to scrollback (test/inspection helper). */
  get graduatedLineCount(): number {
    return this.graduatedCount;
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  /**
   * Write a single line to the scrollback area, letting the terminal's
   * hardware scroll region handle the scrolling.
   */
  private _writeToScrollback(line: string): void {
    // Save cursor, move to the bottom of the scrollback region, write the
    // line (which triggers hardware scroll within the scrollback region),
    // restore cursor.
    if (this.streamingTop > 1) {
      this.buf.saveCursor();
      this.buf.moveCursor(this.streamingTop - 1, 1);
      this.buf.write(`${line}\n`);
      this.buf.restoreCursor();
    } else {
      // No scrollback region — write normally
      this.buf.write(`${line}\n`);
    }
  }

  /**
   * Re-render the streaming window from the ungraduated tail of `lines`.
   */
  private _renderStreamingArea(): void {
    const startRow = this.streamingTop;
    const availableRows = this.streamingRows;
    const visible = this.lines.slice(this.graduatedCount);

    this.buf.beginFrame();
    try {
      for (let i = 0; i < availableRows; i++) {
        const row = startRow + i;
        const line = i < visible.length ? visible[i]! : '';
        this.buf.writeLine(row, 1, line);
      }
    } finally {
      this.buf.endFrame();
    }
  }
}
