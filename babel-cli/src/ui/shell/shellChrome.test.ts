import assert from 'node:assert/strict'
import test from 'node:test'

import { stripAnsi } from '../theme.js'
import { planShellLayout } from './shellLayout.js'
import { buildShellFrameInput } from './shellPanels.js'
import { composeShellRows } from './shellFrameRenderer.js'
import { formatShellSpeaker, formatShellTool } from './shellTranscript.js'

function plain(frameRows: readonly string[]): string {
  return frameRows.map((row) => stripAnsi(row)).join('\n')
}

test('empty wide frame shows the north star chrome without invented catalog data', () => {
  const layout = planShellLayout({ cols: 160, rows: 45 })
  const frame = buildShellFrameInput(layout, {
    mode: 'chat',
    model: 'auto',
    project: 'Babel',
    conversation: [],
    sessions: [],
    projectRows: [],
    actions: ['New session', 'Git status'],
    clock: '10:24 AM',
    prompt: { rows: [''], cursor: { row: 0, col: 0, visible: true } },
  })
  const text = plain(composeShellRows(frame))

  assert.match(text, /\[ Chat \]/)
  assert.match(text, /Plan/)
  assert.match(text, /Deep/)
  assert.match(text, /SESSIONS/)
  assert.match(text, /PROJECT/)
  assert.match(text, /QUICK ACTIONS/)
  assert.match(text, /No saved conversations/)
  assert.match(text, /Unknown until/)
  assert.match(text, /Enter send · Ctrl\+Enter send/)
  assert.match(text, /BABEL v/)
  assert.equal(text.includes('gpt-5.6'), false)
  assert.equal(text.includes('42,318'), false)
  assert.equal(text.includes('All systems operational'), false)
  assert.equal(frame.surfaces.some((surface) => surface.id === 'right'), true)
})

test('populated wide frame places the selection, tree, tool state, and meter', () => {
  const layout = planShellLayout({ cols: 160, rows: 45 })
  const frame = buildShellFrameInput(layout, {
    mode: 'plan',
    model: 'deepseek-v4-pro',
    project: 'Babel',
    conversation: ['YOU', 'inspect the controller'],
    sessions: ['Timeout architecture'],
    projectRows: ['[dir] src'],
    actions: ['New session'],
    modelChoices: [{ id: 'deepseek-v4-pro', label: 'deepseek-v4-pro' }],
    toolStates: [{ name: 'read_file', state: 'on' }],
    meter: { used: 42318, limit: 112000 },
    status: ['Ready'],
    clock: '10:24 AM',
    presentation: {
      focus: 'sessions',
      selectedSurface: 'sessions',
      selectedIndex: 0,
      leftDrawerOpen: true,
      rightDrawerOpen: true,
      availableSurfaces: ['composer', 'sessions'],
      inputState: { focus: 'sessions', leftDrawerOpen: true, rightDrawerOpen: true },
    },
    prompt: { rows: ['draft'], cursor: { row: 0, col: 1, visible: true } },
  })
  const text = plain(composeShellRows(frame))

  assert.match(text, /\[ Plan \]/)
  assert.match(text, /▸ Timeout architecture/)
  assert.match(text, /\[dir\] src/)
  assert.match(text, /read_file/)
  assert.match(text, /On/)
  assert.match(text, /42,318 \/ 112,000/)
  assert.match(text, /38%/)
  assert.match(text, /● Ready/)
  assert.equal(frame.cursor?.visible, false)
})

test('medium hides the inspector and narrow hides both rails', () => {
  const medium = buildShellFrameInput(planShellLayout({ cols: 120, rows: 40 }), {
    mode: 'chat',
    model: 'auto',
    project: 'Babel',
    conversation: [],
  })
  assert.equal(medium.surfaces.some((surface) => surface.id === 'right'), false)
  assert.equal(medium.surfaces.some((surface) => surface.id === 'left'), true)

  const narrow = buildShellFrameInput(planShellLayout({ cols: 160, rows: 20 }), {
    mode: 'chat',
    model: 'auto',
    project: 'Babel',
    conversation: ['hello'],
    prompt: { rows: ['draft'], cursor: { row: 0, col: 0, visible: true } },
  })
  assert.equal(narrow.surfaces.some((surface) => surface.id === 'left'), false)
  assert.equal(narrow.surfaces.some((surface) => surface.id === 'right'), false)
  assert.equal(narrow.surfaces.some((surface) => surface.id === 'composer'), true)
  assert.match(plain(composeShellRows(narrow)), /┌/)
})

test('shell transcript uses speaker labels, tool detail only when present, and heading cards', () => {
  const user = formatShellSpeaker('YOU', 'Investigate the timeout.', 40)
  assert.equal(user[0]?.includes('YOU'), true)
  assert.equal(user.some((line) => line.includes('Investigate the timeout.')), true)

  const assistant = formatShellSpeaker('BABEL', '### KEY FINDINGS\n1. Timeout is elapsed time.\n\nDone.', 40)
  assert.equal(assistant.some((line) => line.includes('KEY FINDINGS')), true)
  assert.equal(assistant.some((line) => line.includes('┌') || line.includes('KEY FINDINGS')), true)

  const withDetail = formatShellTool(
    { tool: 'read', target: 'src/review/controller.ts', status: 'completed', detail: '184 lines' },
    60,
  ).join('\n')
  assert.match(withDetail, /> read\s+src\/review\/controller\.ts/)
  assert.match(withDetail, /184 lines/)

  const withoutDetail = formatShellTool(
    { tool: 'read', target: 'src/a.ts', status: 'completed' },
    40,
  ).join('\n')
  assert.equal(withoutDetail.includes('lines'), false)
  assert.match(withoutDetail, /> read/)
})
