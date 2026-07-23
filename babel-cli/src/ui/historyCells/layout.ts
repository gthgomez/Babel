import { stripAnsi, wrapText } from '../theme.js';
import type { HistoryCell } from './historyCell.js';

export type HistoryRenderMode = 'rich' | 'raw';

/** Measure how many terminal rows logical lines occupy at a given width. */
export function measureDisplayHeight(lines: string[], width: number): number {
  if (width <= 0) return 0;
  let rows = 0;
  for (const line of lines) {
    const wrapped = wrapText(line.length === 0 ? ' ' : line, width);
    rows += Math.max(1, wrapped.length);
  }
  return rows;
}

/** Expand logical display lines into one physical terminal row per entry. */
export function flattenDisplayRows(lines: string[], width: number): string[] {
  if (width <= 0) return [];
  const rows: string[] = [];
  for (const line of lines) {
    const wrapped = wrapText(line.length === 0 ? ' ' : line, width);
    if (wrapped.length === 0) {
      rows.push('');
    } else {
      rows.push(...wrapped);
    }
  }
  return rows.length > 0 ? rows : [''];
}

/** Flatten a cell's display output to physical rows at a terminal width. */
export function flattenCellRows(cell: HistoryCell, width: number): string[] {
  return flattenDisplayRows(cell.displayLines(width), width);
}

export function plainLines(lines: string[]): string[] {
  return lines.map((line) => stripAnsi(line));
}