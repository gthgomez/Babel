import assert from 'node:assert/strict'
import test from 'node:test'

import { routeShellInput, type ShellInputState } from './shellInputRouter.js'
import { buildShellFrameInput, type ShellPanelSnapshot } from './shellPanels.js'
import { planShellLayout } from './shellLayout.js'
import {
  projectShellPresentation,
  type ShellPresentation,
} from './shellPresentation.js'
import { composeShellRows } from './shellFrameRenderer.js'

function key(name: string, overrides: { shift?: boolean } = {}) {
  return {
    name,
    ctrl: false,
    meta: false,
    shift: overrides.shift ?? false,
    sequence: name,
  }
}

const base: ShellInputState = {
  focus: 'composer',
  leftDrawerOpen: true,
  rightDrawerOpen: true,
}

function snapshot(presentation: ShellPresentation): ShellPanelSnapshot & {
  presentation: ShellPresentation
} {
  return {
    mode: 'chat',
    model: 'auto',
    project: 'Babel',
    conversation: ['  conversation'],
    prompt: { rows: ['› draft'], cursor: { row: 0, col: 7, visible: true } },
    presentation,
  }
}

test('projection exposes drawer-backed surfaces and selected focus in one effective state', () => {
  const presentation = projectShellPresentation(planShellLayout({ cols: 160, rows: 40 }), base)

  assert.deepEqual(presentation.availableSurfaces, [
    'composer',
    'sessions',
    'project',
    'actions',
    'inspector',
    'conversation',
  ])
  assert.equal(presentation.focus, 'composer')
  assert.equal(presentation.selectedSurface, 'composer')
  assert.equal(presentation.leftDrawerOpen, true)
  assert.equal(presentation.rightDrawerOpen, true)
})

test('resize reconciles focus to a visible surface and routing uses that same state', () => {
  const layout = planShellLayout({ cols: 80, rows: 20 })
  const presentation = projectShellPresentation(layout, {
    ...base,
    focus: 'inspector',
  })

  assert.deepEqual(presentation.availableSurfaces, ['composer', 'conversation'])
  assert.equal(presentation.focus, 'composer')
  assert.equal(routeShellInput(key('a'), presentation.inputState).handled, false)
  assert.equal(routeShellInput(key('f6'), presentation.inputState).state.focus, 'conversation')
})

test('focus changes and Escape change the rendered frame and close both drawers', () => {
  const layout = planShellLayout({ cols: 160, rows: 40 })
  const focused = projectShellPresentation(layout, { ...base, focus: 'sessions' })
  const focusedFrame = buildShellFrameInput(layout, snapshot(focused))
  const composerFrame = buildShellFrameInput(
    layout,
    snapshot(projectShellPresentation(layout, base)),
  )

  assert.notDeepEqual(composeShellRows(focusedFrame), composeShellRows(composerFrame))
  assert.equal(focusedFrame.cursor?.visible, false)
  assert.match(focusedFrame.surfaces.find((surface) => surface.id === 'left')?.rows[0] ?? '', /^›/)

  const conversationFrame = buildShellFrameInput(
    layout,
    snapshot(projectShellPresentation(layout, { ...base, focus: 'conversation' })),
  )
  assert.match(
    conversationFrame.surfaces.find((surface) => surface.id === 'conversation')?.rows[0] ?? '',
    /^›/,
  )

  const closedState = routeShellInput(key('escape'), focused.inputState).state
  const closed = projectShellPresentation(layout, closedState)
  const closedFrame = buildShellFrameInput(layout, snapshot(closed))

  assert.equal(closed.leftDrawerOpen, false)
  assert.equal(closed.rightDrawerOpen, false)
  assert.equal(closedFrame.cursor?.visible, true)
  assert.deepEqual(
    closedFrame.surfaces.map((surface) => surface.id),
    ['header', 'conversation', 'composer', 'footer'],
  )
})

test('non-composer focus blocks composer keys after projection', () => {
  const layout = planShellLayout({ cols: 160, rows: 40 })
  const presentation = projectShellPresentation(layout, { ...base, focus: 'conversation' })

  assert.equal(routeShellInput(key('a'), presentation.inputState).handled, true)
})
