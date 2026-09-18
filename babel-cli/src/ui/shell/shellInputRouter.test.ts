import assert from 'node:assert/strict'
import test from 'node:test'
import {
  acquireShellInputLease,
  onShellSurfaceRelease,
  releaseShellInputLease,
  routeShellInput,
  type ShellInputState,
} from './shellInputRouter.js'
import type { KeyEvent } from '../keyInput.js'

function key(name: string, overrides: Partial<KeyEvent> = {}): KeyEvent {
  return { name, ctrl: false, meta: false, shift: false, sequence: name, ...overrides }
}

const base: ShellInputState = { focus: 'composer', leftDrawerOpen: true, rightDrawerOpen: true }

test('F6 cycles shell focus and Shift+F6 reverses it', () => {
  const next = routeShellInput(key('f6'), base)
  assert.equal(next.state.focus, 'sessions')
  const previous = routeShellInput(key('f6', { shift: true }), next.state)
  assert.equal(previous.state.focus, 'composer')
  assert.equal(next.handled, true)
})

test('F6 skips surfaces that are unavailable at the current dimensions', () => {
  const state: ShellInputState = {
    ...base,
    focus: 'composer',
    availableSurfaces: ['composer', 'conversation'],
  }

  assert.equal(routeShellInput(key('f6'), state).state.focus, 'conversation')
  assert.equal(
    routeShellInput(key('f6', { shift: true }), state).state.focus,
    'conversation',
  )
})

test('Escape closes open drawers and Ctrl+P opens the palette from the composer', () => {
  const closed = routeShellInput(key('escape'), base)
  assert.deepEqual(closed.state, { focus: 'composer', leftDrawerOpen: false, rightDrawerOpen: false })
  assert.equal(closed.action, 'close-overlay')
  const palette = routeShellInput(key('p', { ctrl: true }), base)
  assert.equal(palette.action, 'open-palette')
  assert.equal(routeShellInput(key('r', { ctrl: true }), base).action, 'open-reverse-search')
})

test('composer editing keys remain unhandled for PromptInput', () => {
  const result = routeShellInput(key('a'), base)
  assert.equal(result.handled, false)
  assert.deepEqual(result.state, base)
})

test('notifies responsive hosts after the outermost shell lease releases', () => {
  let releases = 0
  const unregister = onShellSurfaceRelease(() => { releases += 1 })
  const outer = acquireShellInputLease()
  const inner = acquireShellInputLease()
  inner()
  assert.equal(releases, 0)
  outer()
  assert.equal(releases, 1)
  unregister()
})
