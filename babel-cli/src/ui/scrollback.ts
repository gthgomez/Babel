/**
 * Application scrollback buffer for the conversational TUI.
 *
 * Captures rendered ANSI output lines in a ring buffer and exposes a scrollable
 * viewport. When the user scrolls back (mouse wheel or Up/Down arrows), the
 * viewport offset shifts to show older content. When new live output arrives,
 * the viewport auto-scrolls to the bottom (offset=0).
 *
 * This replaces reliance on the terminal's native scrollback buffer, which on
 * some terminals (notably Windows Terminal) mixes main-screen shell history
 * with alternate-screen agent output.
 *
 * Terminal-specific capacity: the constructor adapts its default capacity to
 * the detected terminal's scrollback limits. VS Code terminals retain fewer
 * rows (1000), Windows Terminal more (9001), and so on.
 */

import { effectiveScrollbackCapacity } from './terminalProbe.js';

export interface ScrollInfo {
  offset: number;
  totalLines: number;
  percent: number;
  isAtBottom: boolean;
  unseenSinceLastView: number;
}

/** Default scrollback capacity before terminal-specific clamping. */
const DEFAULT_CAPACITY = 10000;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024; // 10 MiB

export class ScrollbackBuffer {
  private ring: string[];
  private capacity: number;
  private maxBytes: number;
  private currentBytes = 0;
  private offset = 0;
  private lineCount = 0;
  private writeIndex = 0;
  private _unseenSinceLastView = 0;

  constructor(capacity: number = DEFAULT_CAPACITY, maxBytes: number = DEFAULT_MAX_BYTES) {
    // Clamp to terminal-specific reflow cap
    this.capacity = effectiveScrollbackCapacity(capacity);
    this.maxBytes = maxBytes;
    this.ring = new Array(this.capacity);
  }

  /** Append a single rendered line to the buffer. */
  push(line: string): void {
    const lineBytes = Buffer.byteLength(line, 'utf8');

    // Evict oldest entries if adding this line would exceed maxBytes
    while (this.lineCount > 0 && this.currentBytes + lineBytes > this.maxBytes) {
      const oldestIdx = (this.writeIndex - this.lineCount + this.capacity) % this.capacity;
      const removed = this.ring[oldestIdx];
      if (removed !== undefined) {
        this.currentBytes -= Buffer.byteLength(removed, 'utf8');
      }
      this.ring[oldestIdx] = undefined as any;
      this.lineCount--;
      // Adjust offset so viewport stays valid
      if (this.offset >= this.lineCount && this.offset > 0) {
        this.offset = Math.max(0, this.lineCount - 1);
      }
    }

    const wasAtBottom = this.offset === 0;

    this.ring[this.writeIndex] = line;
    this.currentBytes += lineBytes;
    this.writeIndex = (this.writeIndex + 1) % this.capacity;
    if (this.lineCount < this.capacity) {
      this.lineCount++;
    }

    // Track unseen lines: increment when new lines arrive while scrolled up.
    // When at bottom, offset stays 0 and we don't increment (the user sees everything).
    if (!wasAtBottom) {
      this._unseenSinceLastView++;
    }
  }

  /** Append multiple rendered lines at once. */
  pushLines(lines: string[]): void {
    for (const line of lines) {
      this.push(line);
    }
  }

  /** Set the scroll offset. 0 = bottom (latest output). Clamped to valid range. */
  setViewportOffset(n: number): void {
    if (n < 0) n = 0;
    if (n > this.maxOffset) n = this.maxOffset;
    this.offset = n;
  }

  /** Get the maximum scroll offset. */
  get maxOffset(): number {
    return Math.max(0, this.lineCount - 1);
  }

  /** Get scroll position info. */
  getScrollInfo(): ScrollInfo {
    const totalLines = this.lineCount;
    const percent = totalLines > 1 ? Math.round((this.offset / (totalLines - 1)) * 100) : 0;
    return {
      offset: this.offset,
      totalLines,
      percent,
      isAtBottom: this.offset === 0,
      unseenSinceLastView: this._unseenSinceLastView,
    };
  }

  /** Number of lines pushed while scrolled up since the last scrollToBottom(). */
  get unseenSinceLastView(): number {
    return this._unseenSinceLastView;
  }

  /**
   * Returns the slice of lines visible in a viewport of the given height,
   * respecting the current scroll offset. offset=0 returns the most recent
   * lines (bottom of buffer). Increasing offset shows older lines.
   */
  getViewportSlice(viewportHeight: number): string[] {
    if (this.lineCount === 0) return [];
    const h = Math.max(1, viewportHeight);
    const available = Math.min(h, this.lineCount);
    // The most recent `available` lines from the bottom
    const endIdx = this.lineCount - this.offset;
    const startIdx = Math.max(0, endIdx - available);
    const result: string[] = [];
    for (let i = startIdx; i < endIdx; i++) {
      result.push(this.ring[i % this.capacity] ?? '');
    }
    return result;
  }

  /** Add `delta` lines to the current scroll offset (positive = scroll up/back). */
  scrollBy(delta: number): void {
    this.setViewportOffset(this.offset + delta);
  }

  /** Scroll to bottom (live view). Resets the unseen line counter. */
  scrollToBottom(): void {
    this.offset = 0;
    this._unseenSinceLastView = 0;
  }

  /** Reset buffer and scroll position. */
  reset(): void {
    this.ring = new Array(this.capacity);
    this.offset = 0;
    this.lineCount = 0;
    this.writeIndex = 0;
    this.currentBytes = 0;
    this._unseenSinceLastView = 0;
  }

  /** Current approximate memory usage in bytes. */
  get byteSize(): number {
    return this.currentBytes;
  }

  /** Total number of lines currently stored. */
  get totalLines(): number {
    return this.lineCount;
  }
}
