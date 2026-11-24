import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { canHostResponsiveShell, planShellLayout } from './shellLayout.js'
import type { Rect, ShellLayout } from './shellTypes.js'

function assertInside(rect: Rect, cols: number, rows: number): void {
  assert.ok(rect.x >= 0)
  assert.ok(rect.y >= 0)
  assert.ok(rect.width >= 0)
  assert.ok(rect.height >= 0)
  assert.ok(rect.x + rect.width <= cols)
  assert.ok(rect.y + rect.height <= rows)
}

function assertDisjoint(rectangles: readonly Rect[]): void {
  for (let leftIndex = 0; leftIndex < rectangles.length; leftIndex += 1) {
    const left = rectangles[leftIndex]!
    for (let rightIndex = leftIndex + 1; rightIndex < rectangles.length; rightIndex += 1) {
      const right = rectangles[rightIndex]!
      const overlaps =
        left.x < right.x + right.width &&
        right.x < left.x + left.width &&
        left.y < right.y + right.height &&
        right.y < left.y + left.height
      assert.equal(overlaps, false, `rectangles overlap: ${JSON.stringify({ left, right })}`)
    }
  }
}

function interiorRects(layout: ShellLayout): Rect[] {
  return [
    layout.header,
    layout.center,
    layout.conversation,
    layout.conversationText,
    layout.composer,
    layout.footer,
    ...(layout.left ? [layout.left] : []),
    ...(layout.right ? [layout.right] : []),
  ].filter((rect): rect is Rect => rect !== null)
}

function topLevelRects(layout: ShellLayout): Rect[] {
  return [
    layout.header,
    layout.left,
    layout.center,
    layout.right,
    layout.footer,
  ].filter((rect): rect is Rect => rect !== null)
}

describe('planShellLayout', () => {
  it('reclaims closed drawer widths for both conversation and composer', () => {
    for (const [leftDrawerOpen, rightDrawerOpen] of [[false, false], [true, false], [false, true], [true, true]] as const) {
      const layout = planShellLayout({ cols: 160, rows: 45 }, { leftDrawerOpen, rightDrawerOpen })
      assert.equal(layout.left !== null, leftDrawerOpen)
      assert.equal(layout.right !== null, rightDrawerOpen)
      assert.equal(layout.center?.x, leftDrawerOpen ? 30 : 1)
      assert.equal(layout.center?.width, 158 - (leftDrawerOpen ? 29 : 0) - (rightDrawerOpen ? 33 : 0))
      assert.equal(layout.composer?.x, layout.center?.x)
      assert.equal(layout.composer?.width, layout.center?.width)
      for (const rect of topLevelRects(layout)) assertInside(rect, 160, 45)
      assertDisjoint(topLevelRects(layout))
    }
    const medium = planShellLayout({ cols: 120, rows: 35 }, { leftDrawerOpen: false, rightDrawerOpen: true })
    assert.equal(medium.left, null)
    assert.equal(medium.right, null)
    assert.equal(medium.center?.width, 118)
  })

  it('plans the 160-column wide shell with the packet geometry', () => {
    const layout = planShellLayout({ cols: 160, rows: 45 })

    assert.equal(layout.mode, 'wide')
    assert.deepEqual(layout.header, { x: 0, y: 0, width: 160, height: 2 })
    assert.deepEqual(layout.left, { x: 1, y: 2, width: 28, height: 41 })
    assert.deepEqual(layout.center, { x: 30, y: 2, width: 96, height: 41 })
    assert.deepEqual(layout.right, { x: 127, y: 2, width: 32, height: 41 })
    assert.deepEqual(layout.conversation, { x: 30, y: 2, width: 96, height: 36 })
    assert.deepEqual(layout.conversationText, { x: 32, y: 2, width: 92, height: 36 })
    assert.deepEqual(layout.composer, { x: 30, y: 38, width: 96, height: 5 })
    assert.deepEqual(layout.footer, { x: 0, y: 43, width: 160, height: 2 })
  })

  it('keeps the center bounded when the wide shell grows to 200 columns', () => {
    const layout = planShellLayout({ cols: 200, rows: 50 })

    assert.equal(layout.mode, 'wide')
    assert.deepEqual(layout.left, { x: 1, y: 2, width: 28, height: 46 })
    assert.deepEqual(layout.center, { x: 30, y: 2, width: 136, height: 46 })
    assert.deepEqual(layout.right, { x: 167, y: 2, width: 32, height: 46 })
    assert.deepEqual(layout.composer, { x: 30, y: 43, width: 136, height: 5 })
  })

  it('uses the medium shell at 120 columns', () => {
    const layout = planShellLayout({ cols: 120, rows: 40 })

    assert.equal(layout.mode, 'medium')
    assert.deepEqual(layout.left, { x: 1, y: 2, width: 24, height: 36 })
    assert.equal(layout.right, null)
    assert.deepEqual(layout.center, { x: 26, y: 2, width: 93, height: 36 })
    assert.deepEqual(layout.conversationText, { x: 28, y: 2, width: 89, height: 31 })
    assert.deepEqual(layout.composer, { x: 26, y: 33, width: 93, height: 5 })
  })

  it('uses the narrow shell for short wide terminals', () => {
    const layout = planShellLayout({ cols: 160, rows: 20 })

    assert.equal(layout.mode, 'narrow')
    assert.equal(layout.left, null)
    assert.equal(layout.right, null)
    assert.deepEqual(layout.header, { x: 0, y: 0, width: 160, height: 2 })
    assert.deepEqual(layout.center, { x: 1, y: 2, width: 158, height: 16 })
    assert.deepEqual(layout.conversation, { x: 1, y: 2, width: 158, height: 13 })
    assert.deepEqual(layout.composer, { x: 1, y: 15, width: 158, height: 3 })
    assert.deepEqual(layout.footer, { x: 0, y: 18, width: 160, height: 2 })
  })

  it('selects the compact linear host below minimum shell dimensions', () => {
    const layout = planShellLayout({ cols: 43, rows: 16 })

    assert.equal(layout.mode, 'linear')
    assert.equal(layout.header, null)
    assert.equal(layout.center, null)
    assert.equal(layout.footer, null)
  })

  it('renders a usable narrow layout at the 44x16 qualification size', () => {
    // Regression UX-02: 44 columns used to fall below the shell minimum, so the
    // host mounted with every rectangle null and the viewport stayed blank.
    const layout = planShellLayout({ cols: 44, rows: 16 })
    assert.equal(layout.mode, 'narrow')
    assert.deepEqual(layout.header, { x: 0, y: 0, width: 44, height: 2 })
    assert.ok(layout.center && layout.center.width > 30)
    assert.ok(layout.conversation && layout.conversation.height > 5)
    assert.ok(layout.composer && layout.composer.height >= 3)
    assert.deepEqual(layout.footer, { x: 0, y: 14, width: 44, height: 2 })
    for (const rect of topLevelRects(layout)) assertInside(rect, 44, 16)
  })

  it('refuses to mount the responsive host when the grid has no drawable regions', () => {
    assert.equal(canHostResponsiveShell({ cols: 43, rows: 16 }), false)
    assert.equal(canHostResponsiveShell({ cols: 20, rows: 40 }), false)
    assert.equal(canHostResponsiveShell({ cols: 120, rows: 15 }), false)
    assert.equal(canHostResponsiveShell({ cols: 0, rows: 0 }), false)
    // Positive controls: exactly at and above the minimum grid, plus 120x36.
    assert.equal(canHostResponsiveShell({ cols: 44, rows: 16 }), true)
    assert.equal(canHostResponsiveShell({ cols: 60, rows: 16 }), true)
    assert.equal(canHostResponsiveShell({ cols: 120, rows: 36 }), true)
    assert.equal(canHostResponsiveShell({ cols: 160, rows: 45 }), true)
  })

  it('uses effective writable columns for the plan bounds', () => {
    const layout = planShellLayout({ cols: 160, rows: 45, effectiveCols: 159 })

    assert.ok(layout.effectiveCols <= 159)
    for (const rect of interiorRects(layout)) {
      assertInside(rect, layout.effectiveCols, 45)
    }
  })

  it('keeps all allocated regions bounded and non-overlapping', () => {
    for (const dimensions of [
      { cols: 80, rows: 24 },
      { cols: 100, rows: 30 },
      { cols: 120, rows: 40 },
      { cols: 160, rows: 45 },
      { cols: 200, rows: 50 },
    ]) {
      const layout = planShellLayout(dimensions)
      const rectangles = topLevelRects(layout)
      for (const rect of rectangles) assertInside(rect, layout.effectiveCols, dimensions.rows)
      assertDisjoint(rectangles)
    }
  })
})
