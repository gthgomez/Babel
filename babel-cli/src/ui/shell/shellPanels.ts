import type { PromptView } from '../promptView.js'
import type { ShellFrameInput, ShellLayout, ShellRule, ShellSurface } from './shellTypes.js'
import type { ShellFocus } from './shellInputRouter.js'
import type { ShellPresentation } from './shellPresentation.js'

export interface ShellPanelSnapshot {
  mode: string
  model: string
  project: string
  conversation: readonly string[]
  sessions?: readonly string[]
  projectRows?: readonly string[]
  actions?: readonly string[]
  tools?: readonly string[]
  context?: readonly string[]
  status?: readonly string[]
  prompt?: PromptView
  presentation?: ShellPresentation
}

function boundedRows(rows: readonly string[] | undefined, height: number): readonly string[] {
  return (rows ?? []).slice(0, Math.max(0, height))
}

function surface(id: string, rect: ShellLayout['header'], rows: readonly string[]): ShellSurface | null {
  if (!rect) return null
  return { id, rect, rows }
}

function headerRows(snapshot: ShellPanelSnapshot): readonly string[] {
  return [
    '  [◎]  B A B E L',
    `       [ ${snapshot.mode} ]   ${snapshot.model}`,
    '       Run. Verify. Understand.',
  ]
}

function focusLabel(snapshot: ShellPanelSnapshot, focus: ShellFocus, label: string): string {
  return snapshot.presentation?.focus === focus ? `› ${label}` : `  ${label}`
}

function leftRows(snapshot: ShellPanelSnapshot): readonly string[] {
  return [
    focusLabel(snapshot, 'sessions', 'SESSIONS'),
    ...(snapshot.sessions ?? ['No saved conversations']),
    '',
    focusLabel(snapshot, 'project', 'PROJECT'),
    ...(snapshot.projectRows ?? [snapshot.project]),
    '',
    focusLabel(snapshot, 'actions', 'QUICK ACTIONS'),
    ...(snapshot.actions ?? ['New conversation', 'Resume', 'Git status', 'Diff', 'Retarget', 'Command palette']),
  ]
}

function rightRows(snapshot: ShellPanelSnapshot): readonly string[] {
  return [
    '[◎]  BABEL',
    'Run. Verify. Understand.',
    '',
    focusLabel(snapshot, 'inspector', 'MODE'),
    `● ${snapshot.mode}`,
    '',
    'MODEL',
    `● ${snapshot.model}`,
    '',
    'TOOLS',
    ...(snapshot.tools ?? ['Unknown until request resolution']),
    '',
    'CONTEXT',
    ...(snapshot.context ?? ['No provider request yet.']),
    '',
    'STATUS',
    ...(snapshot.status ?? ['Ready']),
  ]
}

function conversationRows(snapshot: ShellPanelSnapshot): readonly string[] {
  if (snapshot.presentation?.focus !== 'conversation') return snapshot.conversation
  return [focusLabel(snapshot, 'conversation', 'CONVERSATION'), ...snapshot.conversation]
}

/** Build pure shell surfaces from an immutable runtime projection. */
export function buildShellFrameInput(
  layout: ShellLayout,
  snapshot: ShellPanelSnapshot,
): ShellFrameInput {
  const surfaces: ShellSurface[] = []
  const add = (item: ShellSurface | null): void => {
    if (item) surfaces.push(item)
  }
  add(surface('header', layout.header, headerRows(snapshot)))
  if (snapshot.presentation?.leftDrawerOpen !== false) {
    add(surface('left', layout.left, leftRows(snapshot)))
  }
  add(surface('conversation', layout.conversation, conversationRows(snapshot)))
  if (snapshot.presentation?.rightDrawerOpen !== false) {
    add(surface('right', layout.right, rightRows(snapshot)))
  }
  if (layout.composer && snapshot.prompt) {
    add(surface('composer', layout.composer, snapshot.prompt.rows))
    if (snapshot.prompt.popup) {
      const popupRect = {
        x: layout.composer.x + snapshot.prompt.popup.rect.x,
        y: layout.composer.y + snapshot.prompt.popup.rect.y,
        width: Math.min(
          snapshot.prompt.popup.rect.width,
          Math.max(0, layout.composer.width - snapshot.prompt.popup.rect.x),
        ),
        height: Math.min(
          snapshot.prompt.popup.rect.height,
          Math.max(0, layout.composer.height - snapshot.prompt.popup.rect.y),
        ),
      }
      if (popupRect.width > 0 && popupRect.height > 0) {
        add(surface('composer-popup', popupRect, snapshot.prompt.popup.rows))
      }
    }
  }
  const footerRows = [`  BABEL  ${snapshot.project}`, '  Escape closes panels  ·  F6 changes focus']
  if (layout.footer) {
    const footerContent = {
      ...layout.footer,
      y: layout.footer.y + 1,
      height: Math.max(0, layout.footer.height - 1),
    }
    add(surface('footer', footerContent, footerRows))
  }

  const rules: ShellRule[] = []
  if (layout.header) rules.push({ orientation: 'horizontal', position: layout.header.y + layout.header.height - 1, char: '─' })
  if (layout.footer) rules.push({ orientation: 'horizontal', position: layout.footer.y, char: '─' })
  if (layout.left && snapshot.presentation?.leftDrawerOpen !== false) {
    rules.push({ orientation: 'vertical', position: layout.left.x + layout.left.width, start: layout.left.y, end: layout.left.y + layout.left.height, char: '│' })
  }
  if (layout.right && snapshot.presentation?.rightDrawerOpen !== false) {
    rules.push({ orientation: 'vertical', position: layout.right.x - 1, start: layout.right.y, end: layout.right.y + layout.right.height, char: '│' })
  }

  return {
    cols: layout.effectiveCols,
    rows: layout.rows,
    background: ' ',
    surfaces,
    rules,
    cursor: layout.composer && snapshot.prompt
      ? {
          row: layout.composer.y + snapshot.prompt.cursor.row,
          col: layout.composer.x + snapshot.prompt.cursor.col,
          visible: snapshot.presentation === undefined || snapshot.presentation.focus === 'composer'
            ? snapshot.prompt.cursor.visible
            : false,
        }
      : null,
    cacheKey: `${snapshot.mode}:${snapshot.model}:${snapshot.project}:${snapshot.conversation.length}:${snapshot.presentation?.focus ?? 'composer'}:${snapshot.presentation?.leftDrawerOpen ?? true}:${snapshot.presentation?.rightDrawerOpen ?? true}`,
  }
}

/** Keep panel row construction bounded to a planned rectangle. */
export function boundedPanelRows(rows: readonly string[] | undefined, height: number): readonly string[] {
  return boundedRows(rows, height)
}
