/**
 * Full-screen scrollback pager ("/scrollback"). Provides `less`-like
 * navigation through the ScrollbackBuffer via raw-mode stdin on the
 * alternate screen. Restores terminal state exactly on exit.
 *
 * Extends Component for lifecycle (mount/unmount), dirty tracking, and
 * focus management. Routes all output through OutputBuffer for DEC 2026
 * synchronized update support.
 *
 * Key bindings: ↑/↓/j/k=scroll  PgUp/PgDn/Ctrl+U/Ctrl+D=half-page
 * Home/gg=top  End/G=bottom  /=search  n/N=cycle  q/Esc/Ctrl+C=quit
 * Mouse wheel scrolls 3 lines.
 *
 * @module pagerOverlay
 */

import { Component } from './component.js';
import { HistoryCellViewport } from './historyCells/viewport.js';
import { TranscriptSearchIndex } from './historyCells/transcriptSearch.js';
import { ScrollbackBuffer, type ScrollInfo } from './scrollback.js';
import { parseKeypress, type KeyEvent } from './keyInput.js';
import { KeybindingManager } from './keybindings.js';
import { stripAnsi, truncate, bgAccent } from './theme.js';
import { OutputBuffer } from './outputBuffer.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const SGR_WHEEL_UP = 64;
const SGR_WHEEL_DOWN = 65;
const WHEEL_SCROLL_LINES = 3;
const MIN_ROWS = 4;

// ─── PagerOverlay ─────────────────────────────────────────────────────────────

export class PagerOverlay extends Component {
  /**
   * Open the pager overlay with the given scrollback buffer.
   * Returns when the user quits (q, Esc, Ctrl+C).
   * Restores the terminal to its exact state before returning.
   */
  static async show(buffer: ScrollbackBuffer): Promise<void> {
    const pager = new PagerOverlay(buffer);
    await pager.run();
  }

  /**
   * Open the pager over a HistoryCellViewport with a warm search index (B5).
   * Pre-warms search rows on open for fast `/` queries.
   */
  static async showFromViewport(viewport: HistoryCellViewport): Promise<void> {
    const pager = new PagerOverlay(null, viewport);
    await pager.run();
  }

  private buffer: ScrollbackBuffer | null;
  private viewport: HistoryCellViewport | null;
  private searchIndex: TranscriptSearchIndex | null;
  private viewportHeight = 0;
  private cols = 80;
  private searchPending = false;
  private searchQuery = '';
  private matches: number[] = [];
  private currentMatchIdx = -1;
  private cleanupFns: Array<() => void> = [];
  private rowCount = 24;
  private ggArmed = false;
  private ggArmedTimer: ReturnType<typeof setTimeout> | null = null;
  private resolvePromise: (() => void) | null = null;
  private wasRaw = false;

  constructor(buffer: ScrollbackBuffer | null, viewport: HistoryCellViewport | null = null) {
    super();
    this.buffer = buffer;
    this.viewport = viewport;
    this.searchIndex = viewport ? viewport.getSearchIndex() : null;
    if (viewport) {
      viewport.warmSearchIndex();
    }
    this.updateDimensions();
  }

  /** Refresh terminal dimensions. Called on init and resize. */
  private updateDimensions(): void {
    this.rowCount = Math.max(MIN_ROWS, process.stdout.rows || 24);
    this.viewportHeight = this.rowCount - 1;
    this.cols = process.stdout.columns || 80;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  override onMount(): void {
    const stdin = process.stdin;
    this.wasRaw = stdin.isRaw ?? false;

    // Enter alternate screen, hide cursor, enable mouse
    const buf = OutputBuffer.getInstance();
    buf.write('\x1b[?1049h\x1b[?25l\x1b[?1000h');

    stdin.setRawMode(true);

    const onResize = (): void => {
      this.updateDimensions();
      this.markDirty();
      this.renderToScreen();
    };
    process.stdout.on('resize', onResize);
    this.cleanupFns.push(() => process.stdout.off('resize', onResize));
  }

  override onUnmount(): void {
    if (this.ggArmedTimer !== null) {
      clearTimeout(this.ggArmedTimer);
      this.ggArmedTimer = null;
    }
    for (const fn of this.cleanupFns) fn();
    this.cleanupFns = [];

    const buf = OutputBuffer.getInstance();
    buf.write('\x1b[?1000l\x1b[?25h\x1b[?1049l');

    const stdin = process.stdin;
    if (stdin.isTTY) {
      try {
        if (stdin.isRaw !== this.wasRaw) {
          stdin.setRawMode(this.wasRaw);
        }
      } catch {
        /* ignore */
      }
    }
  }

  // ── Component overrides ────────────────────────────────────────────────────

  override render(): string {
    // The pager renders directly via renderToScreen() for full-screen control.
    // This returns a description for debugging/tree inspection.
    const total = this.viewport?.totalRowCount ?? this.buffer?.totalLines ?? 0;
    return `[PagerOverlay: ${total} lines]`;
  }

  override handleKey(event: KeyEvent): boolean {
    // Handled via raw-mode Buffer listener, not key events
    return false;
  }

  // ── Run loop ───────────────────────────────────────────────────────────────

  private async run(): Promise<void> {
    const stdin = process.stdin;

    // Mount triggers alternate screen + raw mode
    this.mounted = true;
    this.onMount();

    try {
      await new Promise<void>((resolve) => {
        this.resolvePromise = resolve;

        const onData = (data: Buffer): void => {
          if (this.tryConsumeMouse(data)) return;
          const event = parseKeypress(data);
          if (event === null) return;
          this.handleKeyInternal(event);
        };
        stdin.on('data', onData);
        this.cleanupFns.push(() => stdin.off('data', onData));

        this.renderToScreen();
      });
    } finally {
      this.mounted = false;
      this.onUnmount();
    }
  }

  /** Try to consume an SGR or legacy mouse sequence. Returns true if handled. */
  private tryConsumeMouse(data: Buffer): boolean {
    if (data.length >= 6 && data[0] === 0x1b && data[1] === 0x5b && data[2] === 0x3c) {
      this.handleSgrMouse(data);
      return true;
    }
    if (data.length >= 6 && data[0] === 0x1b && data[1] === 0x4d) {
      this.handleLegacyMouse(data);
      return true;
    }
    return false;
  }

  // ── Key handling ──────────────────────────────────────────────────────────

  private handleKeyInternal(event: KeyEvent): void {
    const bindings = KeybindingManager.getInstance();
    const resolve = this.resolvePromise!;

    // ── Search input mode ───────────────────────────────────────────────
    if (this.searchPending) {
      this.handleSearchInput(event);
      return;
    }

    // ── Look up binding ─────────────────────────────────────────────────
    const action = bindings.match('pager', event);

    // ── Quit / dismiss ──────────────────────────────────────────────────
    if (action === 'quit') {
      resolve();
      return;
    }

    // ── Start search ───────────────────────────────────────────────────
    if (action === 'search') {
      this.searchPending = true;
      this.searchQuery = '';
      this.renderToScreen();
      return;
    }

    // ── "gg" chord: first g arms, second g jumps to top ────────────────
    // This is a chord, not a simple binding — preserve custom logic
    if (event.name === 'g' && !event.ctrl && !event.meta && !event.shift) {
      if (this.ggArmed) {
        if (this.ggArmedTimer !== null) {
          clearTimeout(this.ggArmedTimer);
          this.ggArmedTimer = null;
        }
        this.ggArmed = false;
        this.jumpToTop();
        this.renderToScreen();
        return;
      }
      this.ggArmed = true;
      this.ggArmedTimer = setTimeout(() => {
        this.ggArmed = false;
        this.ggArmedTimer = null;
      }, 500);
      return;
    }
    if (this.ggArmedTimer !== null) {
      clearTimeout(this.ggArmedTimer);
      this.ggArmedTimer = null;
    }
    this.ggArmed = false;

    // ── Navigation actions ──────────────────────────────────────────────
    switch (action) {
      case 'scroll_up':
        this.scrollBy(-1);
        break;
      case 'scroll_down':
        this.scrollBy(1);
        break;
      case 'page_up':
        this.scrollBy(-Math.floor(this.viewportHeight / 2));
        break;
      case 'page_down':
        this.scrollBy(Math.floor(this.viewportHeight / 2));
        break;
      case 'top':
        this.jumpToTop();
        break;
      case 'bottom':
        this.jumpToBottom();
        break;
    }

    // ── Search result navigation ───────────────────────────────────────
    if (this.matches.length > 0) {
      if (action === 'search_next') {
        this.cycleMatch(1);
      } else if (action === 'search_prev') {
        this.cycleMatch(-1);
      }
    }

    this.renderToScreen();
  }

  /** Handle keystrokes while entering a search query. */
  private handleSearchInput(event: KeyEvent): void {
    const { name, ctrl } = event;

    // Commit search
    if (name === 'enter') {
      this.searchPending = false;
      this.performSearch();
      this.renderToScreen();
      return;
    }

    // Cancel search
    if (name === 'escape' || (name === 'c' && ctrl)) {
      this.searchPending = false;
      this.searchQuery = '';
      this.renderToScreen();
      return;
    }

    // Backspace
    if (name === 'backspace') {
      this.searchQuery = this.searchQuery.slice(0, -1);
      this.renderToScreen();
      return;
    }

    // Printable character
    if (event.sequence && event.sequence.length === 1 && event.sequence >= ' ') {
      this.searchQuery += event.sequence;
      this.renderToScreen();
    }
  }

  // ── Navigation ────────────────────────────────────────────────────────────

  private scrollBy(delta: number): void {
    if (this.viewport) {
      this.viewport.scrollBy(delta);
      return;
    }
    this.buffer?.scrollBy(delta);
  }

  private jumpToTop(): void {
    if (this.viewport) {
      this.viewport.setScrollOffset(this.viewport.maxScrollOffset);
      return;
    }
    this.buffer?.setViewportOffset(this.buffer.maxOffset);
  }

  private jumpToBottom(): void {
    if (this.viewport) {
      this.viewport.scrollToBottom();
      return;
    }
    this.buffer?.scrollToBottom();
  }

  /**
   * Search all buffered lines for the current query (case-insensitive).
   * Stores matching line indices and jumps to the first match.
   */
  private performSearch(): void {
    this.matches = [];
    this.currentMatchIdx = -1;

    const query = this.searchQuery;
    if (!query || query.length === 0) return;

    if (this.viewport && this.searchIndex) {
      if (!this.searchIndex.isWarm) {
        this.viewport.warmSearchIndex();
      }
      const results = this.viewport.search(query);
      this.matches = results.map((match) => match.rowIndex);
    } else if (this.buffer) {
      const queryLower = query.toLowerCase();
      const totalLines = this.buffer.totalLines;
      if (totalLines === 0) return;

      if (this.searchIndex?.isWarm) {
        this.matches = this.searchIndex.search(query).map((match) => match.rowIndex);
      } else {
        // Cold scan fallback for scrollback-only pager
        const savedOffset = this.buffer.getScrollInfo().offset;
        this.buffer.scrollToBottom();
        const allLines = this.buffer.getViewportSlice(totalLines);
        this.buffer.setViewportOffset(savedOffset);

        for (let i = 0; i < allLines.length; i++) {
          const stripped = stripAnsi(allLines[i] ?? '');
          if (stripped.toLowerCase().includes(queryLower)) {
            this.matches.push(i);
          }
        }
      }
    }

    if (this.matches.length > 0) {
      this.currentMatchIdx = 0;
      this.jumpToMatchLine(this.matches[0]!);
    }
  }

  /** Cycle to the next (direction=1) or previous (direction=-1) match. */
  private cycleMatch(direction: 1 | -1): void {
    if (this.matches.length === 0) return;
    const n = this.matches.length;
    this.currentMatchIdx = (((this.currentMatchIdx + direction) % n) + n) % n;
    const matchLine = this.matches[this.currentMatchIdx]!;
    this.jumpToMatchLine(matchLine);
  }

  /**
   * Scroll the buffer so the given logical line index (0 = oldest)
   * appears approximately in the middle of the viewport.
   */
  private jumpToMatchLine(matchLineIdx: number): void {
    const halfViewport = Math.floor(this.viewportHeight / 2);

    if (this.viewport) {
      const total = this.viewport.totalRowCount;
      if (total === 0) return;
      const targetOffset = Math.max(
        0,
        Math.min(this.viewport.maxScrollOffset, total - matchLineIdx - halfViewport),
      );
      this.viewport.setScrollOffset(targetOffset);
      return;
    }

    const total = this.buffer?.totalLines ?? 0;
    if (total === 0 || !this.buffer) return;
    const targetOffset = Math.max(
      0,
      Math.min(this.buffer.maxOffset, total - matchLineIdx - halfViewport),
    );
    this.buffer.setViewportOffset(targetOffset);
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  /** Full redraw: content area + status bar (or search prompt). */
  renderToScreen(): void {
    const rows = this.rowCount;
    const cols = this.cols;

    const lines = this.getContentLines();
    const info = this.getScrollInfo();

    const buf = OutputBuffer.getInstance();
    const useSync = OutputBuffer.supportsSyncUpdate();
    if (useSync) buf.beginFrame();
    try {
      // ── Content area ──────────────────────────────────────────────────
      for (let i = 0; i < this.viewportHeight; i++) {
        const rawLine = lines[i] ?? '';
        const line = this.truncateToCols(rawLine, cols);

        // Apply search match highlighting
        let display: string;
        if (this.matches.length > 0 && this.searchQuery) {
          const startInclusive = Math.max(0, info.totalLines - info.offset - this.viewportHeight);
          const absoluteLineIdx = startInclusive + i;
          display = this.applyMatchHighlight(line, absoluteLineIdx);
        } else {
          display = line;
        }

        buf.writeLine(i + 1, 1, display);
      }

      // Clear any unused content lines (when viewport > actual lines)
      for (let i = lines.length; i < this.viewportHeight; i++) {
        buf.writeLine(i + 1, 1, '');
      }

      // ── Status bar / search prompt ────────────────────────────────────
      if (this.searchPending) {
        this.renderSearchPrompt(rows, cols);
      } else {
        this.renderStatusBar(info, rows, cols);
      }
    } finally {
      if (useSync) buf.endFrame();
    }
  }

  private getContentLines(): string[] {
    if (this.viewport) {
      return this.viewport.getVisibleRows(this.viewportHeight);
    }
    return this.buffer?.getViewportSlice(this.viewportHeight) ?? [];
  }

  private getScrollInfo(): ScrollInfo {
    if (this.viewport) {
      const info = this.viewport.getScrollInfo();
      const totalLines = info.totalRows;
      const offset = info.offset;
      const percent =
        totalLines > 1 ? Math.round((offset / (totalLines - 1)) * 100) : 0;
      return {
        offset,
        totalLines,
        percent,
        isAtBottom: info.isAtBottom,
        unseenSinceLastView: info.unseenSinceLastView,
      };
    }
    return (
      this.buffer?.getScrollInfo() ?? {
        offset: 0,
        totalLines: 0,
        percent: 0,
        isAtBottom: true,
        unseenSinceLastView: 0,
      }
    );
  }

  /** Truncate a possibly-ANSI string to fit within the given column width. */
  private truncateToCols(text: string, cols: number): string {
    if (cols <= 0) return '';
    const visible = stripAnsi(text);
    if (visible.length <= cols) return text;
    return truncate(text, cols);
  }

  /** Render the bottom status bar with scroll position and key hints. */
  private renderStatusBar(info: ScrollInfo, rows: number, cols: number): void {
    const total = info.totalLines;

    if (total === 0) {
      const msg = '(empty scrollback buffer)';
      const padded = msg + ' '.repeat(Math.max(0, cols - 2 - msg.length));
      OutputBuffer.getInstance().writeLine(rows, 1, bgAccent(` ${padded} `));
      return;
    }

    // Compute visible line range (1-indexed for display)
    const endIdx = total - info.offset;
    const startIdx = Math.max(0, endIdx - this.viewportHeight);
    const firstDisplay = startIdx + 1;
    const lastDisplay = endIdx;

    const pct = info.percent;

    // Build match info suffix
    let matchInfo = '';
    if (this.matches.length > 0 && this.searchQuery) {
      matchInfo = `  n/N (${this.currentMatchIdx + 1}/${this.matches.length})`;
    }

    const status = `lines ${firstDisplay}-${lastDisplay}/${total} (${pct}%) | ↑↓ scroll  / search${matchInfo}  q quit`;
    const truncatedStatus = status.length <= cols - 2 ? status : status.slice(0, cols - 5) + '…';
    const padded =
      truncatedStatus + ' '.repeat(Math.max(0, cols - 2 - stripAnsi(truncatedStatus).length));

    const buf = OutputBuffer.getInstance();
    buf.writeLine(rows, 1, bgAccent(` ${padded} `));
  }

  /** Render the search query prompt in the status bar. */
  private renderSearchPrompt(rows: number, cols: number): void {
    const prompt = `Search: ${this.searchQuery}█`;
    const truncated = prompt.length > cols - 2 ? '…' + prompt.slice(-(cols - 4)) : prompt;
    const padded = truncated + ' '.repeat(Math.max(0, cols - 2 - stripAnsi(truncated).length));

    const buf = OutputBuffer.getInstance();
    buf.writeLine(rows, 1, bgAccent(` ${padded} `));
  }

  /**
   * Apply search match highlighting to a single line.
   *
   * For the current active match, the entire line is shown with a yellow
   * background (reverse video on dark backgrounds). For other matching
   * lines, only the matched substring is highlighted in reverse video.
   *
   * Strips existing ANSI codes and re-renders with highlights, to avoid
   * complex ANSI-stack manipulation.
   */
  private applyMatchHighlight(line: string, absoluteLineIdx: number): string {
    const query = this.searchQuery;
    if (!query) return line;

    const stripped = stripAnsi(line);
    const textLower = stripped.toLowerCase();
    const queryLower = query.toLowerCase();
    const matchPos = textLower.indexOf(queryLower);

    if (matchPos === -1) return line; // No match on this line

    // Check if this line is the current active match
    const isCurrent =
      this.matches.length > 0 &&
      this.currentMatchIdx >= 0 &&
      this.matches[this.currentMatchIdx] === absoluteLineIdx;

    if (isCurrent) {
      // Full-line highlight for current match
      return `\x1b[43m\x1b[30m${stripped}\x1b[0m`;
    }

    // Highlight only the matching substring
    const before = stripped.slice(0, matchPos);
    const match = stripped.slice(matchPos, matchPos + query.length);
    const after = stripped.slice(matchPos + query.length);
    return `${before}\x1b[7m${match}\x1b[0m${after}`;
  }

  // ── Mouse handling ────────────────────────────────────────────────────────

  /** Parse SGR-encoded mouse events (ESC [ < Btn ; Y ; X M/m). */
  private handleSgrMouse(data: Buffer): void {
    const payload = data.slice(3);
    const str = payload.toString('utf8');
    const match = str.match(/^(-?\d+);(\d+);(\d+)([Mm])$/);
    if (!match) return;

    const button = Number.parseInt(match[1]!, 10);

    if (button === SGR_WHEEL_UP) {
      this.scrollBy(-WHEEL_SCROLL_LINES);
      this.renderToScreen();
    } else if (button === SGR_WHEEL_DOWN) {
      this.scrollBy(WHEEL_SCROLL_LINES);
      this.renderToScreen();
    }
  }

  /** Parse legacy X10 mouse events (ESC [ M Btn X Y). */
  private handleLegacyMouse(data: Buffer): void {
    if (data.length < 6) return;
    const btn = data[2]! - 32;

    if (btn === SGR_WHEEL_UP) {
      this.scrollBy(-WHEEL_SCROLL_LINES);
      this.renderToScreen();
    } else if (btn === SGR_WHEEL_DOWN) {
      this.scrollBy(WHEEL_SCROLL_LINES);
      this.renderToScreen();
    }
  }
}
