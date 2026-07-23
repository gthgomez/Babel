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

export class HistoryCellViewport {
  private width: number;
  private entries: ViewportCellEntry[] = [];
  private totalRows = 0;
  /** Rows scrolled above the live bottom (0 = pinned to latest). */
  private scrollOffset = 0;
  private unseenSinceLastView = 0;
  private lastSyncKey = '';
  private searchIndex = new TranscriptSearchIndex();
  private searchIndexKey = '';

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
    this.width = next;
    this.rebuildFromCells(this.entries.map((entry) => entry.cell));
  }

  /** Replace viewport contents from an ordered cell list. */
  setCells(cells: HistoryCell[]): void {
    this.rebuildFromCells(cells);
    this.lastSyncKey = cells.map((cell) => cell.cacheKey()).join('|');
  }

  /** Incrementally sync from a HistoryTranscript (committed + active tail). */
  syncFromTranscript(transcript: HistoryTranscript): void {
    const cells = [...transcript.getCommittedCells()];
    const active = transcript.getActiveCell();
    if (active) cells.push(active);

    const syncKey = [
      ...cells.map((cell) => cell.cacheKey()),
      String(this.width),
    ].join('|');
    if (syncKey === this.lastSyncKey) return;

    const wasAtBottom = this.scrollOffset === 0;
    const prevTotal = this.totalRows;
    this.rebuildFromCells(cells);
    this.lastSyncKey = syncKey;

    if (!wasAtBottom && this.totalRows > prevTotal) {
      this.unseenSinceLastView += this.totalRows - prevTotal;
    }
  }

  private rebuildFromCells(cells: HistoryCell[]): void {
    const entries: ViewportCellEntry[] = [];
    let startRow = 0;

    for (const cell of cells) {
      const rows = flattenCellRows(cell, this.width);
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
    if (this.scrollOffset > this.maxScrollOffset) {
      this.scrollOffset = this.maxScrollOffset;
    }
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
    const endExclusive = this.totalRows - this.scrollOffset;
    const startInclusive = Math.max(0, endExclusive - height);

    const result: string[] = [];
    for (const entry of this.entries) {
      const entryEnd = entry.startRow + entry.rows.length;
      if (entryEnd <= startInclusive) continue;
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
    for (let i = 0; i < this.entries.length; i++) {
      const entry = this.entries[i]!;
      const end = entry.startRow + entry.rows.length;
      if (row >= entry.startRow && row < end) return i;
    }
    return -1;
  }

  /** Scroll so the top of cell `index` is near the top of the viewport. */
  scrollToCell(index: number, viewportHeight: number): void {
    if (index < 0 || index >= this.entries.length) return;
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
    const key = [
      ...this.entries.map((entry) => entry.cacheKey),
      String(this.width),
    ].join('|');
    if (key === this.searchIndexKey && this.searchIndex.isWarm) return 0;
    const ms = this.searchIndex.warmFromViewportEntries(this.entries);
    this.searchIndexKey = key;
    return ms;
  }

  /** Search warmed rows (auto-warms when needed). */
  search(query: string): TranscriptSearchMatch[] {
    if (!this.searchIndex.isWarm || this.searchIndexKey !== this.currentSearchKey()) {
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

  private currentSearchKey(): string {
    return [
      ...this.entries.map((entry) => entry.cacheKey),
      String(this.width),
    ].join('|');
  }
}