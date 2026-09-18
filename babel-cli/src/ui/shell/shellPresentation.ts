import type { ShellFocus, ShellInputState } from './shellInputRouter.js'
import type { ShellLayout } from './shellTypes.js'

export interface ShellPresentation {
  readonly focus: ShellFocus
  readonly selectedSurface: ShellFocus
  readonly leftDrawerOpen: boolean
  readonly rightDrawerOpen: boolean
  readonly availableSurfaces: readonly ShellFocus[]
  readonly inputState: ShellInputState
}

function getAvailableSurfaces(layout: ShellLayout, state: ShellInputState): ShellFocus[] {
  const surfaces: ShellFocus[] = ['composer']
  if (layout.left && state.leftDrawerOpen) surfaces.push('sessions', 'project', 'actions')
  if (layout.right && state.rightDrawerOpen) surfaces.push('inspector')
  if (layout.conversation) surfaces.push('conversation')
  return surfaces
}

/** Reconcile input ownership with the surfaces that the current layout can show. */
export function projectShellPresentation(
  layout: ShellLayout,
  state: ShellInputState,
): ShellPresentation {
  const availableSurfaces = getAvailableSurfaces(layout, state)
  const focus = availableSurfaces.includes(state.focus) ? state.focus : 'composer'
  const leftDrawerOpen = Boolean(layout.left && state.leftDrawerOpen)
  const rightDrawerOpen = Boolean(layout.right && state.rightDrawerOpen)
  const inputState: ShellInputState = {
    focus,
    leftDrawerOpen,
    rightDrawerOpen,
    availableSurfaces,
  }
  return {
    focus,
    selectedSurface: focus,
    leftDrawerOpen,
    rightDrawerOpen,
    availableSurfaces,
    inputState,
  }
}
