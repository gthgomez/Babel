import type { KeyEvent } from '../keyInput.js'

export type ShellFocus = 'composer' | 'sessions' | 'project' | 'actions' | 'inspector' | 'conversation'

export interface ShellInputState {
  focus: ShellFocus
  leftDrawerOpen: boolean
  rightDrawerOpen: boolean
  readonly availableSurfaces?: readonly ShellFocus[]
}
export interface ShellInputResult {
  handled: boolean
  state: ShellInputState
  action?:
    | 'open-palette'
    | 'close-overlay'
    | 'focus-changed'
    | 'move-selection'
    | 'activate-selection'
}

const ORDER: readonly ShellFocus[] = ['composer', 'sessions', 'project', 'actions', 'inspector', 'conversation']

function nextFocus(state: ShellInputState, direction: 1 | -1): ShellFocus {
  const available = state.availableSurfaces?.length ? state.availableSurfaces : ORDER
  const index = Math.max(0, available.indexOf(state.focus))
  return available[(index + direction + available.length) % available.length]!
}

let activeLeaseCount = 0

/** Acquire one temporary input owner; the returned release is idempotent. */
export function acquireShellInputLease(): () => void {
  activeLeaseCount += 1
  let released = false
  return () => {
    if (released) return
    released = true
    activeLeaseCount = Math.max(0, activeLeaseCount - 1)
  }
}

/** Release a lease returned by acquireShellInputLease, if one exists. */
export function releaseShellInputLease(release?: () => void): void {
  release?.()
}

export function shellInputLeaseActive(): boolean {
  return activeLeaseCount > 0
}

/** Route shell navigation keys without stealing composer editing bindings. */
export function routeShellInput(event: KeyEvent, state: ShellInputState): ShellInputResult {
  if (shellInputLeaseActive()) return { handled: true, state }
  if (event.name === 'f6') {
    return { handled: true, state: { ...state, focus: nextFocus(state, event.shift ? -1 : 1) }, action: 'focus-changed' }
  }
  if (event.name === 'escape' && (state.leftDrawerOpen || state.rightDrawerOpen)) {
    return { handled: true, state: { ...state, leftDrawerOpen: false, rightDrawerOpen: false, focus: 'composer' }, action: 'close-overlay' }
  }
  if (event.name === 'p' && event.ctrl) {
    return { handled: true, state, action: 'open-palette' }
  }
  if (state.focus === 'composer') return { handled: false, state }

  if (event.name === 'up' || event.name === 'down' || event.name === 'home' ||
    event.name === 'end' || event.name === 'pageup' || event.name === 'pagedown') {
    return { handled: true, state, action: 'move-selection' }
  }
  if (event.name === 'enter') {
    return { handled: true, state, action: 'activate-selection' }
  }
  return { handled: true, state }
}
