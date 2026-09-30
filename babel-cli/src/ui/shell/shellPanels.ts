import { createRequire } from 'node:module'

import {
  accent,
  bgSelected,
  bgSurface,
  border,
  muted,
  primary,
  success,
} from '../theme.js'
import { measureDisplayWidth, truncateDisplay } from '../textLayout.js'
import type { PromptView } from '../promptView.js'
import type { ShellFrameInput, ShellLayout, ShellRule, ShellSurface } from './shellTypes.js'
import type { ShellFocus } from './shellInputRouter.js'
import type { ShellPresentation } from './shellPresentation.js'

const shellPackageVersion = (
  createRequire(import.meta.url)('../../../package.json') as { version?: string }
).version ?? '0.0.0'

export interface ShellChoice {
  readonly id: string
  readonly label: string
  readonly description?: string
}

export interface ShellToolState {
  readonly name: string
  readonly state: 'on' | 'off' | 'unknown'
}

export interface ShellMeter {
  readonly used: number
  readonly limit: number
}

export interface ShellPanelSnapshot {
  mode: string
  model: string
  project: string
  conversation: readonly string[]
  sessions?: readonly string[]
  projectRows?: readonly string[]
  actions?: readonly string[]
  tools?: readonly string[]
  toolStates?: readonly ShellToolState[]
  context?: readonly string[]
  meter?: ShellMeter | null
  status?: readonly string[]
  modelChoices?: readonly ShellChoice[]
  clock?: string
  version?: string
  prompt?: PromptView
  presentation?: ShellPresentation
}

const MODE_CHOICES: readonly ShellChoice[] = [
  { id: 'chat', label: 'Chat', description: 'General development' },
  { id: 'plan', label: 'Plan', description: 'Structured multi-step' },
  { id: 'deep', label: 'Deep', description: 'Extended investigation' },
]

function boundedRows(rows: readonly string[] | undefined, height: number): readonly string[] {
  return (rows ?? []).slice(0, Math.max(0, height))
}

function surface(id: string, rect: ShellLayout['header'], rows: readonly string[]): ShellSurface | null {
  if (!rect || rect.height <= 0 || rect.width <= 0) return null
  return { id, rect, rows: boundedRows(rows, rect.height) }
}

function clip(text: string, width: number): string {
  if (width <= 0) return ''
  if (measureDisplayWidth(text) <= width) return text
  if (width === 1) return truncateDisplay(text, 1)
  return `${truncateDisplay(text, Math.max(0, width - 1))}…`
}

function pad(text: string, width: number): string {
  const clipped = clip(text, width)
  const gap = width - measureDisplayWidth(clipped)
  return gap > 0 ? `${clipped}${' '.repeat(gap)}` : clipped
}

function paint(text: string, width: number, selected: boolean): string {
  return selected ? bgSelected(pad(text, width)) : bgSurface(pad(text, width))
}

function focusMark(focused: boolean): string {
  return focused ? '› ' : '  '
}

function joinEnds(left: string, right: string, width: number): string {
  const gap = width - measureDisplayWidth(left) - measureDisplayWidth(right)
  if (gap >= 1) return `${left}${' '.repeat(gap)}${right}`
  return clip(left, width)
}

function headerRows(snapshot: ShellPanelSnapshot, width: number): readonly string[] {
  const active = snapshot.mode.toLowerCase()
  const tabs = MODE_CHOICES.map((choice) =>
    choice.id === active ? accent(`[ ${choice.label} ]`) : muted(choice.label),
  ).join('  ')
  const left = `${accent('◎')} ${primary('BABEL')}  ${tabs}`
  const rightParts = [snapshot.model]
  if (snapshot.meter && snapshot.meter.limit > 0) {
    rightParts.push(`${Math.round((snapshot.meter.used / snapshot.meter.limit) * 100)}%`)
  }
  if (snapshot.clock) rightParts.push(snapshot.clock)
  rightParts.push('Run. Verify. Understand.')
  const right = muted(rightParts.join('  ·  '))
  return [paint(joinEnds(left, right, width), width, false)]
}

function itemRows(
  title: string,
  items: readonly string[],
  empty: string,
  width: number,
  focused: boolean,
  selectedIndex: number,
): string[] {
  const rows = [paint(`${focusMark(focused)}${title}`, width, false)]
  const source = items.length > 0 ? items : [empty]
  source.forEach((item, index) => {
    const selected = items.length > 0 && index === selectedIndex
    const mark = selected ? '▸ ' : '  '
    rows.push(paint(`${mark}${item}`, width, selected))
  })
  return rows
}

function leftRows(snapshot: ShellPanelSnapshot, width: number): readonly string[] {
  const focus = snapshot.presentation?.focus
  const selectedSurface = snapshot.presentation?.selectedSurface
  const selectedIndex = snapshot.presentation?.selectedIndex ?? 0
  return [
    ...itemRows(
      'SESSIONS  +',
      snapshot.sessions ?? [],
      'No saved conversations',
      width,
      focus === 'sessions',
      selectedSurface === 'sessions' ? selectedIndex : -1,
    ),
    '',
    ...itemRows(
      'PROJECT',
      snapshot.projectRows ?? [],
      snapshot.project,
      width,
      focus === 'project',
      selectedSurface === 'project' ? selectedIndex : -1,
    ),
    '',
    ...itemRows(
      'QUICK ACTIONS',
      snapshot.actions ?? [],
      'No actions',
      width,
      focus === 'actions',
      selectedSurface === 'actions' ? selectedIndex : -1,
    ),
  ]
}

function meterBar(meter: ShellMeter, width: number): string {
  const inner = Math.max(1, width - 2)
  const ratio = meter.limit > 0 ? Math.max(0, Math.min(1, meter.used / meter.limit)) : 0
  const filled = Math.round(inner * ratio)
  const bar = `${accent('█'.repeat(filled))}${muted('░'.repeat(Math.max(0, inner - filled)))}`
  return pad(` ${bar}`, width)
}

function rightRows(snapshot: ShellPanelSnapshot, width: number): readonly string[] {
  const focus = snapshot.presentation?.focus === 'inspector'
  const selected = snapshot.presentation?.selectedSurface === 'inspector'
    ? snapshot.presentation.selectedIndex
    : -1
  const rows: string[] = [
    paint(joinEnds(`${accent('◎')} ${primary('BABEL')}`, '', width), width, false),
    paint(muted('Run. Verify. Understand.'), width, false),
    '',
    paint(`${focusMark(focus)}MODE`, width, false),
  ]
  let cursor = 0
  for (const choice of MODE_CHOICES) {
    const active = choice.id === snapshot.mode.toLowerCase()
    const mark = active ? accent('●') : muted('○')
    const label = `${mark} ${choice.label}  ${muted(choice.description ?? '')}`
    rows.push(paint(label, width, cursor === selected))
    cursor += 1
  }
  rows.push('')
  rows.push(paint('MODEL', width, false))
  const models = snapshot.modelChoices ?? []
  if (models.length === 0) {
    rows.push(paint(`${accent('●')} ${snapshot.model}`, width, false))
  }
  for (const choice of models) {
    const active = choice.id === snapshot.model || choice.label === snapshot.model
    const mark = active ? accent('●') : muted('○')
    rows.push(paint(`${mark} ${choice.label}`, width, cursor === selected))
    cursor += 1
  }
  rows.push('')
  rows.push(paint('TOOLS', width, false))
  if (snapshot.toolStates && snapshot.toolStates.length > 0) {
    for (const tool of snapshot.toolStates) {
      const mark = tool.state === 'on' ? success('●') : tool.state === 'off' ? muted('●') : muted('○')
      const state = tool.state === 'on' ? 'On' : tool.state === 'off' ? 'Off' : 'unknown'
      rows.push(paint(joinEnds(`${mark} ${tool.name}`, muted(state), width), width, false))
    }
  } else {
    for (const line of snapshot.tools ?? ['Unknown until request resolution']) {
      rows.push(paint(line, width, false))
    }
  }
  rows.push('')
  rows.push(paint('CONTEXT', width, false))
  if (snapshot.meter && snapshot.meter.limit > 0) {
    const percent = Math.round((snapshot.meter.used / snapshot.meter.limit) * 100)
    rows.push(meterBar(snapshot.meter, width))
    rows.push(paint(muted(`${snapshot.meter.used.toLocaleString('en-US')} / ${snapshot.meter.limit.toLocaleString('en-US')}  ${percent}%`), width, false))
  } else {
    for (const line of snapshot.context ?? ['Unknown until request resolution']) {
      rows.push(paint(line, width, false))
    }
  }
  rows.push('')
  rows.push(paint('STATUS', width, false))
  for (const line of snapshot.status ?? ['Ready']) {
    const ready = line === 'Ready'
    rows.push(paint(ready ? `${success('●')} Ready` : line, width, false))
  }
  return rows
}

function conversationRows(snapshot: ShellPanelSnapshot, width: number): readonly string[] {
  if (snapshot.presentation?.focus !== 'conversation') {
    return snapshot.conversation.map((line) => pad(line, width))
  }
  return [paint(`${focusMark(true)}CONVERSATION`, width, false), ...snapshot.conversation.map((line) => pad(line, width))]
}

function composerRows(prompt: PromptView, width: number, height: number): { rows: string[]; rowShift: number; colShift: number } {
  if (height < 3 || width < 4) {
    return { rows: prompt.rows.map((row) => pad(row, width)), rowShift: 0, colShift: 0 }
  }
  const inner = width - 2
  const top = border(`┌${'─'.repeat(inner)}┐`)
  const bottom = border(`└${'─'.repeat(inner)}┘`)
  const hint = border(`│${pad(muted('Enter send · Ctrl+Enter send · Enter inserts a newline'), inner)}│`)
  const body = prompt.rows.map((row) => border(`│${pad(row, inner)}│`))
  const middleCount = Math.max(1, height - 3)
  const middle = body.slice(0, middleCount)
  while (middle.length < middleCount - 1) middle.push(border(`│${' '.repeat(inner)}│`))
  if (middle.length < middleCount) middle.push(hint)
  return { rows: [top, ...middle, bottom].slice(0, height), rowShift: 1, colShift: 1 }
}

function footerRows(snapshot: ShellPanelSnapshot, width: number): readonly string[] {
  const version = snapshot.version ?? shellPackageVersion
  const left = `BABEL v${version}  ${snapshot.project}`
  const right = 'Run. Verify. Understand.'
  return [paint(joinEnds(left, right, width), width, false)]
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
  let promptShift = { rowShift: 0, colShift: 0 }
  add(surface('header', layout.header, layout.header ? headerRows(snapshot, layout.header.width) : []))
  if (snapshot.presentation?.leftDrawerOpen !== false && layout.left) {
    add(surface('left', layout.left, leftRows(snapshot, layout.left.width)))
  }
  if (layout.conversation) {
    add(surface('conversation', layout.conversation, conversationRows(snapshot, layout.conversation.width)))
  }
  if (snapshot.presentation?.rightDrawerOpen !== false && layout.right) {
    add(surface('right', layout.right, rightRows(snapshot, layout.right.width)))
  }
  if (layout.composer && snapshot.prompt) {
    const composed = composerRows(snapshot.prompt, layout.composer.width, layout.composer.height)
    promptShift = { rowShift: composed.rowShift, colShift: composed.colShift }
    add(surface('composer', layout.composer, composed.rows))
    if (snapshot.prompt.popup) {
      const popupRect = {
        x: layout.composer.x + snapshot.prompt.popup.rect.x + composed.colShift,
        y: layout.composer.y + snapshot.prompt.popup.rect.y + composed.rowShift,
        width: Math.min(
          snapshot.prompt.popup.rect.width,
          Math.max(0, layout.composer.width - snapshot.prompt.popup.rect.x - composed.colShift),
        ),
        height: Math.min(
          snapshot.prompt.popup.rect.height,
          Math.max(0, layout.composer.height - snapshot.prompt.popup.rect.y - composed.rowShift),
        ),
      }
      if (popupRect.width > 0 && popupRect.height > 0) {
        add(surface('composer-popup', popupRect, snapshot.prompt.popup.rows))
      }
    }
  }
  if (layout.footer) {
    const footerContent = {
      ...layout.footer,
      y: layout.footer.y + 1,
      height: Math.max(0, layout.footer.height - 1),
    }
    add(surface('footer', footerContent, footerRows(snapshot, footerContent.width)))
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
          row: layout.composer.y + snapshot.prompt.cursor.row + promptShift.rowShift,
          col: layout.composer.x + snapshot.prompt.cursor.col + promptShift.colShift,
          visible: snapshot.presentation === undefined || snapshot.presentation.focus === 'composer'
            ? snapshot.prompt.cursor.visible
            : false,
        }
      : null,
    cacheKey: [
      snapshot.mode,
      snapshot.model,
      snapshot.project,
      snapshot.clock ?? '',
      snapshot.conversation.length,
      snapshot.presentation?.focus ?? 'composer',
      snapshot.presentation?.selectedSurface ?? 'composer',
      snapshot.presentation?.selectedIndex ?? 0,
      snapshot.presentation?.leftDrawerOpen ?? true,
      snapshot.presentation?.rightDrawerOpen ?? true,
      snapshot.sessions?.length ?? 0,
      snapshot.projectRows?.length ?? 0,
      snapshot.actions?.length ?? 0,
      snapshot.tools?.length ?? 0,
      snapshot.toolStates?.length ?? 0,
      snapshot.meter ? `${snapshot.meter.used}/${snapshot.meter.limit}` : '',
    ].join(':'),
  }
}

/** Keep panel row construction bounded to a planned rectangle. */
export function boundedPanelRows(rows: readonly string[] | undefined, height: number): readonly string[] {
  return boundedRows(rows, height)
}
