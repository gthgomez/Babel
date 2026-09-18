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
  contentKey: string;
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
  cellsCompared: number;
  indexEntriesRebuilt: number;
  cachedRevisionCount: number;
  measurementCacheEvictions: number;
  visibleEntriesVisited: number;
  visibleLookupSteps: number;
  widthReflows: number;
}

interface ViewportAnchor {
  cellId: string;
  intraCellRow: number;
}

export const VIEWPORT_MEASUREMENT_CACHE_LIMIT = 512;

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
  private lastCommittedContentKeys: readonly string[] | null = null;
  private lastActiveCell: HistoryCell | null = null;
  private lastActiveContentKey: string | null = null;
  private operationCounts: ViewportOperationCounts = {
    cellsMeasured: 0,
    cellsCompared: 0,
    indexEntriesRebuilt: 0,
    cachedRevisionCount: 0,
    measurementCacheEvictions: 0,
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
      {
        forceReflow: true,
        countNewRows: false,
      },
    );
    this.clearSyncSource();
  }

  /** Replace viewport contents from an ordered cell list. */
  setCells(cells: HistoryCell[]): void {
    this.rebuildFromCells(cells, this.captureAnchor(), {
      resetViewport: this.shouldResetViewport(cells),
    });
    this.clearSyncSource();
  }

  /** Incrementally sync from a HistoryTranscript (committed + active tail). */
  syncFromTranscript(transcript: HistoryTranscript): void {
    const committed = transcript.getCommittedCells();
    const active = transcript.getActiveCell();
    const committedContentKeys = committed.map((cell) =>
      this.cellContentKey(cell),
    );
    const activeContentKey = active ? this.cellContentKey(active) : null;
    if (
      committed === this.lastCommittedCells &&
      this.sameStringArray(
        committedContentKeys,
        this.lastCommittedContentKeys,
      ) &&
      active === this.lastActiveCell &&
      activeContentKey === this.lastActiveContentKey
    ) {
      return;
    }

    const cells = active ? [...committed, active] : committed;
    this.rebuildFromCells(cells, this.captureAnchor(), {
      resetViewport: this.shouldResetViewport(cells),
    });
    this.lastCommittedCells = committed;
    this.lastCommittedContentKeys = committedContentKeys;
    this.lastActiveCell = active;
    this.lastActiveContentKey = activeContentKey;
  }

  private rebuildFromCells(
    cells: readonly HistoryCell[],
    anchor: ViewportAnchor | null = null,
    options: {
      forceReflow?: boolean;
      countNewRows?: boolean;
      resetViewport?: boolean;
    } = {},
  ): void {
    const previousEntries = this.entries;
    const previousTotalRows = this.totalRows;
    const wasAtBottom = this.scrollOffset === 0;
    const forceReflow = options.forceReflow ?? false;
    const countNewRows = options.countNewRows ?? true;
    const resetViewport = options.resetViewport ?? false;
    const contentKeys = cells.map((cell) => this.cellContentKey(cell));

    let firstChanged = 0;
    if (!forceReflow) {
      const comparableCount = Math.min(previousEntries.length, cells.length);
      while (
        firstChanged < comparableCount &&
        this.sameEntryCell(
          previousEntries[firstChanged]!,
          cells[firstChanged]!,
          contentKeys[firstChanged]!,
        )
      ) {
        firstChanged += 1;
      }
    }

    if (
      !forceReflow &&
      firstChanged === cells.length &&
      cells.length === previousEntries.length
    ) {
      if (resetViewport) {
        this.scrollOffset = 0;
        this.unseenSinceLastView = 0;
      }
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
      const rows = this.measureCell(cell, contentKeys[index]!);
      entries.push({
        cellId: cell.record.cell_id,
        cacheKey: cell.cacheKey(),
        contentKey: contentKeys[index]!,
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
    this.operationCounts.indexEntriesRebuilt += entries.length;
    this.searchIndexVersion += 1;

    if (resetViewport) {
      this.scrollOffset = 0;
      this.unseenSinceLastView = 0;
      return;
    }
    if (anchor) {
      const anchorIndex = this.entryIndexByCellId.get(anchor.cellId);
      if (anchorIndex !== undefined) {
        const anchorEntry = entries[anchorIndex]!;
        const intraCellRow = Math.min(
          Math.max(0, anchor.intraCellRow),
          Math.max(0, anchorEntry.rows.length - 1),
        );
        const anchorRow = anchorEntry.startRow + intraCellRow;
        this.scrollOffset = Math.max(
          0,
          Math.min(
            this.maxScrollOffset,
            this.totalRows - this.lastViewportHeight - anchorRow,
          ),
        );
      } else {
        this.scrollOffset = Math.min(this.scrollOffset, this.maxScrollOffset);
      }
    } else {
      this.scrollOffset = Math.min(this.scrollOffset, this.maxScrollOffset);
    }

    if (countNewRows && !wasAtBottom && this.scrollOffset > 0) {
      this.unseenSinceLastView += Math.max(
        0,
        this.totalRows - previousTotalRows,
      );
    }
    if (this.scrollOffset === 0) {
      this.unseenSinceLastView = 0;
    }
  }

  private measureCell(
    cell: HistoryCell,
    contentKey = this.cellContentKey(cell),
  ): string[] {
    const cacheKey = `${this.width}:${contentKey}`;
    const cached = this.measuredRows.get(cacheKey);
    if (cached) {
      this.measuredRows.delete(cacheKey);
      this.measuredRows.set(cacheKey, cached);
      return cached;
    }
    const rows = flattenCellRows(cell, this.width);
    this.measuredRows.set(cacheKey, rows);
    while (this.measuredRows.size > VIEWPORT_MEASUREMENT_CACHE_LIMIT) {
      const oldestKey = this.measuredRows.keys().next().value as
        | string
        | undefined;
      if (oldestKey === undefined) break;
      this.measuredRows.delete(oldestKey);
      this.operationCounts.measurementCacheEvictions += 1;
    }
    this.operationCounts.cellsMeasured += 1;
    return rows;
  }

  private sameEntryCell(
    entry: ViewportCellEntry,
    cell: HistoryCell,
    contentKey: string,
  ): boolean {
    this.operationCounts.cellsCompared += 1;
    return (
      entry.cellId === cell.record.cell_id &&
      entry.cacheKey === cell.cacheKey() &&
      entry.contentKey === contentKey
    );
  }

  private cellContentKey(cell: HistoryCell): string {
    return `${cell.cacheKey()}:${JSON.stringify(cell.toRecord())}`;
  }

  private sameStringArray(
    left: readonly string[],
    right: readonly string[] | null,
  ): boolean {
    if (right === null || left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
      if (left[index] !== right[index]) return false;
    }
    return true;
  }

  private shouldResetViewport(cells: readonly HistoryCell[]): boolean {
    if (cells.length === 0) return this.entries.length > 0;
    if (this.entries.length === 0) return false;

    const sharesCellId = cells.some((cell) =>
      this.entryIndexByCellId.has(cell.record.cell_id),
    );
    if (!sharesCellId) return true;

    const previousThreadId = this.entries[0]?.cell.record.thread_id;
    const nextThreadId = cells[0]?.record.thread_id;
    return (
      previousThreadId !== undefined &&
      nextThreadId !== undefined &&
      previousThreadId !== nextThreadId
    );
  }

  private clearSyncSource(): void {
    this.lastCommittedCells = null;
    this.lastCommittedContentKeys = null;
    this.lastActiveCell = null;
    this.lastActiveContentKey = null;
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
    for (
      let entryIndex = firstEntry;
      entryIndex < this.entries.length;
      entryIndex += 1
    ) {
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
    if (
      this.searchIndexBuiltVersion === this.searchIndexVersion &&
      this.searchIndex.isWarm
    ) {
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
      cellsCompared: 0,
      indexEntriesRebuilt: 0,
      cachedRevisionCount: this.measuredRows.size,
      measurementCacheEvictions: 0,
      visibleEntriesVisited: 0,
      visibleLookupSteps: 0,
      widthReflows: 0,
    };
  }

  /** Return a snapshot of viewport work performed since the last reset. */
  getOperationCounts(): ViewportOperationCounts {
    return {
      ...this.operationCounts,
      cachedRevisionCount: this.measuredRows.size,
    };
  }
}
