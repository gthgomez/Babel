import assert from 'node:assert/strict'
import test from 'node:test'

import { routeShellInput, type ShellInputState } from './shellInputRouter.js'
import type { KeyEvent } from '../keyInput.js'
import {
  initialShellSelection,
  moveShellSelection,
  resolveShellActivation,
  ShellNavigator,
  type ShellNavigationRow,
} from './shellNavigation.js'
import { runShellCommand, type ShellCommandOperations } from './shellOperations.js'

function key(name: string): KeyEvent {
  return { name, ctrl: false, meta: false, shift: false, sequence: name }
}

const sessionsFocus: ShellInputState = {
  focus: 'sessions',
  leftDrawerOpen: true,
  rightDrawerOpen: true,
}

function row(id: string): ShellNavigationRow {
  return { id, label: id, command: { kind: 'session.resume', id } }
}

function fakeOperations(
  overrides: Partial<ShellCommandOperations> = {},
): { operations: ShellCommandOperations; calls: string[] } {
  const calls: string[] = []
  const operations: ShellCommandOperations = {
    resumeSession: async (id) => {
      calls.push(`resume:${id}`)
      return { ok: true }
    },
    newSession: () => calls.push('new'),
    setTarget: (root) => calls.push(`target:${root}`),
    toggleDirectory: (root) => calls.push(`toggle:${root}`),
    setMode: (mode) => calls.push(`mode:${mode}`),
    setModel: (model) => calls.push(`model:${model}`),
    runAction: async (command) => {
      calls.push(`action:${command}`)
    },
    toggleInspector: (key) => calls.push(`inspector:${key}`),
    ...overrides,
  }
  return { operations, calls }
}

test('arrows change selected row without changing the active thread', () => {
  const navigator = new ShellNavigator()
  navigator.setRows('sessions', [row('s1'), row('s2')])
  const activeThread = 'thread-original'

  const down = routeShellInput(key('down'), sessionsFocus)
  assert.equal(down.action, 'move-selection')
  assert.deepEqual(navigator.move(down.state.focus, 'down'), { surface: 'sessions', index: 1 })

  const downAgain = routeShellInput(key('down'), sessionsFocus)
  // Clamps at the last row; never wraps into a different surface.
  assert.deepEqual(navigator.move(downAgain.state.focus, 'down'), { surface: 'sessions', index: 1 })

  assert.equal(activeThread, 'thread-original')
  assert.equal(navigator.getSelection().index, 1)
})

test('Enter on a session row dispatches resume for the selected id', async () => {
  const navigator = new ShellNavigator()
  navigator.setRows('sessions', [row('s1'), row('s2')])
  navigator.move('sessions', 'down')

  const enter = routeShellInput(key('enter'), sessionsFocus)
  assert.equal(enter.action, 'activate-selection')
  assert.deepEqual(navigator.activate(enter.state.focus), { kind: 'session.resume', id: 's2' })

  const { operations, calls } = fakeOperations()
  const outcome = await runShellCommand(navigator.activate('sessions'), operations)
  assert.equal(outcome.handled, true)
  assert.deepEqual(calls, ['resume:s2'])
})

test('Enter on an empty sessions panel is a safe no-op', async () => {
  const navigator = new ShellNavigator()
  navigator.setRows('sessions', [])

  assert.deepEqual(navigator.activate('sessions'), {
    kind: 'none',
    reason: 'no selectable sessions rows',
  })
  const { operations, calls } = fakeOperations()
  const outcome = await runShellCommand(navigator.activate('sessions'), operations)
  assert.equal(outcome.handled, false)
  assert.deepEqual(calls, [])
})

test('activation maps actions and project rows to real commands', async () => {
  const navigator = new ShellNavigator()
  navigator.setRows('actions', [
    { id: '/clear', label: 'New conversation', command: { kind: 'session.new' } },
    { id: '/diff', label: '/diff', command: { kind: 'action.run', command: '/diff' } },
  ])
  navigator.setRows('project', [
    { id: '/root/src', label: '[dir] src', command: { kind: 'target.set', root: '/root/src' } },
    { id: '/root/README.md', label: '[file] README.md' },
  ])

  assert.deepEqual(navigator.activate('actions'), { kind: 'session.new' })
  navigator.move('actions', 'down')
  assert.deepEqual(navigator.activate('actions'), { kind: 'action.run', command: '/diff' })

  assert.deepEqual(navigator.activate('project'), { kind: 'target.set', root: '/root/src' })
  navigator.move('project', 'down')
  assert.equal(navigator.activate('project').kind, 'none')
})

test('move clamps at bounds and supports home/end', () => {
  const start = initialShellSelection()
  assert.deepEqual(moveShellSelection(start, 'actions', 'up', 3), { surface: 'actions', index: 0 })
  assert.deepEqual(moveShellSelection({ surface: 'actions', index: 2 }, 'actions', 'down', 3), {
    surface: 'actions',
    index: 2,
  })
  assert.deepEqual(moveShellSelection({ surface: 'actions', index: 2 }, 'actions', 'home', 3), {
    surface: 'actions',
    index: 0,
  })
  assert.deepEqual(moveShellSelection({ surface: 'actions', index: 0 }, 'actions', 'end', 3), {
    surface: 'actions',
    index: 2,
  })
  assert.deepEqual(resolveShellActivation('inspector', 0, []), {
    kind: 'none',
    reason: 'no selectable inspector rows',
  })
})
