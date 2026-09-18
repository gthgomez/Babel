import assert from 'node:assert/strict'
import test from 'node:test'
import { buildShellFrameInput } from './shellPanels.js'
import { planShellLayout } from './shellLayout.js'

test('buildShellFrameInput keeps required panels inside the planned layout', () => {
  const layout = planShellLayout({ cols: 160, rows: 40 })
  const frame = buildShellFrameInput(layout, {
    mode: 'chat',
    model: 'auto',
    project: 'Babel',
    conversation: ['› hello', '  world'],
    prompt: { rows: ['› draft'], cursor: { row: 0, col: 7, visible: true } },
  })

  assert.deepEqual(frame.cols, layout.effectiveCols)
  assert.deepEqual(frame.rows, layout.rows)
  assert.deepEqual(frame.surfaces.map((surface) => surface.id), [
    'header',
    'left',
    'conversation',
    'right',
    'composer',
    'footer',
  ])
  const footer = frame.surfaces.find((surface) => surface.id === 'footer')!
  assert.equal(footer.rect.y, layout.footer!.y + 1)
  assert.equal(frame.rules?.some((rule) => rule.position === layout.footer!.y), true)
  assert.equal(frame.cursor?.visible, true)
  for (const surface of frame.surfaces) {
    assert.ok(surface.rect.x >= 0)
    assert.ok(surface.rect.y >= 0)
    assert.ok(surface.rect.x + surface.rect.width <= frame.cols)
    assert.ok(surface.rect.y + surface.rect.height <= frame.rows)
  }
})

test('buildShellFrameInput keeps hosted editor popups in the composer surface', () => {
  const layout = planShellLayout({ cols: 120, rows: 30 })
  const frame = buildShellFrameInput(layout, {
    mode: 'chat',
    model: 'auto',
    project: 'Babel',
    conversation: [],
    prompt: {
      rows: ['› draft'],
      cursor: { row: 0, col: 7, visible: true },
      popup: { rect: { x: 0, y: 1, width: 30, height: 2 }, rows: ['─', ' item'] },
    },
  })

  const popup = frame.surfaces.find((surface) => surface.id === 'composer-popup')!
  assert.deepEqual(popup.rect, {
    x: layout.composer!.x,
    y: layout.composer!.y + 1,
    width: 30,
    height: 2,
  })
})
