import type { KeyEvent } from '../keyInput.js'

export type ShellFocus = 'composer' | 'sessions' | 'project' | 'actions' | 'inspector' | 'conversation'

export interface ShellInputState {
  focus: ShellFocus
  leftDrawerOpen: boolean
  rightDrawerOpen: boolean
}
export interface ShellInputResult {
  handled: boolean
  state: ShellInputState
  action?: 'open-palette' | 'close-overlay' | 'focus-changed'
}

const ORDER: readonly ShellFocus[] = ['composer', 'sessions', 'project', 'actions', 'inspector', 'conversation']

function nextFocus(state: ShellInputState, direction: 1 | -1): ShellFocus {
  const index = ORDER.indexOf(state.focus)
  return ORDER[(index + direction + ORDER.length) % ORDER.length]!
}

/** Route shell navigation keys without stealing composer editing bindings. */
export function routeShellInput(event: KeyEvent, state: ShellInputState): ShellInputResult {
  if (event.name === 'f6') {
    return { handled: true, state: { ...state, focus: nextFocus(state, event.shift ? -1 : 1) }, action: 'focus-changed' }
  }
  if (event.name === 'escape' && (state.leftDrawerOpen || state.rightDrawerOpen)) {
    return { handled: true, state: { ...state, leftDrawerOpen: false, rightDrawerOpen: false, focus: 'composer' }, action: 'close-overlay' }
  }
  if (event.name === 'p' && event.ctrl && state.focus === 'composer') {
    return { handled: true, state, action: 'open-palette' }
  }
  if (state.focus === 'composer') return { handled: false, state }
  return { handled: false, state }
}
