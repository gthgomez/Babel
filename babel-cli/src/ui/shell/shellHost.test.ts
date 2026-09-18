import assert from 'node:assert/strict'
import test from 'node:test'
import { createShellFrameRenderer } from './shellFrameRenderer.js'
import { createShellHost } from './shellHost.js'
import type { ShellFrameInput, ShellOutputPort } from './shellTypes.js'

function makeOutput(): ShellOutputPort & { events: string[] } {
  const events: string[] = []
  return {
    events,
    beginFrame: () => events.push('begin'),
    endFrame: () => events.push('end'),
    moveCursor: (row, col) => events.push(`move:${row},${col}`),
    write: (text) => events.push(`write:${text}`),
  }
}

function makeFrame(): ShellFrameInput {
  return {
    cols: 8,
    rows: 2,
    background: ' ',
    surfaces: [{ id: 'center', rect: { x: 0, y: 0, width: 8, height: 2 }, rows: ['hello', 'world'] }],
  }
}

test('renders through one scheduled root owner and coalesces invalidation', () => {
  const callbacks = new Map<string, () => void>()
  const requests: string[] = []
  const output = makeOutput()
  const host = createShellHost({
    frameRenderer: createShellFrameRenderer(output),
    frameSource: makeFrame,
    scheduler: {
      register: (id, callback) => {
        callbacks.set(id, callback)
        return () => callbacks.delete(id)
      },
      request: (id) => requests.push(id),
    },
  })

  host.mount()
  host.invalidate('first')
  host.invalidate('second')
  callbacks.get(host.componentId)?.()

  assert.equal(output.events.filter((event) => event === 'begin').length, 1)
  assert.equal(requests.length, 1)
  assert.equal(host.mounted, true)
})

test('exclusive terminal leases suspend painting and redraw after nested return', async () => {
  const callbacks = new Map<string, () => void>()
  const output = makeOutput()
  const host = createShellHost({
    frameRenderer: createShellFrameRenderer(output),
    frameSource: makeFrame,
    scheduler: {
      register: (id, callback) => {
        callbacks.set(id, callback)
        return () => callbacks.delete(id)
      },
      request: () => {},
    },
  })

  host.mount()
  await host.withExclusiveTerminal('pager', async () => {
    callbacks.get(host.componentId)?.()
    await host.withExclusiveTerminal('editor', async () => {
      callbacks.get(host.componentId)?.()
    })
    callbacks.get(host.componentId)?.()
  })
  callbacks.get(host.componentId)?.()

  assert.equal(output.events.filter((event) => event === 'begin').length, 1)
  assert.equal(host.mounted, true)
})

test('disposal is idempotent and prevents later scheduled paints', () => {
  const callbacks = new Map<string, () => void>()
  const output = makeOutput()
  const host = createShellHost({
    frameRenderer: createShellFrameRenderer(output),
    frameSource: makeFrame,
    scheduler: {
      register: (id, callback) => {
        callbacks.set(id, callback)
        return () => callbacks.delete(id)
      },
      request: () => {},
    },
  })

  host.mount()
  host.dispose()
  host.dispose()
  callbacks.get(host.componentId)?.()

  assert.equal(host.mounted, false)
  assert.equal(output.events.filter((event) => event === 'begin').length, 0)
})
