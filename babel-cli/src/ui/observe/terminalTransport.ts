/**
 * TerminalTransport — render-intent vs terminal-visible mux.
 *
 * Visible observations come from bytes actually released to stdout/stderr
 * after InputCoordinator buffering, not from OutputBuffer.writeRaw alone.
 */

import { createHash } from 'node:crypto'

import {
  createVirtualCellGrid,
  type GridSnapshot,
  type VirtualCellGrid,
} from './virtualCellGrid.js'
import type { ObservationSemanticState } from './observationSemantic.js'

export type ObserveTrigger = 'end_frame' | 'idle_flush' | 'resize' | 'manual_observe' | 'buffer_flush'

export interface TerminalCapabilityProfile {
  geometry: { cols: number; rows: number }
  terminal: 'windows-terminal' | 'xterm' | 'minimal'
  syncUpdate: boolean
  scrollRegions: boolean
  trueColor: boolean
  emoji: boolean
  /** When true, OS resize events do not change renderer geometry. */
  pinGeometry?: boolean
}

export interface ObservationWatermarks {
  frameId: number
  terminalWriteSeqStart: number
  terminalWriteSeqEnd: number
  semanticEventSeq: number
  turnId: string | null
  renderEpoch: number
  capabilityProfileId: string
  geometry: { cols: number; rows: number }
}

export interface TerminalWriteEvent {
  seq: number
  stream: 'stdout' | 'stderr'
  kind: 'intent' | 'visible'
  bytes: string
  ts: number
}

const DEFAULT_PROFILE: TerminalCapabilityProfile = {
  geometry: { cols: 120, rows: 40 },
  terminal: 'minimal',
  syncUpdate: false,
  scrollRegions: true,
  trueColor: true,
  emoji: true,
  pinGeometry: true,
}

let installed: TerminalTransport | null = null
let injectedSize: { cols: number; rows: number } | null = null

/**
 * Inject renderer geometry used by OutputBuffer/ScreenManager.
 *
 * @param size Columns and rows, or null to follow process.stdout
 */
export function setObservedTerminalSize(size: { cols: number; rows: number } | null): void {
  injectedSize = size
}

/**
 * Injected size only. Null means follow the real TTY.
 */
export function peekInjectedTerminalSize(): { cols: number; rows: number } | null {
  return injectedSize
}

/** Geometry the renderer should use. */
export function getObservedTerminalSize(): { cols: number; rows: number } {
  if (injectedSize) return injectedSize
  return {
    cols: process.stdout.columns ?? 88,
    rows: process.stdout.rows ?? 24,
  }
}

/**
 * Live observation profile: current TTY size, geometry not pinned.
 */
export function liveTerminalProfile(): TerminalCapabilityProfile {
  return {
    ...DEFAULT_PROFILE,
    geometry: {
      cols: process.stdout.columns ?? DEFAULT_PROFILE.geometry.cols,
      rows: process.stdout.rows ?? DEFAULT_PROFILE.geometry.rows,
    },
    pinGeometry: false,
  }
}

/**
 * Active transport, if observation is installed.
 */
export function getTerminalTransport(): TerminalTransport | null {
  return installed
}

export class TerminalTransport {
  private originalStdout: typeof process.stdout.write
  private originalStderr: typeof process.stderr.write
  private buffering = false
  private buffer: string[] = []
  private intentSeq = 0
  private visibleSeq = 0
  private semanticEventSeq = 0
  private renderEpoch = 0
  private frameId = 0
  private grid: VirtualCellGrid
  private profile: TerminalCapabilityProfile
  private intentLog: TerminalWriteEvent[] = []
  private visibleLog: TerminalWriteEvent[] = []
  readonly sessionId: string
  private lastSemantic: ObservationSemanticState | null = null
  private onVisibleFlush: ((snap: GridSnapshot, marks: ObservationWatermarks) => void) | null = null
  private onVisibleChunk: ((ev: TerminalWriteEvent) => void) | null = null
  private lastEmittedHash = ''
  private lastMarks: ObservationWatermarks | null = null
  private resizeListener: (() => void) | null = null

  constructor(profile: TerminalCapabilityProfile, sessionId: string) {
    this.profile = profile
    this.sessionId = sessionId
    this.grid = createVirtualCellGrid(profile.geometry.cols, profile.geometry.rows)
    this.originalStdout = process.stdout.write.bind(process.stdout)
    this.originalStderr = process.stderr.write.bind(process.stderr)
  }

  isInstalled(): boolean {
    return installed === this
  }

  isBuffering(): boolean {
    return this.buffering
  }

  getProfile(): TerminalCapabilityProfile {
    return this.profile
  }

  getGrid(): VirtualCellGrid {
    return this.grid
  }

  setSemantic(state: ObservationSemanticState): void {
    this.lastSemantic = state
    this.semanticEventSeq = state.semanticEventSeq
  }

  getSemantic(): ObservationSemanticState | null {
    return this.lastSemantic
  }

  onFlush(cb: (snap: GridSnapshot, marks: ObservationWatermarks) => void): void {
    this.onVisibleFlush = cb
  }

  /**
   * Called for every terminal-visible chunk (replay substrate).
   *
   * @param cb Chunk listener
   */
  onChunk(cb: (ev: TerminalWriteEvent) => void): void {
    this.onVisibleChunk = cb
  }

  noteIntent(bytes: string, stream: 'stdout' | 'stderr' = 'stdout'): void {
    if (!bytes) return
    this.intentSeq += 1
    this.intentLog.push({
      seq: this.intentSeq,
      stream,
      kind: 'intent',
      bytes,
      ts: Date.now(),
    })
  }

  startBuffering(): void {
    this.buffering = true
    this.buffer = []
  }

  stopBuffering(): string {
    this.buffering = false
    const flushed = this.buffer.join('')
    this.buffer = []
    // Caller writes `flushed` to stdout; the wrap then records visible bytes once.
    return flushed
  }

  install(): void {
    if (installed && installed !== this) installed.uninstall()
    const self = this
    process.stdout.write = function (chunk: unknown, encoding?: unknown, callback?: unknown): boolean {
      const str = chunkToString(chunk)
      if (self.buffering) {
        self.buffer.push(str)
        if (typeof callback === 'function') (callback as () => void)()
        return true
      }
      self.releaseVisible(str, 'stdout', 'idle_flush')
      if (typeof encoding === 'function') {
        return self.originalStdout(chunk as never, encoding as never)
      }
      return self.originalStdout(chunk as never, encoding as never, callback as never)
    } as typeof process.stdout.write

    process.stderr.write = function (chunk: unknown, encoding?: unknown, callback?: unknown): boolean {
      const str = chunkToString(chunk)
      if (self.buffering) {
        self.buffer.push(str)
        if (typeof callback === 'function') (callback as () => void)()
        return true
      }
      self.releaseVisible(str, 'stderr', 'idle_flush')
      if (typeof encoding === 'function') {
        return self.originalStderr(chunk as never, encoding as never)
      }
      return self.originalStderr(chunk as never, encoding as never, callback as never)
    } as typeof process.stderr.write

    if (!this.profile.pinGeometry) {
      this.resizeListener = () => {
        const cols = process.stdout.columns ?? this.profile.geometry.cols
        const rows = process.stdout.rows ?? this.profile.geometry.rows
        setObservedTerminalSize({ cols, rows })
        this.grid.resize(cols, rows)
        this.profile = { ...this.profile, geometry: { cols, rows } }
        this.emitFrame('resize')
      }
      process.stdout.on('resize', this.resizeListener)
    }

    installed = this
  }

  uninstall(): void {
    if (installed !== this) return
    if (this.resizeListener) {
      process.stdout.off('resize', this.resizeListener)
      this.resizeListener = null
    }
    process.stdout.write = this.originalStdout
    process.stderr.write = this.originalStderr
    installed = null
  }

  observeManual(): { snap: GridSnapshot; marks: ObservationWatermarks } {
    return this.emitFrame('manual_observe')
  }

  /**
   * Apply terminal-visible bytes without going through process.stdout.write.
   * Used by tests and by replay of recorded streams.
   *
   * @param bytes Visible UTF-8 chunk
   * @param stream stdout or stderr
   * @param trigger Frame trigger
   */
  ingestVisible(
    bytes: string,
    stream: 'stdout' | 'stderr' = 'stdout',
    trigger: ObserveTrigger = 'idle_flush',
  ): void {
    this.releaseVisible(bytes, stream, trigger)
  }

  private releaseVisible(str: string, stream: 'stdout' | 'stderr', trigger: ObserveTrigger): void {
    if (!str) return
    this.visibleSeq += 1
    const ev: TerminalWriteEvent = {
      seq: this.visibleSeq,
      stream,
      kind: 'visible',
      bytes: str,
      ts: Date.now(),
    }
    this.visibleLog.push(ev)
    this.onVisibleChunk?.(ev)
    const size = getObservedTerminalSize()
    const geo = this.grid.getGeometry()
    if (size.cols !== geo.cols || size.rows !== geo.rows) {
      this.grid.resize(size.cols, size.rows)
      this.profile = { ...this.profile, geometry: size }
    }
    this.grid.apply(str)
    this.emitFrame(trigger)
  }

  private emitFrame(trigger: ObserveTrigger): { snap: GridSnapshot; marks: ObservationWatermarks } {
    const snap = this.grid.snapshot()
    if (trigger === 'idle_flush' && snap.hash === this.lastEmittedHash && this.lastMarks) {
      return { snap, marks: this.lastMarks }
    }
    this.frameId += 1
    this.renderEpoch += 1
    const marks: ObservationWatermarks = {
      frameId: this.frameId,
      terminalWriteSeqStart: this.visibleSeq,
      terminalWriteSeqEnd: this.visibleSeq,
      semanticEventSeq: this.semanticEventSeq,
      turnId: this.lastSemantic?.turnId ?? null,
      renderEpoch: this.renderEpoch,
      capabilityProfileId: capabilityProfileId(this.profile),
      geometry: { cols: snap.cols, rows: snap.rows },
    }
    this.lastEmittedHash = snap.hash
    this.lastMarks = marks
    this.onVisibleFlush?.(snap, marks)
    return { snap, marks }
  }

  drainIntentLog(): TerminalWriteEvent[] {
    const copy = this.intentLog
    this.intentLog = []
    return copy
  }

  drainVisibleLog(): TerminalWriteEvent[] {
    const copy = this.visibleLog
    this.visibleLog = []
    return copy
  }
}

/**
 * Create a transport and inject renderer geometry without wrapping stdout.
 *
 * @param profile Capability + geometry the renderer must use
 * @param sessionId TUI session id
 */
export function createTerminalTransport(
  profile: TerminalCapabilityProfile = DEFAULT_PROFILE,
  sessionId = `tui-${Date.now().toString(16)}`,
): TerminalTransport {
  setObservedTerminalSize(profile.geometry)
  return new TerminalTransport(profile, sessionId)
}

/**
 * Install observation wrapping stdout/stderr.
 *
 * @param profile Capability + geometry the renderer must use
 * @param sessionId TUI session id
 */
export function installTerminalTransport(
  profile: TerminalCapabilityProfile = DEFAULT_PROFILE,
  sessionId = `tui-${Date.now().toString(16)}`,
): TerminalTransport {
  const transport = createTerminalTransport(profile, sessionId)
  transport.install()
  return transport
}

/** Remove the process.write wrap. */
export function uninstallTerminalTransport(): void {
  installed?.uninstall()
  setObservedTerminalSize(null)
}

/**
 * Stable id for a capability/geometry profile.
 *
 * @param profile Terminal capability profile
 */
export function capabilityProfileId(profile: TerminalCapabilityProfile): string {
  return createHash('sha256')
    .update(JSON.stringify(profile))
    .digest('hex')
    .slice(0, 12)
}

function chunkToString(chunk: unknown): string {
  if (typeof chunk === 'string') return chunk
  if (Buffer.isBuffer(chunk)) return chunk.toString('utf8')
  return String(chunk ?? '')
}

export { DEFAULT_PROFILE }
