/**
 * RendererPaneAdapter — adapts a standalone renderer to fit inside a Pane.
 *
 * Standalone renderers like ConversationalRenderer and WaterfallRenderer
 * write directly to OutputBuffer/logUpdate.  This adapter intercepts their
 * output and buffers rendered lines, then writes them clipped to the pane's
 * region dimensions when the pane renders.
 *
 * Architecture:
 *   - Buffers lines from a renderer's write calls
 *   - On pane.render(region), writes buffered lines clipped to region bounds
 *   - On resize, reflows content at new width (if the renderer supports it)
 *   - Respects the region's scroll position via a simple internal scroll offset
 *
 * @module rendererPaneAdapter
 */

import type { LayoutRegion } from './layout.js';
import { OutputBuffer } from './outputBuffer.js';

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface RendererPaneAdapterOptions {
  /** Maximum number of lines to buffer. */
  maxBufferLines?: number;
  /** Whether to auto-scroll to bottom on new content. */
  autoScroll?: boolean;
}

// ─── RendererPaneAdapter ──────────────────────────────────────────────────────

export class RendererPaneAdapter {
  /** Buffered lines of rendered content. */
  private _buffer: string[] = [];

  /** Current scroll offset (0 = bottom/latest content). */
  private _scrollOffset: number = 0;

  /** Maximum number of lines to retain in the buffer. */
  private _maxBufferLines: number;

  /** Whether to auto-scroll to bottom on new content. */
  private _autoScroll: boolean;

  /** The pane ID this adapter is associated with (for OutputBuffer rendering). */
  private _paneId: string;

  constructor(paneId: string, options: RendererPaneAdapterOptions = {}) {
    this._paneId = paneId;
    this._maxBufferLines = options.maxBufferLines ?? 5000;
    this._autoScroll = options.autoScroll ?? true;
  }

  // ── Public API ────────────────────────────────────────────────

  /**
   * Write content to the buffer (called by the adapted renderer).
   * Splits multi-line strings into individual buffer lines.
   */
  write(text: string): void {
    if (!text) return;
    const lines = text.split('\n');
    for (const line of lines) {
      this._buffer.push(line);
    }

    // Enforce max buffer size
    while (this._buffer.length > this._maxBufferLines) {
      this._buffer.shift();
    }

    // Auto-scroll to bottom if enabled
    if (this._autoScroll) {
      this._scrollOffset = 0;
    }
  }

  /**
   * Write a single line to the buffer.
   */
  writeLine(line: string): void {
    this._buffer.push(line);

    while (this._buffer.length > this._maxBufferLines) {
      this._buffer.shift();
    }

    if (this._autoScroll) {
      this._scrollOffset = 0;
    }
  }

  /**
   * Get the current buffered content as a single string.
   */
  getContent(): string {
    return this._buffer.join('\n');
  }

  /**
   * Get buffered lines (slice for rendering).
   */
  getLines(): readonly string[] {
    return this._buffer;
  }

  /**
   * Clear all buffered content.
   */
  clear(): void {
    this._buffer = [];
    this._scrollOffset = 0;
  }

  /**
   * Get the number of buffered lines.
   */
  get lineCount(): number {
    return this._buffer.length;
  }

  // ── Scroll Management ─────────────────────────────────────────

  /** Scroll up by `lines` rows (showing older content). */
  scrollUp(lines: number): void {
    this._scrollOffset = Math.min(
      this._scrollOffset + lines,
      Math.max(0, this._buffer.length - 1),
    );
  }

  /** Scroll down by `lines` rows (showing newer content). */
  scrollDown(lines: number): void {
    this._scrollOffset = Math.max(0, this._scrollOffset - lines);
  }

  /** Scroll to the top (oldest content). */
  scrollToTop(): void {
    this._scrollOffset = Math.max(0, this._buffer.length - 1);
  }

  /** Scroll to the bottom (newest content). */
  scrollToBottom(): void {
    this._scrollOffset = 0;
  }

  /** Get current scroll offset. */
  get scrollOffset(): number {
    return this._scrollOffset;
  }

  // ── Rendering ─────────────────────────────────────────────────

  /**
   * Render buffered lines clipped to the given region.
   * This is called by the Pane content function.
   *
   * @param region - The pane's assigned region
   * @returns String of rendered content (lines joined with newlines)
   */
  render(region: LayoutRegion): string {
    return this.renderToRegion(region);
  }

  /**
   * Render buffered lines directly to the OutputBuffer at the given region.
   * Useful when the adapter is used without a Pane.
   *
   * @param region - The region to render into
   * @param buf - The OutputBuffer instance
   */
  renderToBuffer(region: LayoutRegion, buf: OutputBuffer): void {
    const result = this.renderToRegion(region);
    const lines = result.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const row = region.row + i;
      if (row > region.row + region.height - 1) break;
      buf.writeLine(row, region.col, lines[i]!);
    }
  }

  /**
   * Reflow buffered content at a new width.
   * This is a no-op for simple line buffers — subclasses with wrapping
   * support can override.
   */
  reflow(_newWidth: number): void {
    // Base implementation: no reflow logic
    // Subclasses can override to re-wrap lines at the new width
  }

  // ── Private ───────────────────────────────────────────────────

  /**
   * Build a string from buffered lines, clipped to the region dimensions
   * and offset by the current scroll position.
   */
  private renderToRegion(region: LayoutRegion): string {
    if (this._buffer.length === 0) {
      return ' '.repeat(region.width);
    }

    const regionHeight = region.height;
    const regionWidth = region.width;

    // Determine visible slice of the buffer
    const totalLines = this._buffer.length;
    const scrollOffset = Math.min(this._scrollOffset, Math.max(0, totalLines - 1));

    // Start from the end, offset by scrollOffset, go back regionHeight lines
    const endIdx = totalLines - scrollOffset;
    const startIdx = Math.max(0, endIdx - regionHeight);

    const visibleLines: string[] = [];
    for (let i = startIdx; i < endIdx; i++) {
      const rawLine = this._buffer[i] ?? '';
      // Truncate or pad to region width
      if (rawLine.length >= regionWidth) {
        visibleLines.push(rawLine.slice(0, Math.max(0, regionWidth - 1)) + '…');
      } else {
        visibleLines.push(rawLine + ' '.repeat(regionWidth - rawLine.length));
      }
    }

    // Pad if we have fewer lines than region height
    while (visibleLines.length < regionHeight) {
      visibleLines.push(' '.repeat(regionWidth));
    }

    return visibleLines.join('\n');
  }
}
