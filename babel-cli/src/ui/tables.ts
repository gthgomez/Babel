import { renderBadge } from './badges.js';
import {
  muted,
  primary,
  bold,
  getTerminalWidth,
  getEffectiveTerminalWidth,
  formatOverflow,
} from './theme.js';

export interface LabeledRow {
  label: string;
  value: string | number;
}

export interface LabeledRowsOptions {
  indent?: string;
  labelWidth?: number;
  overflow?: string;
}

export function renderLabeledRows(rows: LabeledRow[], options: LabeledRowsOptions = {}): string {
  const width = getTerminalWidth();
  const indent = options.indent ?? '  ';
  const labelWidth = options.labelWidth ?? 20;
  const overflow = options.overflow ?? 'truncate';
  return rows
    .filter((row) => row && row.label && row.value !== undefined)
    .map((row) => {
      const label = muted(`${String(row.label).padEnd(labelWidth)}`);
      const valueLines = formatOverflow(
        String(row.value),
        Math.max(12, width - labelWidth - indent.length - 4),
        overflow,
      );
      return valueLines
        .map((value, index) => {
          const styledValue = primary(value);
          if (index === 0) {
            return `${indent}${label} ${styledValue}`;
          }
          return `${indent}${muted(' '.repeat(labelWidth))} ${styledValue}`;
        })
        .join('\n');
    })
    .join('\n');
}

export interface CheckRow {
  label: string;
  detail: string;
  status: string;
}

export interface CheckRowsOptions {
  indent?: string;
  overflow?: string;
  labelWidth?: number;
}

export function renderCheckRows(rows: CheckRow[], options: CheckRowsOptions = {}): string {
  const width = getTerminalWidth();
  const indent = options.indent ?? '  ';
  const overflow = options.overflow ?? 'truncate';
  return rows
    .filter(Boolean)
    .map((row) => {
      const labelWidth = Math.min(26, options.labelWidth ?? 26);
      const labelLines = formatOverflow(String(row.label), labelWidth, overflow);
      const detailWidth = Math.max(20, width - indent.length - labelWidth - 18);
      const detailLines = formatOverflow(String(row.detail), detailWidth, overflow);
      const lineCount = Math.max(labelLines.length, detailLines.length);
      const lines: string[] = [];
      for (let index = 0; index < lineCount; index++) {
        const label = (labelLines[index] ?? '').padEnd(labelWidth);
        const detail = detailLines[index] ?? '';
        const prefix = index === 0 ? renderBadge(row.status) : muted(' '.repeat(9));
        lines.push(`${indent}${prefix} ${muted(label)} ${primary(detail)}`);
      }
      return lines.join('\n');
    })
    .join('\n');
}

export function renderOrderedList(items: string[], options: CheckRowsOptions = {}): string {
  const width = getTerminalWidth();
  const indent = options.indent ?? '  ';
  const overflow = options.overflow ?? 'truncate';
  return items
    .filter((item) => item !== undefined && item !== null && String(item).trim().length > 0)
    .map((item, index) => {
      const number = muted(String(index + 1).padStart(2, '0'));
      const itemLines = formatOverflow(
        String(item),
        Math.max(16, width - indent.length - 4),
        overflow,
      );
      return itemLines
        .map((line, lineIndex) =>
          lineIndex === 0
            ? `${indent}${number} ${primary(line)}`
            : `${indent}${muted('  ')} ${primary(line)}`,
        )
        .join('\n');
    })
    .join('\n');
}

// ── Content-aware table rendering ───────────────────────────────────────────

/** Minimum width required for columnar table rendering. Below this, K/V format is used. */
const TABLE_COLUMNAR_THRESHOLD = 60;

export interface MarkdownTableRow {
  cells: string[];
}

/**
 * Render markdown pipe-table rows into terminal output.
 *
 * Automatically selects the best format:
 *   - **Columnar**: when terminal width >= 60 cols — traditional aligned columns
 *   - **Key/Value**: when terminal width < 60 cols — each row becomes a K/V record
 *     block with the header cell as a bold label and the value on the next line.
 *
 * This prevents the common problem of pipe tables becoming unreadable on narrow
 * terminals (e.g., split panes, mobile SSH clients).
 *
 * Ported from codex content-aware table column allocation.
 *
 * @param headers - Column header labels
 * @param rows - Array of rows (each row is an array of cell values)
 * @param options - Rendering options
 * @returns Rendered table as a string
 */
export function renderContentAwareTable(
  headers: string[],
  rows: MarkdownTableRow[],
  options: CheckRowsOptions = {},
): string {
  const width = getEffectiveTerminalWidth();

  if (width < TABLE_COLUMNAR_THRESHOLD) {
    return renderTableAsKeyValue(headers, rows, options);
  }
  return renderTableAsColumns(headers, rows, options, width);
}

/** Render a table in columnar format with aligned columns. */
function renderTableAsColumns(
  headers: string[],
  rows: MarkdownTableRow[],
  options: CheckRowsOptions,
  width: number,
): string {
  const indent = options.indent ?? '  ';
  const colCount = headers.length;
  if (colCount === 0 || rows.length === 0) return '';

  // Calculate column widths: allocate proportionally
  // Narrative columns (wider text) get more space; compact columns get less
  const availableWidth = Math.max(20, width - indent.length - (colCount - 1) * 3 - 2);

  // Compute natural widths based on content
  const naturalWidths: number[] = headers.map((h, i) => {
    const headerLen = h.length;
    const maxCellLen = Math.max(...rows.map((r) => (r.cells[i] ?? '').length));
    return Math.max(headerLen, maxCellLen);
  });

  // Distribute: narrative columns > token-dense > compact
  const totalNatural = naturalWidths.reduce((s, w) => s + w, 0);
  const colWidths: number[] = naturalWidths.map((nw, i) => {
    if (i === 0) {
      // First column (usually the label): give it up to 35% of space
      return Math.max(8, Math.min(nw, Math.floor(availableWidth * 0.35)));
    }
    // Remaining columns split proportionally
    return Math.max(6, Math.min(nw, Math.floor(availableWidth / colCount)));
  });

  const lines: string[] = [];

  // Header row
  const headerCells = headers.map((h, i) => h.padEnd(colWidths[i]!).slice(0, colWidths[i]!));
  lines.push(`${indent}${bold(headerCells.join(' │ '))}`);

  // Separator
  const sepCells = colWidths.map((w) => '─'.repeat(w!));
  lines.push(`${indent}${muted(sepCells.join('─┼─'))}`);

  // Data rows
  for (const row of rows) {
    const cells = row.cells.map((cell, i) => {
      const text = String(cell ?? '');
      return text.padEnd(colWidths[i]!).slice(0, colWidths[i]!);
    });
    lines.push(`${indent}${cells.join(' │ ')}`);
  }

  return lines.join('\n');
}

/** Render a table as key/value records (narrow terminal format). */
function renderTableAsKeyValue(
  headers: string[],
  rows: MarkdownTableRow[],
  options: CheckRowsOptions,
): string {
  const indent = options.indent ?? '  ';
  const width = getEffectiveTerminalWidth();
  const valueWidth = Math.max(20, width - indent.length - 2);

  const lines: string[] = [];

  for (let ri = 0; ri < rows.length; ri++) {
    const row = rows[ri]!;
    if (ri > 0) {
      lines.push(muted(`${indent}${'─'.repeat(Math.min(40, width - indent.length))}`));
    }
    for (let ci = 0; ci < headers.length; ci++) {
      const label = bold(headers[ci]!);
      const value = String(row.cells[ci] ?? '');
      const valueLines = formatOverflow(value, valueWidth, options.overflow ?? 'wrap');
      if (valueLines.length === 1) {
        lines.push(`${indent}${label}: ${primary(valueLines[0]!)}`);
      } else {
        lines.push(`${indent}${label}:`);
        for (const vLine of valueLines) {
          lines.push(`${indent}  ${primary(vLine)}`);
        }
      }
    }
  }

  return lines.join('\n');
}

// ── Markdown pipe table parsing ─────────────────────────────────────────────

/**
 * Parse a markdown pipe table string into headers and rows.
 *
 * Handles standard GFM pipe tables:
 *   | Header 1 | Header 2 |
 *   |----------|----------|
 *   | Cell 1   | Cell 2   |
 *
 * @param text - Raw markdown pipe table text
 * @returns Parsed headers and rows, or null if parsing fails
 */
export function parsePipeTable(
  text: string,
): { headers: string[]; rows: MarkdownTableRow[] } | null {
  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length < 2) return null;

  // First line should be a header row
  const headerMatch = lines[0]?.match(/^\|?\s*([^|]+(?:\s*\|\s*[^|]+)*)\s*\|?$/);
  if (!headerMatch) return null;

  const headers = headerMatch[1]!
    .split('|')
    .map((h) => h.trim())
    .filter((h) => h.length > 0);
  if (headers.length === 0) return null;

  // Second line should be a separator row
  const sepMatch = lines[1]?.match(/^\|?\s*([-:]+\s*(?:\|\s*[-:]+\s*)*)\s*\|?$/);
  if (!sepMatch) return null;

  // Remaining lines are data rows
  const rows: MarkdownTableRow[] = [];
  for (let i = 2; i < lines.length; i++) {
    const rowMatch = lines[i]?.match(/^\|?\s*([^|]+(?:\s*\|\s*[^|]+)*)\s*\|?$/);
    if (!rowMatch) continue;
    const cells = rowMatch[1]!.split('|').map((c) => c.trim());
    if (cells.length === headers.length) {
      rows.push({ cells });
    }
  }

  return { headers, rows };
}
