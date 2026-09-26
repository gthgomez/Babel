import type { ShellFocus, ShellInputState } from './shellInputRouter.js'
import type { ShellLayout } from './shellTypes.js'

export interface ShellPresentation {
  readonly focus: ShellFocus
  /** Surface that owns the row cursor; distinct from keyboard focus. */
  readonly selectedSurface: ShellFocus
  /** Zero-based selected row within `selectedSurface`. */
  readonly selectedIndex: number
  readonly leftDrawerOpen: boolean
  readonly rightDrawerOpen: boolean
  readonly availableSurfaces: readonly ShellFocus[]
  readonly inputState: ShellInputState
}

/** Row cursor supplied by the navigation owner. */
export interface ShellSelectionProjection {
  readonly surface: ShellFocus
  readonly index: number
}

function getAvailableSurfaces(layout: ShellLayout, state: ShellInputState): ShellFocus[] {
  const surfaces: ShellFocus[] = ['composer']
  if (layout.left && state.leftDrawerOpen) surfaces.push('sessions', 'project', 'actions')
  if (layout.right && state.rightDrawerOpen) surfaces.push('inspector')
  if (layout.conversation) surfaces.push('conversation')
  return surfaces
}

/**
 * Reconcile input ownership with the surfaces that the current layout can show.
 *
 * Focus (keyboard ownership) and selection (row cursor) are separate. When the
 * selection's surface is not visible in this layout, the cursor falls back to
 * the focused surface — never to the active thread.
 */
export function projectShellPresentation(
  layout: ShellLayout,
  state: ShellInputState,
  selection?: ShellSelectionProjection,
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
  const selectionSurface =
    selection && availableSurfaces.includes(selection.surface) ? selection.surface : focus
  return {
    focus,
    selectedSurface: selectionSurface,
    selectedIndex: selectionSurface === selection?.surface ? (selection?.index ?? 0) : 0,
    leftDrawerOpen,
    rightDrawerOpen,
    availableSurfaces,
    inputState,
  }
}
