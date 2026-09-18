/**
 * HistoryCellViewport — virtual scroll over measured history cells.
 *
 * Uses per-cell flattened row heights (B1 desiredHeight) to render only the
 * visible slice of a long transcript — O(viewport) paint, not O(N) reflow.
 *
 * Modeled on Claude Code VirtualMessageList + Codex transcript overlay:
 * scrollOffset=0 is the live bottom; increasing offset reveals older rows.
 */

import type { HistoryCell } from './historyCell.js';
import { flattenCellRows } from './layout.js';
import type { HistoryTranscript } from './transcript.js';
import {
  TranscriptSearchIndex,
  type TranscriptSearchMatch,
} from './transcriptSearch.js';

export interface ViewportCellEntry {
  cellId: string;
  cacheKey: string;
  cell: HistoryCell;
  startRow: number;
  rows: string[];
}

export interface ViewportScrollInfo {
  offset: number;
  totalRows: number;
  isAtBottom: boolean;
  unseenSinceLastView: number;
  cellCount: number;
}

export interface ViewportOperationCounts {
  cellsMeasured: number;
  visibleEntriesVisited: number;
  visibleLookupSteps: number;
  widthReflows: number;
}

interface ViewportAnchor {
  cellId: string;
  intraCellRow: number;
}

export class HistoryCellViewport {
  private width: number;
  private entries: ViewportCellEntry[] = [];
  private totalRows = 0;
  /** Rows scrolled above the live bottom (0 = pinned to latest). */
  private scrollOffset = 0;
  private unseenSinceLastView = 0;
  private searchIndex = new TranscriptSearchIndex();
  private searchIndexVersion = 0;
  private searchIndexBuiltVersion = -1;
  private lastViewportHeight = 1;
  private readonly measuredRows = new Map<string, string[]>();
  private readonly entryIndexByCellId = new Map<string, number>();
  private lastCommittedCells: readonly HistoryCell[] | null = null;
  private lastCommittedLength = 0;
  private lastCommittedTailKey: string | null = null;
  private lastActiveCell: HistoryCell | null = null;
  private lastActiveCacheKey: string | null = null;
  private operationCounts: ViewportOperationCounts = {
    cellsMeasured: 0,
    visibleEntriesVisited: 0,
    visibleLookupSteps: 0,
    widthReflows: 0,
  };

  constructor(width: number = 80) {
    this.width = Math.max(1, width);
  }

  get terminalWidth(): number {
    return this.width;
  }

  get totalRowCount(): number {
    return this.totalRows;
  }

  get scrollOffsetRows(): number {
    return this.scrollOffset;
  }

  get cellEntries(): readonly ViewportCellEntry[] {
    return this.entries;
  }

  setWidth(width: number): void {
    const next = Math.max(1, width);
    if (next === this.width) return;
    const anchor = this.captureAnchor();
    this.width = next;
    this.operationCounts.widthReflows += 1;
    this.rebuildFromCells(
      this.entries.map((entry) => entry.cell),
      anchor,
      true,
    );
    this.clearSyncSource();
  }

  /** Replace viewport contents from an ordered cell list. */
  setCells(cells: HistoryCell[]): void {
    this.rebuildFromCells(cells, this.captureAnchor());
    this.clearSyncSource();
  }

  /** Incrementally sync from a HistoryTranscript (committed + active tail). */
  syncFromTranscript(transcript: HistoryTranscript): void {
    const committed = transcript.getCommittedCells();
    const active = transcript.getActiveCell();
    const activeCacheKey = active?.cacheKey() ?? null;
    const committedTailKey = committed.at(-1)?.cacheKey() ?? null;
    if (
      committed === this.lastCommittedCells &&
      committed.length === this.lastCommittedLength &&
      committedTailKey === this.lastCommittedTailKey &&
      active === this.lastActiveCell &&
      activeCacheKey === this.lastActiveCacheKey
    ) {
      return;
    }

    const wasAtBottom = this.scrollOffset === 0;
    const prevTotal = this.totalRows;
    const cells = active ? [...committed, active] : committed;
    this.rebuildFromCells(cells, this.captureAnchor());
    this.lastCommittedCells = committed;
    this.lastCommittedLength = committed.length;
    this.lastCommittedTailKey = committedTailKey;
    this.lastActiveCell = active;
    this.lastActiveCacheKey = activeCacheKey;

    if (!wasAtBottom && this.totalRows > prevTotal) {
      this.unseenSinceLastView += this.totalRows - prevTotal;
    }
  }

  private rebuildFromCells(
    cells: readonly HistoryCell[],
    anchor: ViewportAnchor | null = null,
    forceReflow = false,
  ): void {
    const previousEntries = this.entries;
    let firstChanged = Math.min(previousEntries.length, cells.length);
    if (!forceReflow) {
      while (
        firstChanged > 0 &&
        this.sameEntryCell(previousEntries[firstChanged - 1]!, cells[firstChanged - 1]!)
      ) {
        firstChanged -= 1;
      }
    } else {
      firstChanged = 0;
    }

    if (!forceReflow && firstChanged === cells.length && cells.length === previousEntries.length) {
      return;
    }

    const entries = previousEntries.slice(0, firstChanged);
    let startRow = entries.at(-1)?.startRow ?? 0;
    if (entries.length > 0) {
      const lastEntry = entries[entries.length - 1]!;
      startRow = lastEntry.startRow + lastEntry.rows.length;
    }

    for (let index = firstChanged; index < cells.length; index += 1) {
      const cell = cells[index]!;
      const rows = this.measureCell(cell);
      entries.push({
        cellId: cell.record.cell_id,
        cacheKey: cell.cacheKey(),
        cell,
        startRow,
        rows,
      });
      startRow += rows.length;
    }

    this.entries = entries;
    this.totalRows = startRow;
    this.entryIndexByCellId.clear();
    for (let index = 0; index < entries.length; index += 1) {
      this.entryIndexByCellId.set(entries[index]!.cellId, index);
    }
    this.searchIndexVersion += 1;

    if (this.scrollOffset === 0) {
      return;
    }
    if (anchor) {
      const anchorIndex = this.entryIndexByCellId.get(anchor.cellId);
      if (anchorIndex !== undefined) {
        const anchorEntry = entries[anchorIndex]!;
        const anchorRow = anchorEntry.startRow + anchor.intraCellRow;
        this.scrollOffset = Math.max(
          1,
          Math.min(
            this.maxScrollOffset,
            this.totalRows - this.lastViewportHeight - anchorRow,
          ),
        );
        return;
      }
    }
    this.scrollOffset = Math.min(this.scrollOffset, this.maxScrollOffset);
  }

  private measureCell(cell: HistoryCell): string[] {
    const cacheKey = `${this.width}:${cell.cacheKey()}`;
    const cached = this.measuredRows.get(cacheKey);
    if (cached) return cached;
    const rows = flattenCellRows(cell, this.width);
    this.measuredRows.set(cacheKey, rows);
    this.operationCounts.cellsMeasured += 1;
    return rows;
  }

  private sameEntryCell(entry: ViewportCellEntry, cell: HistoryCell): boolean {
    return entry.cellId === cell.record.cell_id && entry.cacheKey === cell.cacheKey();
  }

  private clearSyncSource(): void {
    this.lastCommittedCells = null;
    this.lastCommittedLength = 0;
    this.lastCommittedTailKey = null;
    this.lastActiveCell = null;
    this.lastActiveCacheKey = null;
  }

  private captureAnchor(): ViewportAnchor | null {
    if (this.scrollOffset === 0 || this.entries.length === 0) return null;
    const startRow = Math.max(
      0,
      this.totalRows - this.scrollOffset - this.lastViewportHeight,
    );
    const entryIndex = this.findEntryIndexAtRow(startRow, false);
    if (entryIndex < 0) return null;
    const entry = this.entries[entryIndex]!;
    return {
      cellId: entry.cellId,
      intraCellRow: startRow - entry.startRow,
    };
  }

  get maxScrollOffset(): number {
    return Math.max(0, this.totalRows - 1);
  }

  setScrollOffset(offset: number): void {
    const clamped = Math.max(0, Math.min(offset, this.maxScrollOffset));
    this.scrollOffset = clamped;
    if (clamped === 0) {
      this.unseenSinceLastView = 0;
    }
  }

  scrollBy(deltaRows: number): void {
    this.setScrollOffset(this.scrollOffset + deltaRows);
  }

  scrollToBottom(): void {
    this.setScrollOffset(0);
  }

  incrementUnseen(rows: number): void {
    if (rows > 0 && this.scrollOffset > 0) {
      this.unseenSinceLastView += rows;
    }
  }

  getScrollInfo(): ViewportScrollInfo {
    return {
      offset: this.scrollOffset,
      totalRows: this.totalRows,
      isAtBottom: this.scrollOffset === 0,
      unseenSinceLastView: this.unseenSinceLastView,
      cellCount: this.entries.length,
    };
  }

  /**
   * Return physical rows visible in a viewport of the given height.
   * scrollOffset=0 shows the most recent rows (live tail).
   */
  getVisibleRows(viewportHeight: number): string[] {
    if (viewportHeight <= 0 || this.totalRows === 0) return [];

    const height = Math.max(1, viewportHeight);
    this.lastViewportHeight = height;
    const endExclusive = this.totalRows - this.scrollOffset;
    const startInclusive = Math.max(0, endExclusive - height);

    const result: string[] = [];
    const firstEntry = this.findEntryIndexAtRow(startInclusive, true);
    for (let entryIndex = firstEntry; entryIndex < this.entries.length; entryIndex += 1) {
      const entry = this.entries[entryIndex]!;
      this.operationCounts.visibleEntriesVisited += 1;
      const entryEnd = entry.startRow + entry.rows.length;
      if (entry.startRow >= endExclusive) break;

      for (let i = 0; i < entry.rows.length; i++) {
        const rowIndex = entry.startRow + i;
        if (rowIndex >= startInclusive && rowIndex < endExclusive) {
          result.push(entry.rows[i]!);
        }
      }
    }
    return result;
  }

  /** Render the visible viewport slice as a single string. */
  renderViewport(viewportHeight: number): string {
    return this.getVisibleRows(viewportHeight).join('\n');
  }

  /**
   * Find the cell index containing a physical row (for jump-to-cell navigation).
   * Returns -1 when row is out of range.
   */
  findCellIndexAtRow(row: number): number {
    if (row < 0 || row >= this.totalRows) return -1;
    return this.findEntryIndexAtRow(row, true);
  }

  private findEntryIndexAtRow(row: number, countOperations: boolean): number {
    let low = 0;
    let high = this.entries.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (countOperations) this.operationCounts.visibleLookupSteps += 1;
      const entry = this.entries[middle]!;
      const entryEnd = entry.startRow + entry.rows.length;
      if (entryEnd <= row) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    return low < this.entries.length ? low : -1;
  }

  /** Scroll so the top of cell `index` is near the top of the viewport. */
  scrollToCell(index: number, viewportHeight: number): void {
    if (index < 0 || index >= this.entries.length) return;
    this.lastViewportHeight = Math.max(1, viewportHeight);
    const entry = this.entries[index]!;
    const targetBottom = entry.startRow + viewportHeight;
    const offset = Math.max(0, this.totalRows - targetBottom);
    this.setScrollOffset(Math.min(offset, this.maxScrollOffset));
  }

  /**
   * Pre-build the warm search index from flattened cell rows.
   * Returns warm duration in ms (0 when cache is already current).
   */
  warmSearchIndex(): number {
    if (this.searchIndexBuiltVersion === this.searchIndexVersion && this.searchIndex.isWarm) {
      return 0;
    }
    const ms = this.searchIndex.warmFromViewportEntries(this.entries);
    this.searchIndexBuiltVersion = this.searchIndexVersion;
    return ms;
  }

  /** Search warmed rows (auto-warms when needed). */
  search(query: string): TranscriptSearchMatch[] {
    if (
      !this.searchIndex.isWarm ||
      this.searchIndexBuiltVersion !== this.searchIndexVersion
    ) {
      this.warmSearchIndex();
    }
    return this.searchIndex.search(query);
  }

  getSearchIndex(): TranscriptSearchIndex {
    return this.searchIndex;
  }

  /** Scroll so a search match appears near the middle of the viewport. */
  scrollToMatch(match: TranscriptSearchMatch, viewportHeight: number): void {
    const half = Math.floor(Math.max(1, viewportHeight) / 2);
    const offset = Math.max(
      0,
      Math.min(this.maxScrollOffset, this.totalRows - match.rowIndex - half),
    );
    this.setScrollOffset(offset);
  }

  /** Reset and return the bounded-operation counters used by viewport tests. */
  resetOperationCounts(): void {
    this.operationCounts = {
      cellsMeasured: 0,
      visibleEntriesVisited: 0,
      visibleLookupSteps: 0,
      widthReflows: 0,
    };
  }

  /** Return a snapshot of viewport work performed since the last reset. */
  getOperationCounts(): ViewportOperationCounts {
    return { ...this.operationCounts };
  }
}
