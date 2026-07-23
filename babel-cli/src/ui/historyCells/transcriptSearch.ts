/**
 * Warm transcript search index — pre-lowercased row text for O(1) keystroke search.
 *
 * Modeled on Claude Code transcriptSearch + VirtualMessageList.warmSearchIndex():
 * build the searchable corpus once when the pager opens, then indexOf per query.
 */

import { stripAnsi } from '../theme.js';
import type { HistoryCell } from './historyCell.js';
import { flattenCellRows } from './layout.js';
import type { ViewportCellEntry } from './viewport.js';

export interface TranscriptSearchMatch {
  /** Physical row index (0 = oldest). */
  rowIndex: number;
  /** Cell containing this row, when indexed from viewport entries. */
  cellId?: string;
}

/** Plain searchable text for a single history cell at a terminal width. */
export function historyCellSearchText(cell: HistoryCell, width: number): string {
  return flattenCellRows(cell, width)
    .map((row) => stripAnsi(row))
    .join('\n')
    .toLowerCase();
}

export class TranscriptSearchIndex {
  private rows: string[] = [];
  private rowToCellId: (string | undefined)[] = [];
  private warmedKey = '';

  get isWarm(): boolean {
    return this.rows.length > 0;
  }

  get totalRows(): number {
    return this.rows.length;
  }

  get warmedCacheKey(): string {
    return this.warmedKey;
  }

  /** Build index from flattened viewport rows. Returns warm duration in ms. */
  warmFromViewportEntries(entries: readonly ViewportCellEntry[]): number {
    const start = performance.now();
    const rows: string[] = [];
    const cellIds: (string | undefined)[] = [];

    for (const entry of entries) {
      for (const row of entry.rows) {
        rows.push(stripAnsi(row).toLowerCase());
        cellIds.push(entry.cellId);
      }
    }

    this.rows = rows;
    this.rowToCellId = cellIds;
    this.warmedKey = entries.map((entry) => entry.cacheKey).join('|');
    return performance.now() - start;
  }

  /** Build index from raw display lines (scrollback fallback). Returns warm duration in ms. */
  warmFromLines(lines: string[]): number {
    const start = performance.now();
    this.rows = lines.map((line) => stripAnsi(line).toLowerCase());
    this.rowToCellId = lines.map(() => undefined);
    this.warmedKey = `lines:${lines.length}`;
    return performance.now() - start;
  }

  /** Case-insensitive substring search over warmed rows. */
  search(query: string): TranscriptSearchMatch[] {
    const trimmed = query.trim();
    if (!trimmed || this.rows.length === 0) return [];

    const queryLower = trimmed.toLowerCase();
    const matches: TranscriptSearchMatch[] = [];

    for (let i = 0; i < this.rows.length; i++) {
      if (this.rows[i]!.includes(queryLower)) {
        const cellId = this.rowToCellId[i];
        const match: TranscriptSearchMatch = { rowIndex: i };
        if (cellId !== undefined) match.cellId = cellId;
        matches.push(match);
      }
    }

    return matches;
  }
}