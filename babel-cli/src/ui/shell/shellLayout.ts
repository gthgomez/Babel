import type { Rect, ShellDimensions, ShellLayout } from './shellTypes.js'

const MIN_SHELL_COLS = 44
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
 * Whether the responsive shell has drawable regions at these dimensions.
 *
 * Below the minimum grid `planShellLayout` returns the null-rect linear
 * fallback. Mounting the full-screen host there paints an empty frame and
 * hides the composer, so callers must keep the legacy line editor instead.
 *
 * @param dimensions - Physical and, when required, guard-adjusted dimensions.
 * @returns True only when the layout carries real header/composer regions.
 */
export function canHostResponsiveShell(dimensions: ShellDimensions): boolean {
  return planShellLayout(dimensions).mode !== 'linear'
}

/**
 * Plan responsive shell rectangles without reading terminal state or emitting output.
 *
 * @param dimensions - Physical and, when required, guard-adjusted dimensions.
 * @returns A bounded layout whose coordinates use zero-based half-open rectangles.
 */
export function planShellLayout(
  dimensions: ShellDimensions,
  visibility: { leftDrawerOpen: boolean; rightDrawerOpen: boolean } = { leftDrawerOpen: true, rightDrawerOpen: true },
): ShellLayout {
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
  // One content row plus the rule, matching the mock's single header and footer bars.
  const headerHeight = 2
  const footerHeight = 2
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

  const leftWidth = mode === 'wide' ? 28 : mode === 'medium' ? 24 : 0
  const rightWidth = mode === 'wide' ? 32 : 0
  const leftSpace = leftWidth && visibility.leftDrawerOpen ? leftWidth + 1 : 0
  const rightSpace = rightWidth && visibility.rightDrawerOpen ? rightWidth + 1 : 0
  if (leftSpace) left = rect(1, centerY, leftWidth, bodyHeight)
  center = rect(1 + leftSpace, centerY, Math.max(0, effectiveCols - 2 - leftSpace - rightSpace), bodyHeight)
  if (rightSpace) right = rect(center.x + center.width + 1, centerY, rightWidth, bodyHeight)

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
