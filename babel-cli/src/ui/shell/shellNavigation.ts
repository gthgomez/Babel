import type { ShellFocus } from './shellInputRouter.js'

/**
 * Pure navigation model for the hosted North Star shell.
 *
 * The selected row is a **view cursor** only. It is deliberately independent of
 * `ShellRuntimeBinding.store.threadId` (the active thread authority). Merely
 * moving the cursor never changes the active thread; only an activation that
 * resolves to a real operation (for example `session.resume`) may do so, and
 * that happens through `shellOperations.ts` — not here.
 *
 * This module performs no I/O so it is testable without a terminal.
 */

/** One selectable row inside a focusable surface. */
export interface ShellNavigationRow {
  readonly id: string
  readonly label: string
  /**
   * The real operation this row performs. Rows without a command are
   * informational and resolve to a labelled no-op.
   */
  readonly command?: ShellCommand
}

/** A real controller operation requested by an activation. */
export type ShellCommand =
  | { readonly kind: 'session.resume'; readonly id: string }
  | { readonly kind: 'session.new' }
  | { readonly kind: 'target.set'; readonly root: string }
  | { readonly kind: 'project.toggle'; readonly root: string }
  | { readonly kind: 'action.run'; readonly command: string }
  | { readonly kind: 'mode.set'; readonly mode: string }
  | { readonly kind: 'model.set'; readonly model: string }
  | { readonly kind: 'inspector.toggle'; readonly key: string }
  | { readonly kind: 'none'; readonly reason: string }

/** Which row cursor is represented. */
export interface ShellSelectionState {
  readonly surface: ShellFocus
  readonly index: number
}

export function initialShellSelection(): ShellSelectionState {
  return { surface: 'composer', index: 0 }
}

function clamp(index: number, rowCount: number): number {
  const max = Math.max(0, rowCount - 1)
  if (index < 0) return 0
  if (index > max) return max
  return index
}

function moveDelta(keyName: string, index: number, rowCount: number): number {
  switch (keyName) {
    case 'up':
      return index - 1
    case 'down':
      return index + 1
    case 'home':
      return 0
    case 'end':
      return rowCount - 1
    case 'pageup':
      return index - 10
    case 'pagedown':
      return index + 10
    default:
      return index
  }
}

/**
 * Resolve the next cursor for a move key within a focused surface.
 * Pure: it returns a new selection and touches no other state.
 */
export function moveShellSelection(
  current: ShellSelectionState,
  surface: ShellFocus,
  keyName: string,
  rowCount: number,
): ShellSelectionState {
  const sameSurface = current.surface === surface
  const baseIndex = sameSurface ? current.index : 0
  return { surface, index: clamp(moveDelta(keyName, baseIndex, rowCount), rowCount) }
}

/** Resolve the real command for the selected row of a surface. */
export function resolveShellActivation(
  surface: ShellFocus,
  index: number,
  rows: readonly ShellNavigationRow[],
): ShellCommand {
  if (rows.length === 0) {
    return { kind: 'none', reason: `no selectable ${surface} rows` }
  }
  const row = rows[clamp(index, rows.length)]
  if (!row || !row.command) {
    return { kind: 'none', reason: `row "${row?.id ?? index}" has no action` }
  }
  return row.command
}

/**
 * Per-surface row cursor and row collection for the hosted shell.
 *
 * `setRows` is called when a real source projection changes; `move` and
 * `activate` are called from the key handler. Focus is tracked per surface so
 * moving away and back does not silently reset the user's cursor.
 */
export class ShellNavigator {
  private readonly rowsBySurface = new Map<ShellFocus, readonly ShellNavigationRow[]>()
  private readonly indexBySurface = new Map<ShellFocus, number>()
  private activeSurface: ShellFocus = 'composer'

  setRows(surface: ShellFocus, rows: readonly ShellNavigationRow[]): void {
    this.rowsBySurface.set(surface, rows)
    this.indexBySurface.set(surface, clamp(this.indexBySurface.get(surface) ?? 0, rows.length))
  }

  getRows(surface: ShellFocus): readonly ShellNavigationRow[] {
    return this.rowsBySurface.get(surface) ?? []
  }

  getSelection(): ShellSelectionState {
    return {
      surface: this.activeSurface,
      index: this.indexBySurface.get(this.activeSurface) ?? 0,
    }
  }

  /** Track keyboard focus; does not change the active thread. */
  setFocus(surface: ShellFocus): void {
    this.activeSurface = surface
  }

  /** Move the cursor within `surface`; returns the new selection. */
  move(surface: ShellFocus, keyName: string): ShellSelectionState {
    this.activeSurface = surface
    const rows = this.getRows(surface)
    const next = moveShellSelection(this.getSelection(), surface, keyName, rows.length)
    this.indexBySurface.set(surface, next.index)
    return next
  }

  /** Resolve the selected row of `surface` to a real command. */
  activate(surface: ShellFocus): ShellCommand {
    this.activeSurface = surface
    return resolveShellActivation(surface, this.indexBySurface.get(surface) ?? 0, this.getRows(surface))
  }
}
