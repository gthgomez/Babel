/** A zero-based, half-open terminal rectangle. */
export interface Rect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** Terminal dimensions used by the pure shell planner. */
export interface ShellDimensions {
  readonly cols: number
  readonly rows: number
  readonly effectiveCols?: number
}

/** Responsive shell mode selected from effective terminal dimensions. */
export type ShellMode = 'wide' | 'medium' | 'narrow' | 'linear'

/** Pure geometry returned by the responsive shell planner. */
export interface ShellLayout {
  readonly mode: ShellMode
  readonly cols: number
  readonly rows: number
  readonly effectiveCols: number
  readonly header: Rect | null
  readonly left: Rect | null
  readonly center: Rect | null
  readonly right: Rect | null
  readonly conversation: Rect | null
  readonly conversationText: Rect | null
  readonly composer: Rect | null
  readonly footer: Rect | null
}

/** A trusted or sanitized row provider for one root-owned surface. */
export interface ShellSurface {
  readonly id: string
  readonly rect: Rect
  readonly rows: readonly string[]
  readonly background?: string
}

/** A root-owned line or divider drawn above surfaces. */
export interface ShellRule {
  readonly orientation: 'horizontal' | 'vertical'
  readonly position: number
  readonly start?: number
  readonly end?: number
  readonly char: string
}

/** A prompt cursor expressed in zero-based frame coordinates. */
export interface LocalCursor {
  readonly row: number
  readonly col: number
  readonly visible: boolean
}

/** Immutable input captured for one complete root frame. */
export interface ShellFrameInput {
  readonly cols: number
  readonly rows: number
  readonly background: string
  readonly surfaces: readonly ShellSurface[]
  readonly rules?: readonly ShellRule[]
  readonly cursor?: LocalCursor | null
  readonly cacheKey?: string
}

/** Capability-independent output operations needed by the root renderer. */
export interface ShellOutputPort {
  readonly beginFrame: () => void
  readonly endFrame: () => void
  readonly write: (text: string) => void
  readonly moveCursor: (row: number, col: number) => void
}
