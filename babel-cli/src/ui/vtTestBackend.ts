/**
 * VtTestBackend — VT100-class screen model for TUI tests (G4).
 *
 * Parses a practical subset of ANSI sequences into a cell grid so tests can
 * assert cursor position, scroll regions, and visible text — not just byte dumps.
 *
 * Supported sequences (v1):
 *   - CUP: CSI row;col H / CSI row;col f
 *   - CUU/CUD/CUF/CUB: CSI n A/B/C/D
 *   - EL: CSI K / CSI 0 K / CSI 1 K / CSI 2 K
 *   - ED: CSI J / CSI 0-2 J
 *   - SGR: CSI … m  (attributes recorded; text still stored)
 *   - DECSTBM: CSI top;bottom r
 *   - DEC 2026: CSI ?2026 h/l (ignored)
 *   - CR, LF, BS, plain printable text
 *
 * @module vtTestBackend
 */

export interface VtCell {
  ch: string;
  /** Compact SGR attribute bag (bold/dim/fg/bg) — optional for assertions */
  attrs: number;
}

export interface VtScreenshot {
  rows: number;
  cols: number;
  cursorRow: number; // 1-based
  cursorCol: number; // 1-based
  scrollTop: number;
  scrollBottom: number;
  /** Plain text lines (trailing spaces trimmed per line) */
  lines: string[];
}

export class VtTestBackend {
  readonly rows: number;
  readonly cols: number;
  private grid: VtCell[][];
  private cursorRow = 1; // 1-based
  private cursorCol = 1;
  private scrollTop = 1;
  private scrollBottom: number;
  private attrs = 0;
  private rawLog: string[] = [];

  constructor(rows = 24, cols = 80) {
    this.rows = Math.max(1, rows);
    this.cols = Math.max(1, cols);
    this.scrollBottom = this.rows;
    this.grid = this.blankGrid();
  }

  private blankGrid(): VtCell[][] {
    return Array.from({ length: this.rows }, () =>
      Array.from({ length: this.cols }, () => ({ ch: ' ', attrs: 0 })),
    );
  }

  reset(): void {
    this.grid = this.blankGrid();
    this.cursorRow = 1;
    this.cursorCol = 1;
    this.scrollTop = 1;
    this.scrollBottom = this.rows;
    this.attrs = 0;
    this.rawLog = [];
  }

  /** Write ANSI/text (same entry point as a terminal). */
  write(text: string): void {
    if (!text) return;
    this.rawLog.push(text);
    this.feed(text);
  }

  getRawOutput(): string {
    return this.rawLog.join('');
  }

  getCursor(): { row: number; col: number } {
    return { row: this.cursorRow, col: this.cursorCol };
  }

  getScrollRegion(): { top: number; bottom: number } {
    return { top: this.scrollTop, bottom: this.scrollBottom };
  }

  getCell(row: number, col: number): VtCell {
    const r = Math.max(1, Math.min(this.rows, row)) - 1;
    const c = Math.max(1, Math.min(this.cols, col)) - 1;
    return this.grid[r]![c]!;
  }

  /** Plain character at 1-based coordinates. */
  charAt(row: number, col: number): string {
    return this.getCell(row, col).ch;
  }

  screenshotStripped(): VtScreenshot {
    const lines = this.grid.map((row) => row.map((c) => c.ch).join('').replace(/\s+$/, ''));
    return {
      rows: this.rows,
      cols: this.cols,
      cursorRow: this.cursorRow,
      cursorCol: this.cursorCol,
      scrollTop: this.scrollTop,
      scrollBottom: this.scrollBottom,
      lines,
    };
  }

  /** Full screen as joined lines (trailing spaces trimmed). */
  getPlainScreen(): string {
    return this.screenshotStripped().lines.join('\n');
  }

  // ── Parser ─────────────────────────────────────────────────────────────

  private feed(input: string): void {
    let i = 0;
    while (i < input.length) {
      const ch = input[i]!;

      // ESC sequences
      if (ch === '\x1b') {
        i = this.consumeEsc(input, i);
        continue;
      }

      if (ch === '\r') {
        this.cursorCol = 1;
        i++;
        continue;
      }

      if (ch === '\n') {
        this.lineFeed();
        i++;
        continue;
      }

      if (ch === '\b') {
        if (this.cursorCol > 1) this.cursorCol--;
        i++;
        continue;
      }

      if (ch === '\t') {
        const next = Math.min(this.cols, this.cursorCol + (8 - ((this.cursorCol - 1) % 8)));
        this.cursorCol = next;
        i++;
        continue;
      }

      // Skip other C0 controls
      if (ch < ' ') {
        i++;
        continue;
      }

      this.putChar(ch);
      i++;
    }
  }

  private consumeEsc(input: string, start: number): number {
    // start points at ESC
    if (start + 1 >= input.length) return start + 1;
    const next = input[start + 1]!;

    // CSI: ESC [
    if (next === '[') {
      return this.consumeCsi(input, start + 2);
    }

    // OSC: ESC ] ... BEL or ST
    if (next === ']') {
      let i = start + 2;
      while (i < input.length) {
        if (input[i] === '\x07') return i + 1;
        if (input[i] === '\x1b' && input[i + 1] === '\\') return i + 2;
        i++;
      }
      return input.length;
    }

    // Single-char ESC (ignore)
    return start + 2;
  }

  private consumeCsi(input: string, start: number): number {
    // Collect parameter / intermediate bytes
    let i = start;
    while (i < input.length) {
      const b = input.charCodeAt(i);
      if ((b >= 0x30 && b <= 0x3f) || (b >= 0x20 && b <= 0x2f)) {
        i++;
        continue;
      }
      break;
    }
    if (i >= input.length) return input.length;
    const final = input[i]!;
    const params = input.slice(start, i);
    this.applyCsi(params, final);
    return i + 1;
  }

  private parseParams(params: string): number[] {
    // Strip leading ? for private modes
    const body = params.startsWith('?') ? params.slice(1) : params;
    if (!body) return [];
    return body.split(';').map((p) => {
      const n = parseInt(p, 10);
      return Number.isFinite(n) ? n : 0;
    });
  }

  private applyCsi(params: string, final: string): void {
    const nums = this.parseParams(params);
    const n1 = nums[0] && nums[0] > 0 ? nums[0] : 1;
    const n2 = nums[1] && nums[1] > 0 ? nums[1] : 1;

    switch (final) {
      case 'H':
      case 'f': {
        const row = nums[0] && nums[0] > 0 ? nums[0] : 1;
        const col = nums[1] && nums[1] > 0 ? nums[1] : 1;
        this.cursorRow = Math.min(this.rows, Math.max(1, row));
        this.cursorCol = Math.min(this.cols, Math.max(1, col));
        break;
      }
      case 'A':
        this.cursorRow = Math.max(1, this.cursorRow - n1);
        break;
      case 'B':
        this.cursorRow = Math.min(this.rows, this.cursorRow + n1);
        break;
      case 'C':
        this.cursorCol = Math.min(this.cols, this.cursorCol + n1);
        break;
      case 'D':
        this.cursorCol = Math.max(1, this.cursorCol - n1);
        break;
      case 'K': {
        const mode = nums[0] ?? 0;
        const r = this.cursorRow - 1;
        if (mode === 0) {
          // clear to end of line
          for (let c = this.cursorCol - 1; c < this.cols; c++) {
            this.grid[r]![c] = { ch: ' ', attrs: 0 };
          }
        } else if (mode === 1) {
          for (let c = 0; c < this.cursorCol; c++) {
            this.grid[r]![c] = { ch: ' ', attrs: 0 };
          }
        } else if (mode === 2) {
          for (let c = 0; c < this.cols; c++) {
            this.grid[r]![c] = { ch: ' ', attrs: 0 };
          }
        }
        break;
      }
      case 'J': {
        const mode = nums[0] ?? 0;
        if (mode === 2 || mode === 3) {
          this.grid = this.blankGrid();
        } else if (mode === 0) {
          // clear from cursor to end of screen
          this.applyCsi('', 'K');
          for (let r = this.cursorRow; r < this.rows; r++) {
            for (let c = 0; c < this.cols; c++) {
              this.grid[r]![c] = { ch: ' ', attrs: 0 };
            }
          }
        }
        break;
      }
      case 'r': {
        // DECSTBM
        const top = nums[0] && nums[0] > 0 ? nums[0] : 1;
        const bottom = nums[1] && nums[1] > 0 ? nums[1] : this.rows;
        this.scrollTop = Math.max(1, Math.min(top, this.rows));
        this.scrollBottom = Math.max(this.scrollTop, Math.min(bottom, this.rows));
        this.cursorRow = 1;
        this.cursorCol = 1;
        break;
      }
      case 'm': {
        // SGR — store simple flags
        if (nums.length === 0 || nums[0] === 0) this.attrs = 0;
        else if (nums[0] === 1) this.attrs |= 1;
        else if (nums[0] === 2) this.attrs |= 2;
        break;
      }
      case 'h':
      case 'l':
        // DEC private modes (incl. 2026) — ignore
        break;
      default:
        break;
    }
  }

  private putChar(ch: string): void {
    const r = this.cursorRow - 1;
    const c = this.cursorCol - 1;
    if (r >= 0 && r < this.rows && c >= 0 && c < this.cols) {
      this.grid[r]![c] = { ch, attrs: this.attrs };
    }
    this.cursorCol++;
    if (this.cursorCol > this.cols) {
      this.cursorCol = 1;
      this.lineFeed();
    }
  }

  private lineFeed(): void {
    if (this.cursorRow < this.scrollBottom) {
      this.cursorRow++;
      return;
    }
    // Scroll within region
    const top = this.scrollTop - 1;
    const bottom = this.scrollBottom - 1;
    for (let r = top; r < bottom; r++) {
      this.grid[r] = this.grid[r + 1]!;
    }
    this.grid[bottom] = Array.from({ length: this.cols }, () => ({ ch: ' ', attrs: 0 }));
    this.cursorRow = this.scrollBottom;
  }
}
