/**
 * TableHoldbackScanner — incremental pipe-table detection for streaming markdown.
 *
 * Ported from Codex: codex-rs/tui/src/streaming/table_holdback.rs
 *
 * Detects GFM pipe-table header+delimiter pairs in streaming source, accounting
 * for fenced code blocks (```) and blockquote prefixes (>). The scanner drives
 * a three-state machine:
 *
 *   none → pending-header → confirmed (header+delimiter pair found)
 *
 * Once confirmed, callers can hold back table content to prevent visible column
 * reshuffling during LLM streaming.
 *
 * G3 — column-width-adaptive holdback:
 *   After confirmation, tracks per-column max display widths (CJK-aware) as body
 *   rows arrive. Callers can hold the entire table region until widths stabilize
 *   (or the table ends on a blank / non-table line) so intermediate frames do
 *   not reshuffle column boundaries.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Where a source line sits relative to fenced code blocks. */
export type FenceKind = 'outside' | 'markdown' | 'other';

/** Current table detection state. */
export type HoldbackState = 'none' | 'pending-header' | 'confirmed';

/**
 * Display width for table cell content (CJK-aware, no ANSI expected on source).
 * Fullwidth / wide code points count as 2; combining marks as 0; else 1.
 */
export function cellDisplayWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    // Combining marks / zero-width
    if (
      (cp >= 0x0300 && cp <= 0x036f) ||
      (cp >= 0xfe00 && cp <= 0xfe0f) ||
      cp === 0x200b ||
      cp === 0x200c ||
      cp === 0x200d ||
      cp === 0xfeff
    ) {
      continue;
    }
    // East Asian Wide / Fullwidth ranges (practical subset)
    if (
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe10 && cp <= 0xfe19) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1faff)
    ) {
      width += 2;
      continue;
    }
    width += 1;
  }
  return width;
}

/**
 * Update running per-column max widths from a row's cell strings.
 * Returns true if any column max grew (caller should treat layout as unstable).
 */
export function expandColumnMaxWidths(maxWidths: number[], cells: string[]): boolean {
  let expanded = false;
  for (let i = 0; i < cells.length; i++) {
    const w = cellDisplayWidth(cells[i] ?? '');
    if (i >= maxWidths.length) {
      maxWidths.push(w);
      expanded = true;
    } else if (w > (maxWidths[i] ?? 0)) {
      maxWidths[i] = w;
      expanded = true;
    }
  }
  return expanded;
}

// ---------------------------------------------------------------------------
// Pipe-table segment detection
// ---------------------------------------------------------------------------

/**
 * Split a pipe-delimited line into trimmed segments.
 *
 * Returns `null` if the line is empty or has no unescaped separator marker.
 * Leading/trailing pipes are stripped before splitting.
 */
export function parseTableSegments(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  const hasOuterPipe = trimmed.startsWith('|') || trimmed.endsWith('|');
  let content = trimmed.startsWith('|') ? trimmed.slice(1) : trimmed;
  content = content.endsWith('|') ? content.slice(0, -1) : content;
  const rawSegments = splitUnescapedPipe(content);

  // Without outer pipes, a single segment doesn't look like a table.
  if (!hasOuterPipe && rawSegments.length <= 1) return null;

  const segments: string[] = rawSegments.map((s) => s.trim());
  return segments.length > 0 ? segments : null;
}

/** Split `content` on unescaped `|` characters (backslash-escaped pipes preserved). */
function splitUnescapedPipe(content: string): string[] {
  const segments: string[] = [];
  let start = 0;
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '\\') {
      i++; // skip the escaped character
    } else if (content[i] === '|') {
      segments.push(content.slice(start, i));
      start = i + 1;
    }
  }
  segments.push(content.slice(start));
  return segments;
}

/**
 * Whether `line` looks like a table header row (has pipe-separated segments
 * with at least one non-empty cell).
 */
export function isTableHeaderLine(line: string): boolean {
  const segments = parseTableSegments(line);
  return segments !== null && segments.some((s) => s.length > 0);
}

/** Whether a single segment matches the `---`, `:---`, `---:`, or `:---:` alignment syntax. */
function isTableDelimiterSegment(segment: string): boolean {
  const trimmed = segment.trim();
  if (!trimmed) return false;
  const withoutLeading = trimmed.startsWith(':') ? trimmed.slice(1) : trimmed;
  const withoutEnds = withoutLeading.endsWith(':') ? withoutLeading.slice(0, -1) : withoutLeading;
  return withoutEnds.length >= 3 && [...withoutEnds].every((c) => c === '-');
}

/**
 * Whether `line` is a valid table delimiter row (every segment passes
 * delimiter validation).
 */
export function isTableDelimiterLine(line: string): boolean {
  const segments = parseTableSegments(line);
  return segments !== null && segments.every(isTableDelimiterSegment);
}

// ---------------------------------------------------------------------------
// Blockquote prefix stripping
// ---------------------------------------------------------------------------

/** Peel all leading `>` blockquote markers from a line. */
export function stripBlockquotePrefix(line: string): string {
  let rest = line.trimStart();
  for (;;) {
    if (!rest.startsWith('>')) return rest;
    rest = rest.slice(1);
    rest = rest.startsWith(' ') ? rest.slice(1) : rest;
    rest = rest.trimStart();
  }
}

// ---------------------------------------------------------------------------
// Fenced code block tracking
// ---------------------------------------------------------------------------

/** Parse fence marker (backtick or tilde) from start of line. Returns marker char and run length. */
export function parseFenceMarker(line: string): { marker: string; length: number } | null {
  const first = line[0];
  if (first !== '`' && first !== '~') return null;
  let len = 0;
  for (const ch of line) {
    if (ch === first) len++;
    else break;
  }
  if (len < 3) return null;
  return { marker: first, length: len };
}

/** Whether the info string after a fence marker indicates markdown content. */
function isMarkdownFenceInfo(trimmedLine: string, markerLen: number): boolean {
  const info = trimmedLine.slice(markerLen).split(/\s+/)[0] || '';
  return info.toLowerCase() === 'md' || info.toLowerCase() === 'markdown';
}

/**
 * Incremental tracker for fenced code block open/close transitions.
 *
 * Feed lines one at a time via advance(); query the current context with kind().
 * The tracker handles leading-whitespace limits (>3 spaces not a fence),
 * blockquote prefix stripping, and backtick/tilde marker matching.
 */
export class FenceTracker {
  private state: { marker: string; length: number; kind: FenceKind } | null = null;

  /** Process one raw source line and update fence state. */
  advance(line: string): void {
    // Lines with >3 leading spaces are indented code blocks, not fences.
    const leadingSpaces = (line.match(/^ */) || [''])[0].length;
    if (leadingSpaces > 3) return;

    const trimmed = line.slice(leadingSpaces);
    const fenceScanText = stripBlockquotePrefix(trimmed);
    const marker = parseFenceMarker(fenceScanText);

    if (marker) {
      if (this.state) {
        // Close the current fence if the marker matches.
        const rest = fenceScanText.slice(marker.length).trim();
        if (
          marker.marker === this.state.marker &&
          marker.length >= this.state.length &&
          !rest
        ) {
          this.state = null;
        }
      } else {
        // Opening a new fence.
        const kind: FenceKind = isMarkdownFenceInfo(fenceScanText, marker.length)
          ? 'markdown'
          : 'other';
        this.state = { marker: marker.marker, length: marker.length, kind };
      }
    }
  }

  /** Current fence context for the most-recently-advanced line. */
  kind(): FenceKind {
    return this.state?.kind ?? 'outside';
  }

  /** Reset to outside state. */
  reset(): void {
    this.state = null;
  }
}

// ---------------------------------------------------------------------------
// Table holdback scanner
// ---------------------------------------------------------------------------

/** Line-level state remembered by the scanner for lookbehind. */
interface PreviousLineInfo {
  fenceKind: FenceKind;
  isHeader: boolean;
}

/**
 * Incremental scanner for table holdback state on append-only source streams.
 *
 * Feed lines via pushLine() or pushChunk(). Query state() for the current
 * detection status. On confirmed, callers should hold back content from the
 * table onward and only commit on finalize.
 *
 * G3: while confirmed, columnMaxWidths tracks the widest cell seen per column
 * (source cells, CJK-aware). widthsExpandedSinceCheck() reports whether any
 * column grew since the last check — use this to keep the table in the mutable
 * tail until layout stabilizes or the table ends.
 */
export class TableHoldbackScanner {
  private fenceTracker = new FenceTracker();
  private previousLine: PreviousLineInfo | null = null;
  private pendingHeader = false;
  private confirmed = false;
  /** Per-column max display widths for the active confirmed table. */
  private columnMaxWidths: number[] = [];
  /** True if any column max grew since the last widthsExpandedSinceCheck(). */
  private widthsDirty = false;
  /** Body rows seen after header+delimiter (excludes header and delimiter). */
  private bodyRowCount = 0;
  /**
   * Set when a confirmed table ends (blank line or non-table line after the
   * table structure). Consumer should flush held content, then call
   * acknowledgeTableEnd() (or rely on soft-reset already applied).
   */
  private tableEnded = false;
  /** Header cell widths captured when header line was seen (before confirm). */
  private pendingHeaderWidths: number[] | null = null;

  /**
   * Feed one committed source line. The line may or may not include a trailing
   * newline — both are accepted.
   */
  pushLine(line: string): void {
    // Strip trailing newline (either \n or \r\n).
    const stripped = line.replace(/\r?\n$/, '');
    const fenceKind = this.fenceTracker.kind();

    // Determine candidate text for table detection (skip inside Other fences).
    let candidateText: string | null = null;
    let segments: string[] | null = null;
    if (fenceKind !== 'other') {
      const cleaned = stripBlockquotePrefix(stripped).trim();
      if (cleaned) {
        segments = parseTableSegments(cleaned);
        if (segments) candidateText = cleaned;
      }
    }

    const isHeader = candidateText !== null && isTableHeaderLine(candidateText);
    const isDelimiter = candidateText !== null && isTableDelimiterLine(candidateText);

    // ── Confirmed table: track widths or detect end ─────────────────────
    if (this.confirmed) {
      const isBlank = stripped.trim().length === 0;
      const isTableRow = candidateText !== null && !isBlank;

      if (isTableRow && segments) {
        // Skip pure delimiter rows for body count; still seed widths.
        if (!isDelimiter) {
          if (expandColumnMaxWidths(this.columnMaxWidths, segments)) {
            this.widthsDirty = true;
          }
          // Header was already counted at confirm; subsequent non-delimiter rows
          // after confirm are body (or a second header in multi-table without reset).
          this.bodyRowCount += 1;
        }
      } else if (isBlank || !isTableRow) {
        // Table ended — soft-reset detection state so a following table can start.
        this.tableEnded = true;
        this.confirmed = false;
        this.pendingHeader = false;
        this.previousLine = { fenceKind, isHeader: false };
        this.fenceTracker.advance(stripped);
        // Keep columnMaxWidths until acknowledgeTableEnd() so consumer can read them.
        return;
      }

      this.previousLine = { fenceKind, isHeader };
      this.fenceTracker.advance(stripped);
      return;
    }

    // Check for confirmation: previous line is a header AND current is a delimiter.
    if (
      !this.confirmed &&
      this.previousLine !== null &&
      this.previousLine.fenceKind !== 'other' &&
      fenceKind !== 'other' &&
      this.previousLine.isHeader &&
      isDelimiter
    ) {
      this.confirmed = true;
      this.pendingHeader = false;
      this.tableEnded = false;
      this.bodyRowCount = 0;
      // Seed widths from the pending header if we captured them.
      // Do NOT set widthsDirty on seed — progressive row emit is fine until a
      // body row actually expands a column (G3 reshuffle risk).
      this.columnMaxWidths = this.pendingHeaderWidths ? [...this.pendingHeaderWidths] : [];
      this.pendingHeaderWidths = null;
      this.widthsDirty = false;
    }

    // Update pending header state (only if not yet confirmed).
    if (!this.confirmed && stripped.trim().length > 0) {
      this.pendingHeader = fenceKind !== 'other' && isHeader;
      if (this.pendingHeader && segments) {
        this.pendingHeaderWidths = segments.map((s) => cellDisplayWidth(s));
      } else if (!this.pendingHeader) {
        this.pendingHeaderWidths = null;
      }
    }

    this.previousLine = { fenceKind, isHeader };
    this.fenceTracker.advance(stripped);
  }

  /**
   * Feed a chunk that may contain multiple complete lines (terminated by \n).
   * Partial trailing lines (no \n) are intentionally ignored — the scanner
   * only processes committed (complete) lines.
   */
  pushChunk(chunk: string): void {
    if (!chunk) return;
    let lastEnd = 0;
    for (let i = 0; i < chunk.length; i++) {
      if (chunk[i] === '\n') {
        this.pushLine(chunk.slice(lastEnd, i + 1));
        lastEnd = i + 1;
      }
    }
  }

  /** Return the current detection state. */
  state(): HoldbackState {
    if (this.confirmed) return 'confirmed';
    if (this.pendingHeader) return 'pending-header';
    return 'none';
  }

  /**
   * True while callers should keep the **confirmed** table region mutable.
   * Pending-header alone is not enough — incomplete-line holdback covers that
   * case without suppressing non-table streaming.
   */
  shouldHold(): boolean {
    if (this.tableEnded) return false;
    return this.confirmed;
  }

  /** Snapshot of per-column max display widths for the active/last table. */
  getColumnMaxWidths(): readonly number[] {
    return this.columnMaxWidths;
  }

  /**
   * True if any column max grew since the previous call (sticky until read).
   * Used to decide whether a progressive table re-render would reshuffle layout.
   */
  widthsExpandedSinceCheck(): boolean {
    const dirty = this.widthsDirty;
    this.widthsDirty = false;
    return dirty;
  }

  /** Body data rows seen after header+delimiter for the active table. */
  getBodyRowCount(): number {
    return this.bodyRowCount;
  }

  /**
   * True if the most recent push closed a confirmed table (blank/non-table line).
   * Sticky until acknowledgeTableEnd().
   */
  didTableEnd(): boolean {
    return this.tableEnded;
  }

  /**
   * Clear the table-ended flag and column width history after the consumer
   * has flushed held content. Safe to call even if not ended.
   */
  acknowledgeTableEnd(): void {
    this.tableEnded = false;
    this.columnMaxWidths = [];
    this.widthsDirty = false;
    this.bodyRowCount = 0;
    this.pendingHeaderWidths = null;
  }

  /** Reset the scanner for a new stream. */
  reset(): void {
    this.fenceTracker.reset();
    this.previousLine = null;
    this.pendingHeader = false;
    this.confirmed = false;
    this.columnMaxWidths = [];
    this.widthsDirty = false;
    this.bodyRowCount = 0;
    this.tableEnded = false;
    this.pendingHeaderWidths = null;
  }
}
