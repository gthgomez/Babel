/**
 * VirtualCellGrid — VT subset for Babel TUI observation.
 *
 * Interprets the CSI/SGR/OSC sequences Babel actually emits and maintains
 * a primary + alternate cell matrix. `latest.txt` is derived from this grid,
 * never from stripAnsi or turnViewProjector.
 */

import stringWidth from 'string-width'
import { graphemeClusters } from '../textUtils.js'

export type TerminalColor =
  | { kind: 'default' }
  | { kind: 'rgb'; r: number; g: number; b: number }
  | { kind: 'indexed'; index: number }

export interface CellAttr {
  bold: boolean
  dim: boolean
  italic: boolean
  inverse: boolean
  fg: TerminalColor
  bg: TerminalColor
}

export interface Cell {
  ch: string
  width: 0 | 1 | 2
  attr: CellAttr
}

export interface StyleRun {
  row: number
  startCol: number
  endCol: number
  attr: CellAttr
}

export interface GridSnapshot {
  cols: number
  rows: number
  cursorCol: number
  cursorRow: number
  cursorVisible: boolean
  altScreen: boolean
  scrollTop: number
  scrollBottom: number
  lines: string[]
  hash: string
  textHash: string
  visualHash: string
  changedRows: number[]
  textChangedRows: number[]
  visualChangedRows: number[]
  styleRuns: StyleRun[]
}

const DEFAULT_ATTR: CellAttr = {
  bold: false,
  dim: false,
  italic: false,
  inverse: false,
  fg: { kind: 'default' },
  bg: { kind: 'default' },
}

function emptyCell(): Cell {
  return { ch: ' ', width: 1, attr: { ...DEFAULT_ATTR } }
}

function makeBuffer(cols: number, rows: number): Cell[][] {
  return Array.from({ length: rows }, () => Array.from({ length: cols }, () => emptyCell()))
}

function cloneAttr(attr: CellAttr): CellAttr {
  return {
    bold: attr.bold,
    dim: attr.dim,
    italic: attr.italic,
    inverse: attr.inverse,
    fg: { ...attr.fg },
    bg: { ...attr.bg },
  }
}

function attrEqual(a: CellAttr, b: CellAttr): boolean {
  if (a.bold !== b.bold || a.dim !== b.dim || a.italic !== b.italic || a.inverse !== b.inverse) {
    return false
  }
  if (a.fg.kind !== b.fg.kind || a.bg.kind !== b.bg.kind) return false
  if (a.fg.kind === 'indexed' && (b.fg as any).index !== a.fg.index) return false
  if (a.bg.kind === 'indexed' && (b.bg as any).index !== a.bg.index) return false
  if (a.fg.kind === 'rgb') {
    const bFg = b.fg as { kind: 'rgb'; r: number; g: number; b: number }
    if (a.fg.r !== bFg.r || a.fg.g !== bFg.g || a.fg.b !== bFg.b) return false
  }
  if (a.bg.kind === 'rgb') {
    const bBg = b.bg as { kind: 'rgb'; r: number; g: number; b: number }
    if (a.bg.r !== bBg.r || a.bg.g !== bBg.g || a.bg.b !== bBg.b) return false
  }
  return true
}

/**
 * Create a VT cell grid with Babel's CSI subset.
 *
 * @param cols Column count (must match the renderer)
 * @param rows Row count (must match the renderer)
 */
export function createVirtualCellGrid(cols: number, rows: number): VirtualCellGrid {
  return new VirtualCellGrid(cols, rows)
}

export class VirtualCellGrid {
  private cols: number
  private rows: number
  private primary: Cell[][]
  private alternate: Cell[][]
  private useAlt = false
  private cursorCol = 0
  private cursorRow = 0
  private savedCol = 0
  private savedRow = 0
  private cursorVisible = true
  private scrollTop = 0
  private scrollBottom: number
  private attr: CellAttr = { ...DEFAULT_ATTR }
  private pending = ''
  private lastLines: string[] = []
  private lastVisualRowHashes: string[] = []
  private writeSeq = 0
  private wrapPending = false

  constructor(cols: number, rows: number) {
    if (cols < 1 || rows < 1) {
      throw new Error(`VirtualCellGrid: invalid geometry ${cols}x${rows}`)
    }
    this.cols = cols
    this.rows = rows
    this.primary = makeBuffer(cols, rows)
    this.alternate = makeBuffer(cols, rows)
    this.scrollBottom = rows - 1
  }

  /** Monotonic count of applied write chunks. */
  getWriteSeq(): number {
    return this.writeSeq
  }

  getGeometry(): { cols: number; rows: number } {
    return { cols: this.cols, rows: this.rows }
  }

  /**
   * Resize the grid. Content is clipped; new cells are blank.
   * Does not reflow — caller must re-render for new geometry.
   */
  resize(cols: number, rows: number): void {
    if (cols === this.cols && rows === this.rows) return
    this.primary = resizeBuffer(this.primary, cols, rows)
    this.alternate = resizeBuffer(this.alternate, cols, rows)
    this.cols = cols
    this.rows = rows
    this.scrollTop = Math.min(this.scrollTop, rows - 1)
    this.scrollBottom = rows - 1
    this.cursorCol = Math.min(this.cursorCol, cols - 1)
    this.cursorRow = Math.min(this.cursorRow, rows - 1)
    this.wrapPending = false
  }

  /** Apply a UTF-8 terminal byte chunk (may be a partial CSI). */
  apply(chunk: string): void {
    if (!chunk) return
    this.writeSeq += 1
    const text = this.pending + chunk
    this.pending = ''
    let i = 0

    while (i < text.length) {
      const code = text.charCodeAt(i)
      if (code === 0x1b) {
        const consumed = this.consumeEscape(text, i)
        if (consumed < 0) {
          this.pending = text.slice(i)
          return
        }
        i += consumed
        continue
      }
      if (code === 0x0d) {
        this.wrapPending = false
        this.cursorCol = 0
        i += 1
        continue
      }
      if (code === 0x0a) {
        this.wrapPending = false
        this.cursorCol = 0
        this.lineFeed()
        i += 1
        continue
      }
      if (code === 0x08) {
        this.wrapPending = false
        this.cursorCol = Math.max(0, this.cursorCol - 1)
        i += 1
        continue
      }
      if (code === 0x09) {
        this.wrapPending = false
        this.cursorCol = Math.min(this.cols - 1, (Math.floor(this.cursorCol / 8) + 1) * 8)
        i += 1
        continue
      }
      if (code < 32) {
        i += 1
        continue
      }

      // Extract grapheme cluster using Intl.Segmenter
      const clusters = graphemeClusters(text.slice(i))
      const firstCluster = clusters[0] || text[i]!
      this.putChar(firstCluster)
      i += firstCluster.length
    }
  }

  snapshot(): GridSnapshot {
    const buf = this.active()
    const lines = buf.map((row) => rowToString(row))
    const textChangedRows: number[] = []
    const visualChangedRows: number[] = []
    const currentVisualRowHashes: string[] = []
    const styleRuns: StyleRun[] = []

    for (let r = 0; r < this.rows; r++) {
      const row = buf[r]!
      if (lines[r] !== this.lastLines[r]) {
        textChangedRows.push(r)
      }

      // Compute row visual hash & style runs
      let visualRepr = ''
      let currentRun: StyleRun | null = null

      for (let c = 0; c < row.length; c++) {
        const cell = row[c]!
        const attrStr = `${cell.attr.bold ? 'B' : ''}${cell.attr.dim ? 'D' : ''}${cell.attr.italic ? 'I' : ''}${cell.attr.inverse ? 'V' : ''}${JSON.stringify(cell.attr.fg)}${JSON.stringify(cell.attr.bg)}`
        visualRepr += `[${cell.ch}:${cell.width}:${attrStr}]`

        if (cell.ch !== ' ' || cell.attr.fg.kind !== 'default' || cell.attr.bg.kind !== 'default') {
          if (currentRun && attrEqual(currentRun.attr, cell.attr)) {
            currentRun.endCol = c + (cell.width === 2 ? 2 : 1)
          } else {
            if (currentRun) styleRuns.push(currentRun)
            currentRun = {
              row: r,
              startCol: c,
              endCol: c + (cell.width === 2 ? 2 : 1),
              attr: cloneAttr(cell.attr),
            }
          }
        } else if (currentRun) {
          styleRuns.push(currentRun)
          currentRun = null
        }
      }
      if (currentRun) {
        styleRuns.push(currentRun)
      }

      const rowVisualHash = fnv1a(visualRepr)
      currentVisualRowHashes.push(rowVisualHash)
      if (rowVisualHash !== this.lastVisualRowHashes[r]) {
        visualChangedRows.push(r)
      }
    }

    this.lastLines = lines
    this.lastVisualRowHashes = currentVisualRowHashes

    const textHash = fnv1a(lines.join('\n'))
    const visualHash = fnv1a(currentVisualRowHashes.join('\n'))

    return {
      cols: this.cols,
      rows: this.rows,
      cursorCol: this.cursorCol,
      cursorRow: this.cursorRow,
      cursorVisible: this.cursorVisible,
      altScreen: this.useAlt,
      scrollTop: this.scrollTop,
      scrollBottom: this.scrollBottom,
      lines,
      hash: textHash,
      textHash,
      visualHash,
      changedRows: textChangedRows,
      textChangedRows,
      visualChangedRows,
      styleRuns,
    }
  }

  private active(): Cell[][] {
    return this.useAlt ? this.alternate : this.primary
  }

  private consumeEscape(text: string, start: number): number {
    if (start + 1 >= text.length) return -1
    const next = text[start + 1]
    if (next === '[') return this.consumeCsi(text, start)
    if (next === ']') return this.consumeOsc(text, start)
    if (next === '(' || next === ')' || next === '*' || next === '+') {
      if (start + 2 >= text.length) return -1
      return 3
    }
    if (next === '7') {
      this.savedCol = this.cursorCol
      this.savedRow = this.cursorRow
      return 2
    }
    if (next === '8') {
      this.cursorCol = this.savedCol
      this.cursorRow = this.savedRow
      return 2
    }
    if (next === '=' || next === '>') return 2
    return 2
  }

  private consumeOsc(text: string, start: number): number {
    for (let i = start + 2; i < text.length; i++) {
      if (text.charCodeAt(i) === 0x07) return i - start + 1
      if (text.charCodeAt(i) === 0x1b && text[i + 1] === '\\') return i - start + 2
    }
    return -1
  }

  private consumeCsi(text: string, start: number): number {
    let i = start + 2
    if (i >= text.length) return -1
    if (text[i] === '?') i += 1
    while (i < text.length) {
      const c = text.charCodeAt(i)
      if ((c >= 0x40 && c <= 0x7e) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)) {
        const seq = text.slice(start, i + 1)
        this.applyCsi(seq)
        return i - start + 1
      }
      i += 1
    }
    return -1
  }

  private applyCsi(seq: string): void {
    this.wrapPending = false
    const priv = seq[2] === '?'
    const body = seq.slice(priv ? 3 : 2, -1)
    const final = seq[seq.length - 1]
    const params = body.length === 0 ? [] : body.split(';').map((p) => (p === '' ? 0 : Number.parseInt(p, 10)))
    const p = (n: number, d: number): number => {
      const v = params[n]
      return v === undefined || v === 0 || Number.isNaN(v) ? d : v
    }

    if (priv) {
      const n = p(0, 0)
      if (final === 'h' && (n === 25)) this.cursorVisible = true
      if (final === 'l' && (n === 25)) this.cursorVisible = false
      if ((n === 1049 || n === 47) && final === 'h') {
        this.useAlt = true
        this.alternate = makeBuffer(this.cols, this.rows)
        this.cursorCol = 0
        this.cursorRow = 0
      }
      if ((n === 1049 || n === 47) && final === 'l') {
        this.useAlt = false
        this.cursorCol = 0
        this.cursorRow = 0
      }
      return
    }

    switch (final) {
      case 'A':
        this.cursorRow = Math.max(0, this.cursorRow - p(0, 1))
        break
      case 'B':
        this.cursorRow = Math.min(this.rows - 1, this.cursorRow + p(0, 1))
        break
      case 'C':
        this.cursorCol = Math.min(this.cols - 1, this.cursorCol + p(0, 1))
        break
      case 'D':
        this.cursorCol = Math.max(0, this.cursorCol - p(0, 1))
        break
      case 'H':
      case 'f':
        this.cursorRow = Math.min(this.rows - 1, Math.max(0, p(0, 1) - 1))
        this.cursorCol = Math.min(this.cols - 1, Math.max(0, p(1, 1) - 1))
        break
      case 'J':
        this.eraseDisplay(p(0, 0))
        break
      case 'K':
        this.eraseLine(p(0, 0))
        break
      case 'r':
        if (params.length === 0) {
          this.scrollTop = 0
          this.scrollBottom = this.rows - 1
        } else {
          this.scrollTop = Math.max(0, p(0, 1) - 1)
          this.scrollBottom = Math.min(this.rows - 1, p(1, this.rows) - 1)
        }
        break
      case 's':
        this.savedCol = this.cursorCol
        this.savedRow = this.cursorRow
        break
      case 'u':
        this.cursorCol = this.savedCol
        this.cursorRow = this.savedRow
        break
      case 'm':
        this.applySgr(params.length === 0 ? [0] : params)
        break
      default:
        break
    }
  }

  private applySgr(params: number[]): void {
    if (params.length === 0) {
      this.attr = { ...DEFAULT_ATTR }
      return
    }
    for (let i = 0; i < params.length; i++) {
      const n = params[i]!
      if (n === 0) {
        this.attr = { ...DEFAULT_ATTR }
      } else if (n === 1) {
        this.attr.bold = true
      } else if (n === 2) {
        this.attr.dim = true
      } else if (n === 3) {
        this.attr.italic = true
      } else if (n === 7) {
        this.attr.inverse = true
      } else if (n === 22) {
        this.attr.bold = false
        this.attr.dim = false
      } else if (n === 23) {
        this.attr.italic = false
      } else if (n === 27) {
        this.attr.inverse = false
      } else if (n === 39) {
        this.attr.fg = { kind: 'default' }
      } else if (n === 49) {
        this.attr.bg = { kind: 'default' }
      } else if (n === 38 || n === 48) {
        const isFg = n === 38
        const mode = params[i + 1]
        if (mode === 5 && i + 2 < params.length) {
          const index = params[i + 2]!
          const color: TerminalColor = { kind: 'indexed', index }
          if (isFg) this.attr.fg = color
          else this.attr.bg = color
          i += 2
        } else if (mode === 2 && i + 4 < params.length) {
          const r = params[i + 2]!
          const g = params[i + 3]!
          const b = params[i + 4]!
          const color: TerminalColor = { kind: 'rgb', r, g, b }
          if (isFg) this.attr.fg = color
          else this.attr.bg = color
          i += 4
        }
      } else if (n >= 30 && n <= 37) {
        this.attr.fg = { kind: 'indexed', index: n - 30 }
      } else if (n >= 40 && n <= 47) {
        this.attr.bg = { kind: 'indexed', index: n - 40 }
      } else if (n >= 90 && n <= 97) {
        this.attr.fg = { kind: 'indexed', index: n - 90 + 8 }
      } else if (n >= 100 && n <= 107) {
        this.attr.bg = { kind: 'indexed', index: n - 100 + 8 }
      }
    }
  }

  private eraseLine(mode: number): void {
    const row = this.active()[this.cursorRow]
    if (!row) return
    let start = 0
    let end = this.cols
    if (mode === 0) start = this.cursorCol
    else if (mode === 1) end = this.cursorCol + 1
    for (let c = start; c < end; c++) row[c] = emptyCell()
  }

  private eraseDisplay(mode: number): void {
    const buf = this.active()
    if (mode === 2 || mode === 3) {
      for (let r = 0; r < this.rows; r++) buf[r] = Array.from({ length: this.cols }, () => emptyCell())
      return
    }
    if (mode === 0) {
      this.eraseLine(0)
      for (let r = this.cursorRow + 1; r < this.rows; r++) {
        buf[r] = Array.from({ length: this.cols }, () => emptyCell())
      }
    }
    if (mode === 1) {
      for (let r = 0; r < this.cursorRow; r++) {
        buf[r] = Array.from({ length: this.cols }, () => emptyCell())
      }
      this.eraseLine(1)
    }
  }

  private lineFeed(): void {
    if (this.cursorRow < this.scrollBottom) {
      this.cursorRow += 1
      return
    }
    const buf = this.active()
    for (let r = this.scrollTop; r < this.scrollBottom; r++) {
      const nextRow = buf[r + 1]
      if (nextRow) buf[r] = nextRow
    }
    buf[this.scrollBottom] = Array.from({ length: this.cols }, () => emptyCell())
  }

  private putChar(ch: string): void {
    const width = Math.max(0, Math.min(2, stringWidth(ch))) as 0 | 1 | 2
    if (width === 0) return

    // If deferred autowrap was pending from the previous character, execute wrap now
    if (this.wrapPending) {
      this.cursorCol = 0
      this.lineFeed()
      this.wrapPending = false
    }

    if (this.cursorCol + width > this.cols) {
      this.cursorCol = 0
      this.lineFeed()
    }

    const row = this.active()[this.cursorRow]
    if (!row) return
    row[this.cursorCol] = { ch, width, attr: cloneAttr(this.attr) }
    if (width === 2 && this.cursorCol + 1 < this.cols) {
      row[this.cursorCol + 1] = { ch: '', width: 0, attr: cloneAttr(this.attr) }
    }
    this.cursorCol += width

    // If cursor reached right margin, set wrapPending for DECAWM deferred autowrap
    if (this.cursorCol >= this.cols) {
      this.wrapPending = true
    }
  }
}

function resizeBuffer(buf: Cell[][], cols: number, rows: number): Cell[][] {
  const next = makeBuffer(cols, rows)
  for (let r = 0; r < Math.min(rows, buf.length); r++) {
    const src = buf[r]
    const dst = next[r]
    if (!src || !dst) continue
    for (let c = 0; c < Math.min(cols, src.length); c++) {
      const cell = src[c]
      if (cell) dst[c] = cell
    }
  }
  return next
}

function rowToString(row: Cell[]): string {
  let out = ''
  for (let c = 0; c < row.length; ) {
    const cell = row[c]
    if (!cell || cell.width === 0) {
      c += 1
      continue
    }
    out += cell.ch
    c += cell.width === 2 ? 2 : 1
  }
  return out.replace(/ +$/g, '')
}

function fnv1a(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}
