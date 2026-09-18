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
  assert.equal(frame.cursor?.visible, true)
  for (const surface of frame.surfaces) {
    assert.ok(surface.rect.x >= 0)
    assert.ok(surface.rect.y >= 0)
    assert.ok(surface.rect.x + surface.rect.width <= frame.cols)
    assert.ok(surface.rect.y + surface.rect.height <= frame.rows)
  }
})
