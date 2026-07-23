/**
 * TerminalBuffer — line/cell-level diff buffer for terminal output.
 * Line-level (render) captures 80%+ unchanged lines with minimal complexity.
 * Cell-level (renderCells) emits only individual changed characters,
 * reducing per-frame I/O by 10-100x for counters, spinners, etc.
 */

interface LineCache {
  lines: string[];
  row: number;
  col: number;
}

export interface Cell {
  char: string;
  style: number; // hash of the ANSI SGR sequence, or 0 for unstyled
}

interface CellCache {
  cells: Cell[][];
  row: number;
  col: number;
}

// ── Style cache ─────────────────────────────────────────────────────

const sgrCache = new Map<string, number>();
const sgrById = new Map<number, string>();
let nextSgrId = 1;

function sgrId(sgr: string): number {
  let id = sgrCache.get(sgr);
  if (id !== undefined) return id;
  id = nextSgrId++;
  sgrCache.set(sgr, id);
  sgrById.set(id, sgr);
  return id;
}

// ── ANSI parser ─────────────────────────────────────────────────────

/**
 * Parse a string with ANSI escape sequences into an array of cells.
 * Each cell captures the visible character and the active SGR style.
 */
export function parseAnsiCells(line: string): Cell[] {
  const cells: Cell[] = [];
  const sgrParts: string[] = [];
  let sgrStr = '';
  let i = 0;

  while (i < line.length) {
    if (line[i] === '\x1b' && i + 1 < line.length && line[i + 1] === '[') {
      const start = i;
      i += 2;
      while (i < line.length && !/[a-zA-Z]/.test(line.charAt(i))) i++;
      if (i < line.length) i++;
      const seq = line.slice(start, i);

      if (seq.endsWith('m')) {
        if (seq === '\x1b[0m' || seq === '\x1b[m') {
          sgrParts.length = 0;
          sgrStr = '';
        } else {
          sgrParts.push(seq);
          sgrStr = sgrParts.join('');
        }
      }
    } else {
      cells.push({ char: line[i] ?? '', style: sgrStr ? sgrId(sgrStr) : 0 });
      i++;
    }
  }

  return cells;
}

export class TerminalBuffer {
  private regions = new Map<string, LineCache>();
  private lastTotalLines = new Map<string, number>();
  private cellRegions = new Map<string, CellCache>();

  // ── Metrics ─────────────────────────────────────────────────────────────

  /** Total cells changed across all render()/renderCells() calls since instantiation or last resetStats(). */
  private _totalCellsChanged = 0;

  /** Cells changed in the most recent render call. */
  private _lastRenderCellCount = 0;

  /**
   * Render with line-level diffing. Returns ANSI to update the terminal
   * from the previous state, or '' if nothing changed.
   */
  render(region: string, lines: string[], startRow = 1, startCol = 1): string {
    const cache = this.regions.get(region);
    const prevLines = cache?.lines ?? [];
    const prevRow = cache?.row ?? startRow;
    const prevCol = cache?.col ?? startCol;
    const prevCount = this.lastTotalLines.get(region) ?? 0;

    if (prevRow !== startRow || prevCol !== startCol) {
      this.regions.set(region, { lines: [...lines], row: startRow, col: startCol });
      this.lastTotalLines.set(region, lines.length);
      const cellCount = lines.reduce((s, l) => s + l.length, 0);
      this._totalCellsChanged += cellCount;
      this._lastRenderCellCount = cellCount;
      return this.fullPaint(lines, startRow, startCol);
    }

    if (lines.length !== prevCount) {
      this.regions.set(region, { lines: [...lines], row: startRow, col: startCol });
      this.lastTotalLines.set(region, lines.length);
      const cellCount = lines.reduce((s, l) => s + l.length, 0);
      this._totalCellsChanged += cellCount;
      this._lastRenderCellCount = cellCount;
      return this.fullPaint(lines, startRow, startCol);
    }

    const updates: string[] = [];
    let cellsChanged = 0;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i] !== prevLines[i]) {
        updates.push(`\x1b[${startRow + i};${startCol}H\x1b[K${lines[i]}`);
        cellsChanged += lines[i]!.length;
      }
    }

    this._totalCellsChanged += cellsChanged;
    this._lastRenderCellCount = cellsChanged;

    if (updates.length === 0) return '';

    this.regions.set(region, { lines: [...lines], row: startRow, col: startCol });
    this.lastTotalLines.set(region, lines.length);

    return updates.join('');
  }

  /**
   * Render with cell-level diffing — emits only individual characters that
   * changed. Parses ANSI-styled input into cells and compares against cache.
   * Reduces per-frame I/O by 10-100x for counters, spinners, etc.
   */
  renderCells(region: string, styledLines: string[], startRow?: number, startCol?: number): string {
    const row = startRow ?? 1;
    const col = startCol ?? 1;
    const cache = this.cellRegions.get(region);
    const newCells: Cell[][] = new Array(styledLines.length);
    for (let i = 0; i < styledLines.length; i++) newCells[i] = parseAnsiCells(styledLines[i] ?? '');

    if (
      !cache ||
      cache.row !== row ||
      cache.col !== col ||
      cache.cells.length !== newCells.length
    ) {
      this.cellRegions.set(region, { cells: newCells, row, col });
      const cellCount = newCells.reduce((s, row) => s + row.length, 0);
      this._totalCellsChanged += cellCount;
      this._lastRenderCellCount = cellCount;
      return this.cellFullPaint(newCells, row, col);
    }

    const prevCells = cache.cells;
    const output: string[] = [];
    let cellsChanged = 0;

    for (let r = 0; r < newCells.length; r++) {
      const prevRow = prevCells[r] ?? [];
      const newRow = newCells[r]!;

      if (prevRow.length !== newRow.length) {
        output.push(this.cellFormatRow(newRow, row + r, col));
        cellsChanged += newRow.length;
        continue;
      }

      let segStart: number | null = null;

      for (let c = 0; c < newRow.length; c++) {
        const changed =
          prevRow[c]!.char !== newRow[c]!.char || prevRow[c]!.style !== newRow[c]!.style;

        if (changed) {
          cellsChanged++;
          if (segStart === null) segStart = c;
        } else if (!changed && segStart !== null) {
          output.push(this.cellFormatSegment(newRow, segStart, c - 1, row + r, col));
          segStart = null;
        }
      }

      if (segStart !== null) {
        output.push(this.cellFormatSegment(newRow, segStart, newRow.length - 1, row + r, col));
      }
    }

    this._totalCellsChanged += cellsChanged;
    this._lastRenderCellCount = cellsChanged;

    if (output.length === 0) return '';

    this.cellRegions.set(region, { cells: newCells, row, col });
    return output.join('');
  }

  /** Clear cache for a region (forces full repaint next render). */
  invalidate(region?: string): void {
    if (region) {
      this.regions.delete(region);
      this.lastTotalLines.delete(region);
      this.cellRegions.delete(region);
    } else {
      this.regions.clear();
      this.lastTotalLines.clear();
      this.cellRegions.clear();
    }
  }

  // ── Metrics ────────────────────────────────────────────────────────────

  /** Total cells changed across all render calls since instantiation or last resetStats(). */
  get totalCellsChanged(): number {
    return this._totalCellsChanged;
  }

  /** Cells changed in the most recent render call. */
  get lastRenderCellCount(): number {
    return this._lastRenderCellCount;
  }

  /** Reset all metrics counters. Does not affect cached regions. */
  resetStats(): void {
    this._totalCellsChanged = 0;
    this._lastRenderCellCount = 0;
  }

  // ── private ─────────────────────────────────────────────────────

  private fullPaint(lines: string[], startRow: number, startCol: number): string {
    const parts: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      parts.push(`\x1b[${startRow + i};${startCol}H\x1b[K${lines[i]}`);
    }
    return parts.join('');
  }

  private cellFullPaint(cells: Cell[][], row: number, col: number): string {
    const parts: string[] = [];
    for (let r = 0; r < cells.length; r++) {
      parts.push(this.cellFormatRow(cells[r]!, row + r, col));
    }
    return parts.join('');
  }

  private cellFormatRow(cells: Cell[], row: number, col: number): string {
    const parts: string[] = [`\x1b[${row};${col}H\x1b[K\x1b[0m`];
    let curStyle = 0;
    for (const c of cells) {
      if (c.style !== curStyle) {
        if (c.style !== 0) parts.push(sgrById.get(c.style)!);
        curStyle = c.style;
      }
      parts.push(c.char);
    }
    return parts.join('');
  }

  private cellFormatSegment(
    cells: Cell[],
    from: number,
    to: number,
    row: number,
    col: number,
  ): string {
    const parts: string[] = [`\x1b[${row};${col + from}H\x1b[0m`];
    let curStyle = 0;
    for (let i = from; i <= to; i++) {
      const c = cells[i]!;
      if (c.style !== curStyle) {
        if (c.style !== 0) parts.push(sgrById.get(c.style)!);
        curStyle = c.style;
      }
      parts.push(c.char);
    }
    return parts.join('');
  }
}
