import { FrameScheduler } from '../frameScheduler.js'
import { OutputBuffer } from '../outputBuffer.js'
import { suspendActiveRendererForExclusiveSurface } from '../rendererFence.js'
import { createShellFrameRenderer, type ShellFrameRenderer } from './shellFrameRenderer.js'
import { acquireShellInputLease } from './shellInputRouter.js'
import type { ShellFrameInput, ShellOutputPort } from './shellTypes.js'

export interface ShellHostScheduler {
  register(id: string, callback: () => void): () => void
  request(id: string): void
}

export interface ShellHostOptions {
  frameSource: () => ShellFrameInput
  frameRenderer?: ShellFrameRenderer
  output?: ShellOutputPort
  scheduler?: ShellHostScheduler
  componentId?: string
}

export interface ShellHost {
  readonly componentId: string
  readonly mounted: boolean
  readonly exclusiveDepth: number
  mount(): void
  invalidate(reason: string): void
  renderNow(): void
  /** Keep the next repaints from covering command output until the next key. */
  holdRepaint(): void
  /** Clear a repaint hold. Returns whether a hold was active. */
  releaseRepaintHold(): boolean
  withExclusiveTerminal<T>(reason: string, work: () => Promise<T>): Promise<T>
  dispose(): void
}

function defaultOutput(): ShellOutputPort {
  const output = OutputBuffer.getInstance()
  return {
    beginFrame: () => output.beginFrame(),
    endFrame: () => output.endFrame(),
    write: (text) => output.write(text),
    moveCursor: (row, col) => output.moveCursor(row, col),
    setCursorVisibility: (visible) => {
      if (visible) output.showCursor()
      else output.hideCursor()
    },
  }
}

function defaultScheduler(): ShellHostScheduler {
  const scheduler = FrameScheduler.getInstance()
  return {
    register: (id, callback) => scheduler.scheduleComponent(id, callback, { priority: 1, label: id }),
    request: (id) => scheduler.markComponentDirty(id),
  }
}

let nextHostId = 0

/**
 * Create the single root-owned North Star presentation host.
 *
 * Rendering is fed by an immutable frame source. Filesystem, provider, Git
 * and runtime mutations stay outside this host; exclusive leases suspend only
 * presentation/input ownership and never pause the engine's task clock.
 */
export function createShellHost(options: ShellHostOptions): ShellHost {
  const componentId = options.componentId ?? `north-star-shell-${++nextHostId}`
  const scheduler = options.scheduler ?? defaultScheduler()
  const output = options.output ?? defaultOutput()
  const frameRenderer = options.frameRenderer ?? createShellFrameRenderer(output)
  let mounted = false
  let disposed = false
  let exclusiveDepth = 0
  let dirty = false
  let repaintHeld = false
  let unregister: (() => void) | null = null

  const host: ShellHost = {
    componentId,
    get mounted() {
      return mounted
    },
    get exclusiveDepth() {
      return exclusiveDepth
    },
    mount() {
      if (mounted || disposed) return
      mounted = true
      unregister = scheduler.register(componentId, () => {
        if (!mounted || disposed || exclusiveDepth > 0 || repaintHeld || !dirty) return
        dirty = false
        host.renderNow()
      })
      host.invalidate('mount')
    },
    holdRepaint() {
      repaintHeld = true
      dirty = false
    },
    releaseRepaintHold() {
      const held = repaintHeld
      repaintHeld = false
      return held
    },
    invalidate(_reason) {
      if (repaintHeld) return
      if (!mounted || disposed || exclusiveDepth > 0) return
      if (dirty) return
      dirty = true
      scheduler.request(componentId)
    },
    renderNow() {
      if (!mounted || disposed || exclusiveDepth > 0) return
      try {
        frameRenderer.render(options.frameSource())
      } catch {
        // A failed write/source must not commit a stale frame. The renderer
        // itself only commits after endFrame succeeds; invalidate the cache
        // so the next valid frame is complete.
        frameRenderer.invalidate('render-failure')
        throw new Error('North Star shell frame render failed')
      }
    },
    async withExclusiveTerminal<T>(_reason: string, work: () => Promise<T>): Promise<T> {
      if (disposed) throw new Error('North Star shell host is disposed')
      exclusiveDepth += 1
      const releaseInputLease = acquireShellInputLease()
      const releaseRendererFence = suspendActiveRendererForExclusiveSurface()
      try {
        return await work()
      } finally {
        releaseInputLease()
        exclusiveDepth -= 1
        releaseRendererFence()
        if (exclusiveDepth === 0 && mounted && !disposed) {
          frameRenderer.invalidate('exclusive-return')
          dirty = true
          scheduler.request(componentId)
        }
      }
    },
    dispose() {
      if (disposed) return
      disposed = true
      mounted = false
      exclusiveDepth = 0
      unregister?.()
      unregister = null
      dirty = false
      frameRenderer.invalidate('dispose')
    },
  }

  return host
}
