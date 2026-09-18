import { graphemeClusters } from '../textUtils.js'
import { measureDisplayWidth, truncateDisplay } from '../textLayout.js'
import { scanTerminalTokens, type TerminalToken } from '../terminalSequenceScanner.js'
import type {
  LocalCursor,
  ShellFrameInput,
  ShellOutputPort,
  ShellRule,
  ShellSurface,
} from './shellTypes.js'

/** Result of one attempted root frame render. */
export interface ShellFrameRenderResult {
  readonly rows: readonly string[]
  readonly changedRows: readonly number[]
  readonly wroteFrame: boolean
}

/** Stateful root renderer that commits only frames successfully handed to output. */
export interface ShellFrameRenderer {
  render(frame: ShellFrameInput): ShellFrameRenderResult
  invalidate(reason?: string): void
  committedRows(): readonly string[] | null
  displayWidthOfRow(row: number): number
}

interface DisplayCell {
  readonly text: string
  readonly width: number
}

function safeTokenText(token: TerminalToken): string {
  if (token.type === 'text') {
    return token.raw.replace(/[\t\x00-\x1f\x7f]/g, ' ')
  }
  if (token.type === 'newline' || token.type === 'carriage_return' || token.type === 'c0_c1') {
    return ' '
  }
  if (token.type === 'sgr' || token.type === 'osc8_open' || token.type === 'osc8_close') {
    return token.raw
  }
  return ''
}

function sanitizeRow(text: string): string {
  let result = ''
  let hasSgr = false
  let hasOpenHyperlink = false
  for (const token of scanTerminalTokens(text)) {
    if (token.type === 'sgr') hasSgr = true
    if (token.type === 'osc8_open') hasOpenHyperlink = true
    if (token.type === 'osc8_close') hasOpenHyperlink = false
    result += safeTokenText(token)
  }
  if (hasOpenHyperlink) result += '\x1b]8;;\x1b\\'
  if (hasSgr) result += '\x1b[0m'
  return result
}

function oneColumnCell(text: string): string {
  return measureDisplayWidth(text) === 1 ? text : ' '
}

function fillCells(fill: string, width: number): string[] {
  const cell = oneColumnCell(fill)
  return Array.from({ length: Math.max(0, width) }, () => cell)
}

function displayCells(text: string, width: number, fill: string): string[] {
  const targetWidth = Math.max(0, width)
  const cells = fillCells(fill, targetWidth)
  if (targetWidth === 0) return cells

  const clipped = truncateDisplay(sanitizeRow(text), targetWidth)
  let column = 0
  let pending = ''
  for (const token of scanTerminalTokens(clipped)) {
    if (token.type !== 'text') {
      pending += safeTokenText(token)
      continue
    }
    for (const cluster of graphemeClusters(token.raw)) {
      const clusterWidth = measureDisplayWidth(cluster)
      if (clusterWidth <= 0) {
        pending += cluster
        continue
      }
      if (column + clusterWidth > targetWidth) return cells
      cells[column] = `${pending}${cluster}`
      pending = ''
      for (let offset = 1; offset < clusterWidth; offset += 1) {
        cells[column + offset] = ''
      }
      column += clusterWidth
    }
  }
  if (pending && column > 0) cells[column - 1] += pending
  return cells
}

function surfaceRow(surface: ShellSurface, row: number, defaultFill: string): string[] {
  const fill = surface.background ?? defaultFill
  return displayCells(surface.rows[row - surface.rect.y] ?? '', surface.rect.width, fill)
}

function rulePlacement(rule: ShellRule, cols: number, rows: number): {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
} {
  if (rule.orientation === 'horizontal') {
    const start = Math.max(0, rule.start ?? 0)
    const end = Math.min(cols, rule.end ?? cols)
    return { x: start, y: rule.position, width: Math.max(0, end - start), height: 1 }
  }
  const start = Math.max(0, rule.start ?? 0)
  const end = Math.min(rows, rule.end ?? rows)
  return { x: rule.position, y: start, width: 1, height: Math.max(0, end - start) }
}

function composeRow(frame: ShellFrameInput, row: number): string {
  const cells = fillCells(frame.background, frame.cols)
  const placements: Array<{
    readonly x: number
    readonly y: number
    readonly width: number
    readonly height: number
    readonly cells: (relativeRow: number) => string[]
  }> = []

  for (const surface of frame.surfaces) {
    if (row >= surface.rect.y && row < surface.rect.y + surface.rect.height) {
      placements.push({
        x: surface.rect.x,
        y: surface.rect.y,
        width: surface.rect.width,
        height: surface.rect.height,
        cells: (relativeRow) => surfaceRow(surface, relativeRow, frame.background),
      })
    }
  }
  for (const rule of frame.rules ?? []) {
    const placement = rulePlacement(rule, frame.cols, frame.rows)
    if (row >= placement.y && row < placement.y + placement.height) {
      placements.push({
        ...placement,
        cells: () => displayCells(rule.char, placement.width, frame.background),
      })
    }
  }

  for (const placement of placements) {
    const start = Math.max(0, placement.x)
    const end = Math.min(frame.cols, placement.x + placement.width)
    if (start >= end) continue
    const segment = placement.cells(row)
    for (let column = start; column < end; column += 1) {
      cells[column] = segment[column - placement.x] ?? cells[column]!
    }
  }

  return cells.join('')
}

/** Compose complete physical rows without reading terminal or runtime state. */
export function composeShellRows(frame: ShellFrameInput): readonly string[] {
  const cols = Math.max(0, Math.floor(frame.cols))
  const rows = Math.max(0, Math.floor(frame.rows))
  if (cols === 0 || rows === 0) return []
  const normalizedFrame = cols === frame.cols && rows === frame.rows
    ? frame
    : { ...frame, cols, rows }
  return Array.from({ length: rows }, (_, row) => composeRow(normalizedFrame, row))
}

function sameCursor(left: LocalCursor | null, right: LocalCursor | null): boolean {
  return left?.row === right?.row && left?.col === right?.col && left?.visible === right?.visible
}

function cursorPosition(cursor: LocalCursor): { row: number; col: number } {
  return { row: cursor.row + 1, col: cursor.col + 1 }
}

/** Create a root renderer backed by an injected, capability-independent output port. */
export function createShellFrameRenderer(output: ShellOutputPort): ShellFrameRenderer {
  let committed: readonly string[] | null = null
  let committedCols = -1
  let committedRows = -1
  let committedCacheKey: string | undefined
  let committedCursor: LocalCursor | null = null

  const renderer: ShellFrameRenderer = {
    render(frame) {
      const rows = composeShellRows(frame)
      const cursor = frame.cursor ?? null
      const fullInvalidation =
        committed === null ||
        committedCols !== frame.cols ||
        committedRows !== frame.rows ||
        committedCacheKey !== frame.cacheKey
      const changedRows = rows.reduce<number[]>((changed, row, index) => {
        if (fullInvalidation || committed?.[index] !== row) changed.push(index)
        return changed
      }, [])
      const cursorChanged = !sameCursor(committedCursor, cursor)
      if (changedRows.length === 0 && !cursorChanged) {
        return { rows, changedRows, wroteFrame: false }
      }

      let began = false
      let primaryError: unknown = null
      try {
        output.beginFrame()
        began = true
        for (const row of changedRows) {
          output.moveCursor(row + 1, 1)
          output.write(rows[row]!)
        }
        if (cursor) {
          const position = cursorPosition(cursor)
          output.moveCursor(position.row, position.col)
        }
      } catch (error: unknown) {
        primaryError = error
        throw error
      } finally {
        if (began) {
          try {
            output.endFrame()
          } catch (error: unknown) {
            if (primaryError === null) throw error
          }
        }
      }

      committed = rows
      committedCols = frame.cols
      committedRows = frame.rows
      committedCacheKey = frame.cacheKey
      committedCursor = cursor
      return { rows, changedRows, wroteFrame: true }
    },

    invalidate() {
      committed = null
      committedCols = -1
      committedRows = -1
      committedCacheKey = undefined
      committedCursor = null
    },

    committedRows() {
      return committed ? [...committed] : null
    },

    displayWidthOfRow(row) {
      return committed?.[row] === undefined ? 0 : measureDisplayWidth(committed[row]!)
    },
  }

  return renderer
}
