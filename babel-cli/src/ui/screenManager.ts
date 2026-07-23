/**
 * ScreenManager — manages the terminal screen layout during conversational
 * agent sessions. Divides the alternate screen into three zones:
 *
 *   Row 1:         Top bar (model · mode · project)
 *   Rows 2..N-2:   Content area (scrollable agent conversation)
 *   Row N-1:        Bottom stats (elapsed · cost · tokens)
 *   Row N:          Input prompt
 *
 * Uses ANSI scroll regions so output in the content area scrolls within
 * bounds, leaving the top bar and bottom area fixed.
 *
 * All terminal output is routed through OutputBuffer for DEC 2026
 * synchronized update support and unified error handling.
 */

import { muted, dim, accent, getTerminalWidth, truncate, wrapText, headerBg } from './theme.js';
import { FrameScheduler } from './frameScheduler.js';
import { renderCompactTokenBar, getContextLimit } from './tokenBar.js';
import { ScrollbackBuffer } from './scrollback.js';
import { OutputBuffer } from './outputBuffer.js';
import { shouldAvoidAltScreen } from './a11y.js';
import { getGlobalRateLimitState, renderCompactRateLimit } from './rateLimitWidget.js';
import { renderUnseenDividerPill } from './unseenDivider.js';
import { PaneManager } from './paneManager.js';
import type { HistoryCellViewport } from './historyCells/viewport.js';

export interface ScreenState {
  model: string;
  /** Active model ID for context limit lookup (e.g. "deepseek-v4-pro") */
  modelId?: string;
  mode: string;
  project: string;
  totalTokens: number;
  totalCost: number;
  turnCount: number;
}

export class ScreenManager {
  private rows: number;
  private cols: number;
  private contentTop: number;
  private contentBottom: number;
  private statsRow: number;
  private inputRow: number;
  private unregisterStats: (() => void) | null = null;
  private state: ScreenState;
  private liveElapsedMs = 0;
  private liveTokens = 0;
  private liveCost = 0;
  private liveStartTime = 0;
  private buffer: ScrollbackBuffer;
  private lastReflowTime = 0;
  private scrollOffset: number = 0;
  private _unseenLineCount: number = 0;
  private statusFormat: string;
  /** Cache of last-written content lines keyed by row index, used to skip
   *  unchanged lines during reflow for faster resize response. */
  private _lastWrittenLines: Map<number, string> = new Map();
  private static readonly REFLOW_DEBOUNCE_MS = 100;
  /** When set, content area renders from cell viewport (B4) instead of scrollback slice. */
  private cellViewport: HistoryCellViewport | null = null;

  /** Default status line format string. */
  static readonly DEFAULT_STATUS_FORMAT = '{elapsed} · {cost} · {tokens}';

  constructor(initialState: ScreenState, statusFormat?: string) {
    this.state = { ...initialState };
    this.rows = process.stdout.rows || 24;
    this.cols = process.stdout.columns || 80;
    this.contentTop = 2;
    this.contentBottom = this.rows - 2; // leaves rows N-1 (stats) and N (input)
    this.statsRow = this.rows - 1;
    this.inputRow = this.rows;
    this.buffer = new ScrollbackBuffer(10000, 10 * 1024 * 1024); // 10K lines, 10 MB
    this.statusFormat =
      statusFormat ?? process.env['BABEL_STATUS_FORMAT'] ?? ScreenManager.DEFAULT_STATUS_FORMAT;
  }

  /** Attach a HistoryCellViewport for O(viewport) transcript painting (B4). */
  attachHistoryCellViewport(viewport: HistoryCellViewport | null): void {
    this.cellViewport = viewport;
    if (viewport) {
      viewport.setScrollOffset(this.scrollOffset);
    }
  }

  /** Attached cell viewport, when ConversationalRenderer is active (B4/B5). */
  getHistoryCellViewport(): HistoryCellViewport | null {
    return this.cellViewport;
  }

  /** Content-area row count (between top bar and stats line). */
  getContentHeight(): number {
    return Math.max(0, this.contentBottom - this.contentTop + 1);
  }

  /** Set the scroll offset (lines scrolled above the viewport). */
  setScrollOffset(offset: number): void {
    this.scrollOffset = Math.max(0, offset);
    if (this.scrollOffset === 0) {
      this._unseenLineCount = 0;
      this.cellViewport?.scrollToBottom();
    } else {
      this.cellViewport?.setScrollOffset(this.scrollOffset);
    }
    this.renderContentArea();
    this.drawBottomStats();
  }

  /** Get the current scroll offset. */
  getScrollOffset(): number {
    return this.scrollOffset;
  }

  /** Return to the live view (bottom of content). */
  scrollToBottom(): void {
    this.setScrollOffset(0);
  }

  /**
   * Increment the unseen-line counter. Called when new content arrives
   * while the user is scrolled above the bottom.
   */
  incrementUnseenCount(n: number): void {
    if (this.scrollOffset > 0) {
      this._unseenLineCount += n;
    }
  }

  /** Number of unseen lines (content that arrived while scrolled up). */
  get unseenLineCount(): number {
    return this._unseenLineCount;
  }

  /** Initialize the layout. Call once at session start. */
  setup(): void {
    this.refreshDimensions();
    if (!shouldAvoidAltScreen()) {
      this.setScrollRegion();
      this.drawTopBar();
    }
    this.drawBottomStats();
    if (!shouldAvoidAltScreen()) {
      OutputBuffer.getInstance().moveCursor(this.contentTop, 1);
    }
  }

  /** Restore normal screen. Call on session exit. */
  teardown(): void {
    this.stopStatusUpdates();
    if (!shouldAvoidAltScreen()) {
      const buf = OutputBuffer.getInstance();
      buf.resetScrollRegion();
      buf.moveCursor(this.rows, 1);
      buf.write('\n');
    }
  }

  /** Write text to the content area and buffer it for reflow. */
  writeContent(text: string): void {
    if (!text) return;
    OutputBuffer.getInstance().write(text);

    // Invalidate the per-row cache so the next reflowContent() doesn't
    // skip lines that have been overwritten by this write.
    this._lastWrittenLines.clear();

    // Split into individual lines and store in scrollback buffer for reflow.
    // text.split('\n') is safe for ANSI escape sequences because control
    // sequences never contain newline characters per ECMA-48.
    const lines = text.split('\n');
    for (const line of lines) {
      // Strip carriage returns that may be present in terminal output
      this.buffer.push(line.replace(/\r/g, ''));
    }
  }

  /** Update the top bar with current model/mode/project. */
  updateState(partial: Partial<ScreenState>): void {
    Object.assign(this.state, partial);
    this.drawTopBar();
    this.drawBottomStats();
  }

  /** Draw the top bar — model · mode · project only. */
  drawTopBar(): void {
    const left = `${this.state.model || 'auto'} · ${this.state.mode} · ${this.state.project || 'Workspace'}`;
    const truncatedLeft = truncate(left, this.cols - 2);
    const rightPad = ' '.repeat(Math.max(0, this.cols - truncatedLeft.length - 2));

    const buf = OutputBuffer.getInstance();
    const useSync = OutputBuffer.supportsSyncUpdate();
    if (useSync) buf.beginFrame();
    try {
      buf.write('\x1b[s');
      buf.write(`\x1b[1;1H${headerBg(` ${truncatedLeft}${rightPad} `)}`);
      buf.write(`\x1b[2;1H${dim('─'.repeat(this.cols))}`);
      buf.write('\x1b[u');
    } finally {
      if (useSync) buf.endFrame();
    }
  }

  /** Draw the bottom stats line (time · cost · tokens). */
  drawBottomStats(): void {
    const buf = OutputBuffer.getInstance();
    const useSync = OutputBuffer.supportsSyncUpdate();
    if (useSync) buf.beginFrame();
    try {
      this.drawBottomStatsInternal(
        formatElapsedShort(this.liveElapsedMs || 0),
        this.state.totalCost,
        this.state.totalTokens,
      );
    } finally {
      if (useSync) buf.endFrame();
    }
  }

  private drawBottomStatsInternal(elapsed: string, costDollars: number, tokens: number): void {
    const costStr = costDollars > 0 ? `$${costDollars.toFixed(4)}` : '$0.0000';
    const tokStr = tokens > 0 ? formatTokenCount(tokens) : '0 tok';

    // Build main status line from format string
    let line = `  ${this.interpolateFormat(elapsed, costStr, tokStr)}`;

    // Scroll position indicator — prepend when scrolled above viewport
    if (this.scrollOffset > 0) {
      const indicator = muted(` ↑ ${this.scrollOffset} lines above `);
      line = indicator + ' · ' + line;
    }

    // Token context bar — show when model context limit is known
    let tokenBarStr = '';
    if (this.state.modelId && tokens > 0) {
      const limit = getContextLimit(this.state.modelId);
      const barWidth = Math.min(14, Math.floor(this.cols / 6));
      tokenBarStr = `  ${renderCompactTokenBar(tokens, limit.tokens, barWidth)}`;
    }

    // Rate limit widget
    const rlWidget = renderCompactRateLimit(getGlobalRateLimitState());

    const buf = OutputBuffer.getInstance();
    buf.write('\x1b[s');
    buf.writeLine(this.statsRow, 1, `${line}${tokenBarStr}${rlWidget ? `  ${rlWidget}` : ''}`);
    // Clear the input prompt line (it will be redrawn by the REPL)
    buf.write(`\x1b[${this.inputRow};1H\x1b[K`);

    // Unseen divider pill — rendered above the content area when
    // new content arrived while the user was scrolled up.
    if (this.scrollOffset > 0) {
      const unseenCount =
        this.cellViewport?.getScrollInfo().unseenSinceLastView ?? this._unseenLineCount;
      const unseen = renderUnseenDividerPill(unseenCount);
      if (unseen) {
        // Render the pill just above the stats line (contentBottom row)
        buf.writeLine(this.contentBottom, 1, unseen);
      } else {
        // Fall back to the old "more lines" indicator when no unseen count
        buf.writeLine(this.contentTop, 1, dim('↑ ' + this.scrollOffset + ' more lines ↑'));
      }
    }

    buf.write('\x1b[u');
  }

  /** Start live updates of the bottom stats during execution. */
  startLiveUpdates(startCost: number = 0): void {
    this.liveStartTime = Date.now();
    this.liveCost = startCost;
    this.liveTokens = this.state.totalTokens;
    this.stopStatusUpdates();

    const scheduler = FrameScheduler.getInstance();
    this.unregisterStats = scheduler.scheduleComponent(
      'screen-stats',
      () => {
        this.liveElapsedMs = Date.now() - this.liveStartTime;
        this.drawBottomStatsInternal(
          formatElapsedShort(this.liveElapsedMs),
          this.liveCost,
          this.liveTokens,
        );
      },
      { priority: 15, intervalMs: 250, label: 'screen-stats' },
    );
    scheduler.setComponentPermanentDirty('screen-stats', true);
  }

  /** Stop live updates. */
  stopStatusUpdates(): void {
    if (this.unregisterStats) {
      FrameScheduler.getInstance().setComponentPermanentDirty('screen-stats', false);
      this.unregisterStats();
      this.unregisterStats = null;
    }
  }

  /** Set ANSI scroll region to content area only. No-op in a11y mode. */
  private setScrollRegion(): void {
    if (shouldAvoidAltScreen()) return;
    OutputBuffer.getInstance().setScrollRegion(this.contentTop, this.contentBottom);
  }

  /** Refresh terminal dimensions after resize, reflow content, and redraw. */
  refreshDimensions(): void {
    this.rows = process.stdout.rows || 24;
    this.cols = process.stdout.columns || 80;
    this.contentBottom = this.rows - 2;
    this.statsRow = this.rows - 1;
    this.inputRow = this.rows;
    this.reflowContent();
    this.setScrollRegion();
    this.drawTopBar();
    this.drawBottomStats();
    PaneManager.instance.onTerminalResize(this.rows, this.cols);
  }

  /** Paint the content area from the attached cell viewport or scrollback buffer. */
  renderContentArea(): void {
    const contentHeight = this.getContentHeight();
    if (contentHeight <= 0) return;

    if (this.cellViewport) {
      this.cellViewport.setWidth(this.cols);
      this.cellViewport.setScrollOffset(this.scrollOffset);
      const visible = this.cellViewport.getVisibleRows(contentHeight);
      this.renderContentLines(visible);
      return;
    }

    this.reflowFromScrollback();
  }

  /** Write visible lines into the content scroll region. */
  renderContentLines(visibleLines: string[]): void {
    const contentHeight = this.getContentHeight();
    if (contentHeight <= 0) return;

    const padded: string[] = [];
    for (let i = 0; i < contentHeight; i++) {
      padded.push(visibleLines[i] ?? '');
    }

    const buf = OutputBuffer.getInstance();
    const useSync = OutputBuffer.supportsSyncUpdate();
    if (useSync) buf.beginFrame();
    try {
      for (let i = 0; i < contentHeight; i++) {
        const row = this.contentTop + i;
        const line = padded[i] ?? '';
        if (line !== this._lastWrittenLines.get(row)) {
          buf.writeLine(row, 1, line);
          this._lastWrittenLines.set(row, line);
        }
      }
    } finally {
      if (useSync) buf.endFrame();
    }
  }

  /** Re-wrap only the visible content at the new terminal width — O(viewport) not O(N). */
  private reflowContent(): void {
    if (Date.now() - this.lastReflowTime < ScreenManager.REFLOW_DEBOUNCE_MS) return;
    this.lastReflowTime = Date.now();
    this.renderContentArea();
  }

  private reflowFromScrollback(): void {
    const contentHeight = this.getContentHeight();
    if (contentHeight <= 0) return;

    const rawLines = this.buffer.getViewportSlice(contentHeight);
    if (rawLines.length === 0) {
      this.renderContentLines([]);
      return;
    }

    const reflowed: string[] = [];
    for (const raw of rawLines) {
      const wrapped = wrapText(raw, this.cols);
      for (const line of wrapped) {
        reflowed.push(line);
      }
    }

    const visible = reflowed.slice(-contentHeight);
    this.renderContentLines(visible);
  }

  /** Expose the scrollback buffer so callers can read or replay history. */
  getScrollback(): ScrollbackBuffer {
    return this.buffer;
  }

  /**
   * Interpolate tokens in the status format string.
   *
   * Supported tokens:
   *   {model}   — model name (e.g. "deepseek-v4-pro")
   *   {mode}    — session mode (e.g. "chat")
   *   {project} — project name (e.g. "Babel")
   *   {elapsed} — elapsed time string (e.g. "1:23")
   *   {cost}    — cost string (e.g. "$0.1234")
   *   {tokens}  — token count string (e.g. "12.3k tok")
   *   {turn}    — turn count
   *
   * Text between tokens is preserved verbatim and styled with muted().
   * Token values are styled with dim() for numeric/identity fields.
   */
  private interpolateFormat(elapsed: string, costStr: string, tokStr: string): string {
    const tokens: Record<string, string> = {
      model: this.state.model || 'auto',
      mode: this.state.mode || 'chat',
      project: this.state.project || 'Workspace',
      elapsed,
      cost: costStr,
      tokens: tokStr,
      turn: String(this.state.turnCount || 0),
    };

    // Split format string into literal segments and token placeholders
    let result = '';
    let remaining = this.statusFormat;
    while (remaining.length > 0) {
      const open = remaining.indexOf('{');
      if (open === -1) {
        // No more tokens — remainder is literal text
        result += muted(remaining);
        break;
      }

      // Text before the {
      if (open > 0) {
        result += muted(remaining.slice(0, open));
      }

      const close = remaining.indexOf('}', open);
      if (close === -1) {
        // Malformed: no closing brace — treat rest as literal
        result += muted(remaining.slice(open));
        break;
      }

      const tokenName = remaining.slice(open + 1, close);
      const replacement = tokens[tokenName];
      if (replacement !== undefined) {
        result += dim(replacement);
      } else {
        // Unknown token — include verbatim
        result += muted(`{${tokenName}}`);
      }

      remaining = remaining.slice(close + 1);
    }

    return result;
  }
}

function formatElapsedShort(ms: number): string {
  if (ms < 1000) return '0:00';
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M tok`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k tok`;
  return `${n} tok`;
}
