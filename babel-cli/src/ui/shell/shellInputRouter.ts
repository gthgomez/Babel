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
    | 'open-reverse-search'
    | 'close-overlay'
    | 'focus-changed'
    | 'move-selection'
    | 'activate-selection'
    | 'interrupt'
    | 'scroll-conversation'
    | 'composer-escape'
}

const ORDER: readonly ShellFocus[] = ['composer', 'sessions', 'project', 'actions', 'inspector', 'conversation']

function nextFocus(state: ShellInputState, direction: 1 | -1): ShellFocus {
  const available = state.availableSurfaces?.length ? state.availableSurfaces : ORDER
  const index = Math.max(0, available.indexOf(state.focus))
  return available[(index + direction + available.length) % available.length]!
}

let activeLeaseCount = 0
const shellSurfaceReleaseListeners = new Set<() => void>()

/** Acquire one temporary input owner; the returned release is idempotent. */
export function acquireShellInputLease(): () => void {
  activeLeaseCount += 1
  let released = false
  return () => {
    if (released) return
    released = true
    activeLeaseCount = Math.max(0, activeLeaseCount - 1)
    if (activeLeaseCount === 0) {
      for (const listener of shellSurfaceReleaseListeners) listener()
    }
  }
}

/** Release a lease returned by acquireShellInputLease, if one exists. */
export function releaseShellInputLease(release?: () => void): void {
  release?.()
}

export function shellInputLeaseActive(): boolean {
  return activeLeaseCount > 0
}

/** Observe the point after the outermost foreign shell lease releases. */
export function onShellSurfaceRelease(listener: () => void): () => void {
  shellSurfaceReleaseListeners.add(listener)
  return () => shellSurfaceReleaseListeners.delete(listener)
}

/** Notify observers after surfaces whose lease is managed elsewhere close. */
export function notifyShellSurfaceReleased(): void {
  for (const listener of shellSurfaceReleaseListeners) listener()
}

const SCROLL_KEYS = new Set(['up', 'down', 'home', 'end', 'pageup', 'pagedown'])

/** Route shell navigation keys without stealing composer editing bindings. */
export function routeShellInput(event: KeyEvent, state: ShellInputState): ShellInputResult {
  if (shellInputLeaseActive()) return { handled: true, state }
  if (event.ctrl && event.name === 'c') {
    return { handled: true, state, action: 'interrupt' }
  }
  if (event.name === 'f6') {
    return { handled: true, state: { ...state, focus: nextFocus(state, event.shift ? -1 : 1) }, action: 'focus-changed' }
  }
  if (event.name === 'escape') {
    if (state.leftDrawerOpen || state.rightDrawerOpen) {
      return { handled: true, state: { ...state, leftDrawerOpen: false, rightDrawerOpen: false, focus: 'composer' }, action: 'close-overlay' }
    }
    if (state.focus !== 'composer') {
      return { handled: true, state: { ...state, focus: 'composer' }, action: 'focus-changed' }
    }
    return { handled: true, state, action: 'composer-escape' }
  }
  if (event.name === 'p' && event.ctrl) {
    return { handled: true, state, action: 'open-palette' }
  }
  if (event.name === 'r' && event.ctrl) {
    return { handled: true, state, action: 'open-reverse-search' }
  }
  if (state.focus === 'composer') return { handled: false, state }

  if (state.focus === 'conversation' && SCROLL_KEYS.has(event.name)) {
    return { handled: true, state, action: 'scroll-conversation' }
  }
  if (event.name === 'up' || event.name === 'down' || event.name === 'home' ||
    event.name === 'end' || event.name === 'pageup' || event.name === 'pagedown') {
    return { handled: true, state, action: 'move-selection' }
  }
  if (event.name === 'enter') {
    return { handled: true, state, action: 'activate-selection' }
  }
  return { handled: true, state }
}
