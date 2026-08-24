import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createVirtualCellGrid } from './virtualCellGrid.js'

describe('VirtualCellGrid', () => {
  it('does X when Y: CSI 2A then 2K overwrites the visible row not the stripAnsi log', () => {
    const grid = createVirtualCellGrid(20, 8)
    grid.apply('Hello\nWorld\n')
    grid.apply('\x1b[2A')
    grid.apply('\x1b[2K')
    grid.apply('Goodbye')
    const snap = grid.snapshot()
    assert.equal(snap.lines[0], 'Goodbye')
    assert.notEqual(snap.lines.join('\n'), 'HelloWorldGoodbye')
  })

  it('does X when Y: CSI H with omitted params homes to 1;1', () => {
    const grid = createVirtualCellGrid(10, 5)
    grid.apply('abc\nxyz')
    grid.apply('\x1b[H')
    grid.apply('Q')
    const snap = grid.snapshot()
    assert.equal(snap.lines[0]?.startsWith('Qbc'), true)
    assert.equal(snap.cursorRow, 0)
    assert.equal(snap.cursorCol, 1)
  })

  it('does X when Y: LF at the scroll bottom shifts rows', () => {
    const grid = createVirtualCellGrid(8, 3)
    grid.apply('one\n')
    grid.apply('two\n')
    grid.apply('three\n')
    const snap = grid.snapshot()
    assert.equal(snap.lines[0], 'two')
    assert.equal(snap.lines[1], 'three')
  })

  it('does X when Y: CR returns to column 0 on the same row', () => {
    const grid = createVirtualCellGrid(12, 2)
    grid.apply('abcdef')
    grid.apply('\r')
    grid.apply('XY')
    const snap = grid.snapshot()
    assert.equal(snap.lines[0]?.startsWith('XYcdef'), true)
  })

  it('does X when Y: alt-screen 1049h clears the alternate buffer', () => {
    const grid = createVirtualCellGrid(10, 4)
    grid.apply('keep')
    grid.apply('\x1b[?1049h')
    grid.apply('alt')
    let snap = grid.snapshot()
    assert.equal(snap.altScreen, true)
    assert.equal(snap.lines[0], 'alt')
    grid.apply('\x1b[?1049l')
    snap = grid.snapshot()
    assert.equal(snap.altScreen, false)
    assert.equal(snap.lines[0], 'keep')
  })

  it('does X when Y: split CSI across chunks is completed later', () => {
    const grid = createVirtualCellGrid(10, 3)
    grid.apply('Z')
    grid.apply('\x1b[')
    grid.apply('2K')
    const snap = grid.snapshot()
    assert.equal(snap.lines[0], '')
  })

  it('does X when Y: bare CSI r resets the scroll region', () => {
    const grid = createVirtualCellGrid(6, 4)
    grid.apply('\x1b[2;3r')
    grid.apply('\x1b[r')
    const snap = grid.snapshot()
    assert.equal(snap.scrollTop, 0)
    assert.equal(snap.scrollBottom, 3)
  })
})
