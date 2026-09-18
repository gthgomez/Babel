import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  createShellFrameRenderer,
  type ShellFrameRenderer,
} from './shellFrameRenderer.js'
import type {
  LocalCursor,
  ShellFrameInput,
  ShellOutputPort,
} from './shellTypes.js'

type Call =
  | { kind: 'begin' }
  | { kind: 'end' }
  | { kind: 'write'; text: string }
  | { kind: 'cursor'; row: number; col: number }

function createOutput(options: { throwOnWrite?: boolean } = {}): {
  output: ShellOutputPort
  calls: Call[]
} {
  const calls: Call[] = []
  return {
    calls,
    output: {
      beginFrame: () => calls.push({ kind: 'begin' }),
      endFrame: () => calls.push({ kind: 'end' }),
      write: (text) => {
        calls.push({ kind: 'write', text })
        if (options.throwOnWrite) throw new Error('output failed')
      },
      moveCursor: (row, col) => calls.push({ kind: 'cursor', row, col }),
    },
  }
}

function frame(
  surfaces: ShellFrameInput['surfaces'],
  cursor?: LocalCursor,
): ShellFrameInput {
  const base = {
    cols: 20,
    rows: 3,
    background: '.',
    surfaces,
  }
  return cursor === undefined ? base : { ...base, cursor }
}

function writes(calls: readonly Call[]): string[] {
  return calls.filter((call): call is Extract<Call, { kind: 'write' }> => call.kind === 'write')
    .map((call) => call.text)
}

function newRenderer(output: ShellOutputPort): ShellFrameRenderer {
  return createShellFrameRenderer(output)
}

describe('ShellFrameRenderer', () => {
  it('composes complete rows so a center update cannot erase a sentinel rail', () => {
    const { output, calls } = createOutput()
    const renderer = newRenderer(output)

    renderer.render(frame([
      { id: 'left', rect: { x: 0, y: 0, width: 5, height: 3 }, rows: ['RAIL'] },
      { id: 'center', rect: { x: 6, y: 0, width: 8, height: 3 }, rows: ['first'] },
      { id: 'right', rect: { x: 15, y: 0, width: 5, height: 3 }, rows: ['RIGHT'] },
    ]))
    calls.length = 0

    renderer.render(frame([
      { id: 'left', rect: { x: 0, y: 0, width: 5, height: 3 }, rows: ['RAIL'] },
      { id: 'center', rect: { x: 6, y: 0, width: 8, height: 3 }, rows: ['second'] },
      { id: 'right', rect: { x: 15, y: 0, width: 5, height: 3 }, rows: ['RIGHT'] },
    ]))

    assert.deepEqual(writes(calls), ['RAIL..second...RIGHT'])
  })

  it('clips by display width without splitting wide or combined characters', () => {
    const { output, calls } = createOutput()
    const renderer = newRenderer(output)

    renderer.render(frame([
      {
        id: 'center',
        rect: { x: 0, y: 0, width: 8, height: 1 },
        rows: ['界e\u0301🙂unsafe\x1b[2J'],
      },
    ]))

    const row = writes(calls)[0]!
    assert.equal(row.length > 0, true)
    const committed = renderer.committedRows()
    assert.ok(committed)
    assert.equal(committed[0]?.includes('\x1b[2J'), false)
    assert.equal(renderer.displayWidthOfRow(0), 20)
  })

  it('pads rows and clears old text after a shrink', () => {
    const { output, calls } = createOutput()
    const renderer = newRenderer(output)

    renderer.render(frame([
      { id: 'center', rect: { x: 0, y: 0, width: 20, height: 1 }, rows: ['old content'] },
    ]))
    calls.length = 0
    renderer.render(frame([
      { id: 'center', rect: { x: 0, y: 0, width: 20, height: 1 }, rows: ['new'] },
    ]))

    assert.deepEqual(writes(calls), ['new.................'])
  })

  it('diffs unchanged complete rows', () => {
    const { output, calls } = createOutput()
    const renderer = newRenderer(output)
    const current = frame([
      { id: 'center', rect: { x: 0, y: 0, width: 20, height: 3 }, rows: ['same', 'same', 'changed'] },
    ])

    renderer.render(current)
    calls.length = 0
    renderer.render(current)

    assert.deepEqual(writes(calls), [])
    assert.deepEqual(calls.filter((call) => call.kind === 'cursor'), [])
  })

  it('restores the prompt cursor after all content writes', () => {
    const { output, calls } = createOutput()
    const renderer = newRenderer(output)

    renderer.render(frame(
      [{ id: 'center', rect: { x: 0, y: 0, width: 20, height: 1 }, rows: ['content'] }],
      { row: 1, col: 4, visible: true },
    ))

    let cursorIndex = -1
    let lastWriteIndex = -1
    for (let index = 0; index < calls.length; index += 1) {
      if (calls[index]?.kind === 'cursor') cursorIndex = index
      if (calls[index]?.kind === 'write') lastWriteIndex = index
    }
    assert.deepEqual(calls[cursorIndex], { kind: 'cursor', row: 2, col: 5 })
    assert.ok(cursorIndex > lastWriteIndex)
  })

  it('releases the frame and retries the full frame after output failure', () => {
    const first = createOutput({ throwOnWrite: true })
    const renderer = newRenderer(first.output)
    const input = frame([
      { id: 'center', rect: { x: 0, y: 0, width: 20, height: 1 }, rows: ['content'] },
    ])

    assert.throws(() => renderer.render(input), /output failed/)
    assert.deepEqual(first.calls.at(-1), { kind: 'end' })
    assert.deepEqual(renderer.committedRows(), null)

    const second = createOutput()
    const retrying = newRenderer(second.output)
    retrying.render(input)
    assert.equal(writes(second.calls).length, 3)
  })

  it('invalidates the committed frame when explicitly requested', () => {
    const { output, calls } = createOutput()
    const renderer = newRenderer(output)
    const input = frame([
      { id: 'center', rect: { x: 0, y: 0, width: 20, height: 1 }, rows: ['content'] },
    ])

    renderer.render(input)
    calls.length = 0
    renderer.invalidate('theme-change')
    renderer.render(input)

    assert.equal(writes(calls).length, 3)
  })
})
