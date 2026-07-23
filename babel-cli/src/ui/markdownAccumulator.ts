/**
 * MarkdownAccumulator — incremental markdown renderer for streaming LLM output.
 *
 * Problem: The old approach called marked.lexer(fullText) on every streaming
 * chunk, re-parsing the entire conversation from scratch each time. As the
 * conversation grew, this became O(n²): N chunks each parsing O(N) accumulated
 * text. A later "reset and re-emit everything" transition on every newline
 * after mid-line streaming duplicated the full assistant message into the TTY
 * (see TUI-Output-Bug).
 *
 * Solution (3-phase):
 *   1. **Fast path**: If the incoming chunk contains no newlines, the chunk
 *      is just extending the current line — append raw text to the delta
 *      without re-lexing. This handles ~80% of streaming chunks.
 *   2. **Structural path**: On newline (or code-fence activity), re-render
 *      the full accumulated markdown via `renderFn`.
 *   3. **Common-prefix delta**: Compare the previously shown text to the new
 *      render line-by-line. Emit only:
 *        - a mid-line suffix, or
 *        - newly appended lines, or
 *        - a cursor-up + clear rewrite when earlier lines change (markdown
 *          reformatted raw `## Title` into a styled heading).
 *
 * Never clears the last shown snapshot to force a full re-append. That was
 * the root cause of interleaved/duplicated stream output.
 */

import { marked } from 'marked';
import { stripAnsi, supportsColor, visibleLength } from './theme.js';
import { getMotionMode, MotionMode, shimmerText } from './motion.js';
import { highlightWithTreeSitter, normalizeLanguage } from './treeSitterHighlight.js';
import { TableHoldbackScanner } from './tableHoldback.js';

const HAS_COLOR = supportsColor();

export class MarkdownAccumulator {
  private fullText = '';
  private lastRendered = '';
  private lastTotalLines = 0;

  /**
   * Tracks the last ANSI-rendered output produced by a structural-path
   * render. Used as the delta-comparison baseline so fast-path raw-text
   * doesn't trigger unnecessary Case 3 cursor-up rewrites.
   */
  private _lastStructuralAnsi = '';

  /**
   * True when the fast path has emitted shimmer text since the last
   * structural render.  The structural path clears the current terminal
   * line (`\r\x1b[K`) before emitting its delta so the shimmer text
   * doesn't duplicate the ANSI-rendered content.
   */
  private _fastPathSinceStructural = false;

  /**
   * Whether to apply shimmer to fast-path streaming deltas.
   *
   * Default OFF. Answer-stream deltas are appended permanently to the
   * terminal (and to two-region streaming buffers). Baking shimmer into
   * those deltas leaves dim/bold ANSI stuck in scrollback forever — the
   * "faded text every now and then" effect. Shimmer belongs on ephemeral
   * re-painted HUD chrome (thinking line), not committed answer text.
   */
  private shimmerEnabled = false;

  // ── Terminal geometry ──────────────────────────────────────────────────
  // NOTE: setViewportHeight / setTerminalWidth are only valid when the
  // accumulator is used in a TTY context (ConversationalRenderer).
  // Non-TTY users (AppendOnlyRenderer, snapshot tests) should NOT call them.
  private _viewportHeight = 24;
  private _terminalWidth = -1;

  // ── Table holdback ──────────────────────────────────────────────────────
  // When the rendered output ends with a line that looks like an incomplete
  // markdown table row or separator, that line is held back and only the
  // complete lines above it are emitted. Once a complete table is detected,
  // the held content is flushed.
  private _tableHeldLines = 0;

  /**
   * G3 — structural table holdback scanner (Codex-style).
   * While a pipe table is open (pending header or confirmed), the entire
   * table region is held so column-width reallocation does not reshuffle
   * already-emitted rows. Flushed when the table ends or finalize() runs.
   */
  private _tableScanner = new TableHoldbackScanner();
  /** Number of complete source lines already fed to _tableScanner. */
  private _scannerCompleteLines = 0;
  /** True while we are holding a full table region (not just a partial line). */
  private _adaptiveTableHold = false;

  // ── Fast-path tracking ─────────────────────────────────────────────────
  // Tracks whether the previous feed() call took the fast path (no-newline
  // chunk). Used to reset line-count tracking when transitioning to the
  // structural path, because the fast path accumulates raw text while the
  // structural path renders via renderFn which may produce ANSI-wrapped
  // output that differs from the plain-text line count.
  private _wasFastPath = false;

  /** Tracks whether we are inside a fenced code block and what language. */
  private _activeCodeBlockLanguage: string | null = null;

  /**
   * Scan fullText line-by-line to detect fenced code block boundaries.
   * Only called when chunk contains '`' or '~' (fast bail-out for 99% of chunks).
   * O(lines) per call, NOT O(n²) — avoids full-text split() on every feed().
   */
  private _updateCodeBlockLanguage(): void {
    const lines = this.fullText.split('\n');
    let inBlock = false;
    let blockLang: string | null = null;
    for (const line of lines) {
      const m = line.match(/^(```|~~~)(\w*)/);
      if (m) {
        const fence = m[1]!;
        const rest = line.slice(fence.length);
        if (inBlock && !rest.trim()) { inBlock = false; blockLang = null; }
        else if (!inBlock) { inBlock = true; blockLang = m[2] || null; }
      }
    }
    this._activeCodeBlockLanguage = inBlock ? blockLang : null;
  }

  // ── Shimmer control ──────────────────────────────────────────────────────

  /** Enable or disable shimmer on fast-path streaming output. */
  setShimmerEnabled(enabled: boolean): void {
    this.shimmerEnabled = enabled;
  }

  /** Whether shimmer is currently active. */
  get isShimmerEnabled(): boolean {
    return this.shimmerEnabled;
  }

  // ── Terminal geometry ──────────────────────────────────────────────────

  /**
   * Set the viewport height for cursor-up clamping.
   * NOTE: Only valid when the accumulator is used in a TTY context
   * (ConversationalRenderer). Non-TTY users (AppendOnlyRenderer,
   * snapshot tests) should not call this.
   */
  setViewportHeight(height: number): void {
    this._viewportHeight = height;
  }

  /**
   * Set the terminal width for table holdback and CJK-aware line counting.
   * NOTE: Only valid when the accumulator is used in a TTY context
   * (ConversationalRenderer). Non-TTY users (AppendOnlyRenderer,
   * snapshot tests) should not call this.
   */
  setTerminalWidth(width: number): void {
    this._terminalWidth = width;
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  /** Apply shimmer to plain-text delta, respecting motion mode. */
  private applyShimmer(text: string): string {
    if (!this.shimmerEnabled) return text;
    const mode = getMotionMode();
    return shimmerText(text, mode);
  }

  /** Count visual lines accounting for terminal-width wrapping
   *  using visibleLength() which handles CJK wide characters (2 columns)
   *  and ANSI escape sequences correctly. */
  private _countVisualLines(text: string): number {
    if (!text) return 0;
    const rawLines = text.split('\n');
    let count = 0;
    for (const line of rawLines) {
      const width = visibleLength(line);
      if (width === 0) {
        count += 1;
      } else {
        count += Math.max(1, Math.ceil(width / this._terminalWidth));
      }
    }
    return count;
  }

  /**
   * Normalize a code block language string to a form that tree-sitter
   * and highlightLine can understand. Returns '' for unknown/unmapped
   * languages.
   */
  private _normalizeCodeLang(raw: string | null): string {
    return normalizeLanguage(raw ?? '');
  }

  /**
   * Post-process a delta string to apply tree-sitter syntax highlighting
   * to code lines inside the active code block.
   *
   * When tree-sitter is unavailable or returns null for a line, the
   * original highlighted line is preserved (falling back to the regex
   * highlighting already applied by highlightLine).
   */
  private _highlightCodeBlockDelta(delta: string): string {
    if (!delta) return delta;
    const lang = this._activeCodeBlockLanguage;
    if (!lang) return delta;

    const tsLang = this._normalizeCodeLang(lang);
    if (!tsLang) return delta;

    const lines = delta.split('\n');
    const result = lines.map((line) => {
      if (/^\s*(```|~~~)/.test(line) || !line.trim()) return line;
      if (!line.startsWith('  ')) return line;
      const codeContent = line.slice(2);
      const plain = stripAnsi(codeContent);
      const tsResult = highlightWithTreeSitter(plain, tsLang);
      if (tsResult !== null) {
        return '  ' + tsResult;
      }
      return line;
    });

    return result.join('\n');
  }

  // ── Table holdback ──────────────────────────────────────────────────────

  /**
   * Check if the rendered output ends with an incomplete table row.
   */
  private _isHoldingTable(rendered: string): boolean {
    if (!rendered) return false;
    const lines = rendered.split('\n');
    if (lines.length === 0) return false;
    const lastLine = lines[lines.length - 1]!;
    if (!lastLine) return false;
    // Strip ANSI escape codes before testing — colored table cells would
    // otherwise break the regex (e.g., `\x1b[32m| cell |\x1b[0m`).
    const plain = stripAnsi(lastLine);
    return /^\|/.test(plain) && !/^\|.*\|$/.test(plain.trim());
  }

  /**
   * Advance the structural table scanner with any newly completed source lines.
   */
  private _advanceTableScanner(): void {
    const parts = this.fullText.split('\n');
    // split() yields a trailing empty string when fullText ends with \n;
    // complete line count is parts.length - 1 when trailing newline present,
    // else parts.length - 1 for the unfinished final segment.
    const completeCount = this.fullText.endsWith('\n')
      ? parts.length - 1
      : Math.max(0, parts.length - 1);

    while (this._scannerCompleteLines < completeCount) {
      const line = parts[this._scannerCompleteLines] ?? '';
      this._tableScanner.pushLine(line + '\n');
      this._scannerCompleteLines++;
    }
  }

  /**
   * Whether plain rendered line looks like a pipe-table row (post-render).
   */
  private _isRenderedTableLine(line: string): boolean {
    const plain = stripAnsi(line).trim();
    if (!plain) return false;
    // Box-drawing tables from renderMarkdown use │; raw pipes also count.
    return (
      (plain.includes('│') || plain.includes('|')) &&
      (plain.startsWith('|') ||
        plain.includes('┼') ||
        plain.includes('─') ||
        /^\S.*│/.test(plain))
    );
  }

  /**
   * Find the start index of the trailing contiguous table region in rendered lines.
   * Returns lines.length when no trailing table region is found.
   */
  private _trailingTableStart(lines: string[]): number {
    let i = lines.length - 1;
    // Skip trailing empty line
    if (i >= 0 && stripAnsi(lines[i] ?? '').trim() === '') i--;
    if (i < 0 || !this._isRenderedTableLine(lines[i] ?? '')) return lines.length;

    let start = i;
    while (start > 0 && this._isRenderedTableLine(lines[start - 1] ?? '')) {
      start--;
    }
    return start;
  }

  /**
   * Emit complete lines, holding back the last (incomplete) table line.
   * Only returns lines not previously emitted (never re-prints earlier rows).
   */
  private _flushHeldProgressive(rendered: string): string {
    const lines = rendered.split('\n');
    if (lines.length < 2) return '';
    const completeLines = lines.slice(0, -1);
    const prevHeld = this._tableHeldLines;
    const newComplete = completeLines.slice(prevHeld).join('\n');
    this.lastTotalLines = completeLines.length;
    this.lastRendered = completeLines.join('\n');
    this._lastStructuralAnsi = completeLines.join('\n');
    this._fastPathSinceStructural = false;
    this._tableHeldLines = completeLines.length;
    if (!newComplete) return '';
    // When prior complete rows were already written, separate the next row.
    return (prevHeld > 0 ? '\n' : '') + newComplete;
  }

  /**
   * Flush previously held table tail plus any newly completed rows.
   * Only emits the suffix not already shown by progressive holdback —
   * never re-prints the entire table (that caused duplicate table output).
   */
  private _flushHeldFinal(rendered: string): string {
    const lines = rendered.split('\n');
    const prevHeld = this._tableHeldLines;
    const deltaLines = lines.slice(prevHeld).join('\n');
    this.lastTotalLines = lines.length;
    this.lastRendered = rendered;
    this._lastStructuralAnsi = rendered;
    this._fastPathSinceStructural = false;
    this._tableHeldLines = 0;
    this._adaptiveTableHold = false;
    if (!deltaLines) return '';
    let out = (prevHeld > 0 ? '\n' : '') + deltaLines;
    if (!out.endsWith('\n')) out += '\n';
    return out;
  }

  /**
   * Count logical lines in a rendered string (split on `\n`).
   * Empty string → 0 lines (not 1).
   */
  private _logicalLineCount(text: string): number {
    if (!text) return 0;
    return text.split('\n').length;
  }

  /**
   * Compute the terminal write needed to go from `oldText` (already shown)
   * to `newText` (desired full render).
   *
   * Strategies, in order:
   *  1. Pure append of new full lines after an exact line-prefix match
   *  2. Mid-line extension: last shown line is a prefix of the new line at
   *     the same index (the common case after fast-path raw streaming)
   *  3. Rewrite: earlier content changed (markdown reformatted). Emit
   *     cursor-up + clear-to-end + new tail so the caller overwrites
   *     instead of appending a second copy of the message.
   *
   * This replaces the old "BUG FIX #3" which cleared lastRendered and
   * re-emitted the entire message on every fast→structural transition —
   * the root cause of duplicated/interleaved chat stream output.
   */
  private _computeRenderDelta(oldText: string, newText: string): string {
    if (!newText) return '';
    if (!oldText) return newText;
    if (oldText === newText) return '';

    const oldLines = oldText.split('\n');
    const newLines = newText.split('\n');

    // Longest common line prefix
    let common = 0;
    const minLen = Math.min(oldLines.length, newLines.length);
    while (common < minLen && oldLines[common] === newLines[common]) {
      common++;
    }

    // Case 1: every previously shown line still matches → pure append.
    // Use the line array (not join-then-check) so a newly gained trailing
    // newline — newLines ends with '' — still emits `\n` and advances the
    // cursor. Joining `['']` yields '' which previously dropped the write.
    if (common === oldLines.length) {
      const addedLines = newLines.slice(common);
      if (addedLines.length === 0) return '';
      return '\n' + addedLines.join('\n');
    }

    // Case 2: only the first differing line is a mid-line extension of the
    // previously shown line (fast-path raw suffix, then structural reconcile).
    const oldTail = oldLines[common] ?? '';
    const newTail = newLines[common] ?? '';
    if (newTail.startsWith(oldTail)) {
      const lineSuffix = newTail.slice(oldTail.length);
      const after = newLines.slice(common + 1);
      let result = lineSuffix;
      if (after.length > 0) {
        result += '\n' + after.join('\n');
      }
      return result;
    }

    // Case 3: earlier content diverged (markdown heading/list/table rewrite).
    // Cursor-up by the visual height of the discarded tail, clear, rewrite.
    const discarded = oldLines.slice(common).join('\n');
    const visualLines =
      this._terminalWidth > 0
        ? this._countVisualLines(discarded)
        : Math.max(1, oldLines.length - common);
    const replacement = newLines.slice(common).join('\n');
    if (visualLines <= 0) return replacement;
    return `\x1b[${visualLines}A\x1b[J${replacement}`;
  }

  /**
   * G3 — hold the entire trailing table region while the structural scanner
   * says the table is open. Emits only the stable prefix (content before the
   * table). When the table ends, flushes the full render once with final widths.
   */
  private _applyAdaptiveTableHold(rendered: string): string | null {
    const tableEnded = this._tableScanner.didTableEnd();
    const shouldHold = this._tableScanner.shouldHold();

    if (tableEnded) {
      // Flush full render with final column allocation; acknowledge end.
      this._tableScanner.acknowledgeTableEnd();
      this._adaptiveTableHold = false;
      this._tableHeldLines = 0;
      const delta = this._computeRenderDelta(this.lastRendered, rendered);
      this.lastRendered = rendered;
      this._lastStructuralAnsi = rendered;
      this.lastTotalLines = this._logicalLineCount(rendered);
      this._fastPathSinceStructural = false;
      return delta;
    }

    if (!shouldHold) {
      if (this._adaptiveTableHold) {
        // Was holding but scanner cleared without formal end — flush.
        this._adaptiveTableHold = false;
        return null; // fall through to normal path with full rendered
      }
      return null;
    }

    // Incomplete final source row → let classic progressive holdback handle it.
    if (this._isHoldingTable(rendered)) {
      return null;
    }

    // G3: only enter adaptive full-table hold once a body row expands a column
    // (real reshuffle risk). Until then, progressive row emit is correct and
    // matches existing incomplete-line holdback tests.
    const expanded = this._tableScanner.widthsExpandedSinceCheck();
    if (!expanded && !this._adaptiveTableHold) {
      return null;
    }

    // Hold open table: emit only stable prefix before trailing table region.
    this._adaptiveTableHold = true;

    const lines = rendered.split('\n');
    const tableStart = this._trailingTableStart(lines);
    if (tableStart >= lines.length) {
      return null;
    }

    const stableLines = lines.slice(0, tableStart);
    const stable = stableLines.join('\n');

    // Prefer common-prefix delta machinery so rewrites stay consistent with main.
    const delta = this._computeRenderDelta(this.lastRendered, stable);
    this.lastRendered = stable;
    this._lastStructuralAnsi = stable;
    this.lastTotalLines = this._logicalLineCount(stable);
    this._fastPathSinceStructural = false;
    this._tableHeldLines = 0;
    return delta;
  }

  /**
   * Force-flush any held adaptive table (e.g. stream end without blank line).
   * Returns delta to append, or '' if nothing held.
   */
  finalize(renderFn: (text: string) => string): string {
    if (!this.fullText) return '';
    if (!this._adaptiveTableHold && this._tableHeldLines === 0 && !this._tableScanner.shouldHold()) {
      return '';
    }
    const rendered = renderFn(this.fullText);
    this._tableScanner.acknowledgeTableEnd();
    this._adaptiveTableHold = false;
    this._tableHeldLines = 0;

    if (rendered === this.lastRendered) return '';
    const delta = this._computeRenderDelta(this.lastRendered, rendered);
    this.lastRendered = rendered;
    this._lastStructuralAnsi = rendered;
    this.lastTotalLines = this._logicalLineCount(rendered);
    this._fastPathSinceStructural = false;
    return delta;
  }

  /**
   * Feed a new chunk of markdown text. Returns only the newly rendered
   * ANSI output that should be written to the terminal since the last
   * call (append delta, or a cursor-up rewrite when earlier lines change).
   *
   * @param chunk - New markdown text chunk (may be partial)
   * @param renderFn - The markdown→ANSI render function to use
   * @returns The delta output to write, or '' if nothing new to show
   */
  feed(chunk: string, renderFn: (text: string) => string): string {
    if (!chunk) return '';

    this.fullText += chunk;

    // Detect if we are currently inside an unclosed fenced code block.
    // Uses line-based scanning to track fence open/close state, avoiding the
    // O(n²) full-text split() per chunk that was the original approach.
    // Only re-scans when the chunk contains a backtick or tilde (fast bail-out
    // for the 99% of chunks that don't contain fence characters).
    if (chunk.includes('`') || chunk.includes('~')) {
      this._updateCodeBlockLanguage();
    }
    const isInsideCodeBlock = this._activeCodeBlockLanguage !== null;

    // ── Fast path: chunk extends current line, no structural change ──────
    // When the chunk has no newlines, it's just adding to the middle of a
    // word or line. The markdown structure hasn't changed, so we can skip
    // re-lexing and emit the raw chunk directly.
    // Shimmer is applied here because the output is plain text (no ANSI codes
    // from markdown rendering), so the shimmer character-wrapping works correctly.
    if (!chunk.includes('\n') && !chunk.includes('\r') && !isInsideCodeBlock) {
      this._wasFastPath = true;
      this._fastPathSinceStructural = true;
      this.lastRendered = this.lastRendered + chunk;
      this.lastTotalLines = this._logicalLineCount(this.lastRendered);
      return this.applyShimmer(chunk);
    }

    // ── Full render path: newline received, structure may have changed ───
    const rendered = renderFn(this.fullText);

    // G3 — advance structural scanner, then adaptive full-table holdback.
    this._advanceTableScanner();
    const adaptive = this._applyAdaptiveTableHold(rendered);
    if (adaptive !== null) {
      this._wasFastPath = false;
      return adaptive;
    }

    // ── Table holdback ──────────────────────────────────────────────
    // If the rendered output ends with a partial table row, hold the
    // last line back and emit only complete lines above it.
    if (this._isHoldingTable(rendered)) {
      this._wasFastPath = false;
      return this._flushHeldProgressive(rendered);
    }

    // If we were previously holding a table but it's now complete, flush
    // only the held tail — not the entire rendered table again.
    if (this._tableHeldLines > 0) {
      this._wasFastPath = false;
      return this._flushHeldFinal(rendered);
    }

    this._wasFastPath = false;

    // If nothing changed, return nothing
    if (rendered === this.lastRendered) return '';

    // Delta comparison baseline: prefer the last pure-ANSI structural
    // render so mid-line extensions are correctly detected (Case 2 in
    // _computeRenderDelta).  When no prior structural render exists
    // (first call), fall back to `lastRendered` which may contain raw
    // fast-path text — the resulting Case 2/3 delta correctly handles
    // both mid-line extensions and markdown-transform rewrites.
    const deltaBaseline = this._lastStructuralAnsi || this.lastRendered;
    let delta = this._computeRenderDelta(deltaBaseline, rendered);

    // When the ANSI baseline is in use and fast-path shimmer was emitted
    // since the last structural render, erase the current terminal line
    // before emitting the delta.  Fast-path shimmer extends the last line
    // of the ANSI output in-place; the delta's leading `\n` advances past
    // it but doesn't clear the shimmer text, producing duplicates.
    // Skip when falling back to raw `lastRendered` — _computeRenderDelta
    // already accounted for the fast-path text in that case.
    if (this._lastStructuralAnsi && this._fastPathSinceStructural) {
      delta = `\r\x1b[K${delta}`;
    }
    this._fastPathSinceStructural = false;

    this.lastRendered = rendered;
    this._lastStructuralAnsi = rendered;
    this.lastTotalLines = this._logicalLineCount(rendered);
    this._fastPathSinceStructural = false;

    // If inside a fenced code block, post-process the delta to apply
    // tree-sitter syntax highlighting to code content lines.
    // Skip rewrite sequences — they already contain the full replacement
    // tail and highlighting was applied by renderFn for completed lines.
    if (
      this._activeCodeBlockLanguage !== null &&
      delta &&
      !delta.startsWith('\x1b[')
    ) {
      delta = this._highlightCodeBlockDelta(delta);
    }

    return delta;
  }

  /**
   * Current fully-rendered text tracked by the accumulator (what the
   * terminal should show after applying the last feed/reflow delta).
   * Used by hardware two-region streaming to replace the streaming area
   * when a delta embeds cursor-up rewrite sequences.
   */
  getRenderedText(): string {
    return this.lastRendered;
  }

  // ── Reflow ────────────────────────────────────────────────────────────────

  /**
   * Re-render the full accumulated text at a new terminal width.
   * Used when the terminal is resized. Resets internal tracking so
   * the next feed() call computes deltas from the new render state.
   *
   * @param width - New terminal width
   * @param renderFn - The markdown->ANSI render function to use
   * @returns The full rendered output at the new width, or '' if
   *   the accumulator has no text
   */
  reflow(width: number, renderFn: (text: string) => string): string {
    if (!this.fullText) return '';

    const prevWidth = this._terminalWidth;
    this._terminalWidth = width;

    const rendered = renderFn(this.fullText);

    // Skip repaint when output is unchanged and holdback state is clean.
    if (rendered === this.lastRendered && width === prevWidth && this._tableHeldLines === 0) {
      return '';
    }

    // Reset holdback/fast-path tracking before adopting the reflowed render.
    this._tableHeldLines = 0;
    this._adaptiveTableHold = false;
    this._tableScanner.reset();
    this._scannerCompleteLines = 0;
    this._wasFastPath = false;
    this._updateCodeBlockLanguage();
    // Re-feed complete lines so scanner state matches fullText after resize.
    this._advanceTableScanner();

    this.lastRendered = rendered;
    this._lastStructuralAnsi = rendered;
    this._fastPathSinceStructural = false;
    this.lastTotalLines =
      width > 0
        ? this._countVisualLines(rendered)
        : rendered
          ? rendered.split('\n').length
          : 0;

    return rendered;
  }

  /** Reset the accumulator for a new conversation. */
  reset(): void {
    this.fullText = '';
    this.lastRendered = '';
    this._lastStructuralAnsi = '';
    this.lastTotalLines = 0;
    this._fastPathSinceStructural = false;
    this._tableHeldLines = 0;
    this._adaptiveTableHold = false;
    this._tableScanner.reset();
    this._scannerCompleteLines = 0;
    this._wasFastPath = false;
    this._activeCodeBlockLanguage = null;
  }

  /** Total bytes accumulated so far. */
  get totalBytes(): number {
    return Buffer.byteLength(this.fullText, 'utf8');
  }

  /** Total lines of rendered output. */
  get totalLines(): number {
    return this.lastTotalLines;
  }
}
