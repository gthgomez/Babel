import type { Rect, ShellDimensions, ShellLayout } from './shellTypes.js'

const MIN_SHELL_COLS = 60
const MIN_SHELL_ROWS = 16
const MEDIUM_COLS = 120
const WIDE_COLS = 160
const WIDE_ROWS = 30
const MEDIUM_ROWS = 24

function rect(x: number, y: number, width: number, height: number): Rect {
  return {
    x: Math.max(0, x),
    y: Math.max(0, y),
    width: Math.max(0, width),
    height: Math.max(0, height),
  }
}

function emptyLayout(
  cols: number,
  rows: number,
  effectiveCols: number,
): ShellLayout {
  return {
    mode: 'linear',
    cols,
    rows,
    effectiveCols,
    header: null,
    left: null,
    center: null,
    right: null,
    conversation: null,
    conversationText: null,
    composer: null,
    footer: null,
  }
}

/**
 * Plan responsive shell rectangles without reading terminal state or emitting output.
 *
 * @param dimensions - Physical and, when required, guard-adjusted dimensions.
 * @returns A bounded layout whose coordinates use zero-based half-open rectangles.
 */
export function planShellLayout(dimensions: ShellDimensions): ShellLayout {
  const cols = Math.max(0, Math.floor(dimensions.cols))
  const rows = Math.max(0, Math.floor(dimensions.rows))
  const effectiveCols = Math.max(
    0,
    Math.min(cols, Math.floor(dimensions.effectiveCols ?? cols)),
  )

  if (effectiveCols < MIN_SHELL_COLS || rows < MIN_SHELL_ROWS) {
    return emptyLayout(cols, rows, effectiveCols)
  }

  const mode =
    effectiveCols >= WIDE_COLS && rows >= WIDE_ROWS
      ? 'wide'
      : effectiveCols >= MEDIUM_COLS && rows >= MEDIUM_ROWS
        ? 'medium'
        : 'narrow'
  const compact = rows < MEDIUM_ROWS
  const headerHeight = compact ? 3 : 4
  const footerHeight = compact ? 2 : 3
  const composerHeight = compact ? 3 : 5
  const footerY = Math.max(headerHeight, rows - footerHeight)
  const bodyHeight = Math.max(0, footerY - headerHeight)
  const conversationHeight = Math.max(0, bodyHeight - composerHeight)
  const centerY = headerHeight

  const header = rect(0, 0, effectiveCols, headerHeight)
  const footer = rect(0, footerY, effectiveCols, footerHeight)

  let left: Rect | null = null
  let center: Rect
  let right: Rect | null = null

  if (mode === 'wide') {
    const leftWidth = 28
    const rightWidth = 32
    const centerWidth = Math.max(0, effectiveCols - 64)
    left = rect(1, centerY, leftWidth, bodyHeight)
    center = rect(30, centerY, centerWidth, bodyHeight)
    right = rect(30 + centerWidth + 1, centerY, rightWidth, bodyHeight)
  } else if (mode === 'medium') {
    left = rect(1, centerY, 24, bodyHeight)
    center = rect(26, centerY, Math.max(0, effectiveCols - 27), bodyHeight)
  } else {
    center = rect(1, centerY, Math.max(0, effectiveCols - 2), bodyHeight)
  }

  const conversation = rect(center.x, center.y, center.width, conversationHeight)
  const composer = rect(
    center.x,
    center.y + conversationHeight,
    center.width,
    Math.max(0, bodyHeight - conversationHeight),
  )
  const conversationText = rect(
    conversation.x + 2,
    conversation.y,
    Math.max(0, conversation.width - 4),
    conversation.height,
  )

  return {
    mode,
    cols,
    rows,
    effectiveCols,
    header,
    left,
    center,
    right,
    conversation,
    conversationText,
    composer,
    footer,
  }
}
