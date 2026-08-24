/**
 * Atomic TUI session observation store.
 *
 * inspect tui reads latest.json first, then only assets for that frame_id.
 * latest.txt is the virtual cell grid — never a projector reconstruction.
 */

import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

import { createVirtualCellGrid, type GridSnapshot } from './virtualCellGrid.js'
import type { ObservationSemanticState } from './observationSemantic.js'
import type { ObservationWatermarks, TerminalWriteEvent } from './terminalTransport.js'

export const TUI_OBSERVE_SCHEMA = 1 as const

export type TuiObservationArtifact =
  | { kind: 'cell_grid'; path: string; hash: string }
  | { kind: 'screenshot'; path: string; hash: string }

export interface TuiFrameBundle {
  schemaVersion: typeof TUI_OBSERVE_SCHEMA
  watermarks: ObservationWatermarks
  screen: {
    lines: string[]
    cursorCol: number
    cursorRow: number
    cursorVisible: boolean
    hash: string
    changedRows: number[]
  }
  semantic: ObservationSemanticState | null
  artifacts: TuiObservationArtifact[]
}

export interface TuiLatestPointer {
  schemaVersion: typeof TUI_OBSERVE_SCHEMA
  frameId: number
  screen: string
  frame: string
  hashes: { screen: string; frame: string }
}

export const BYTE_BUDGET = 8 * 1024 * 1024
const EVENT_LOG_BUDGET_FRACTION = 0.25
const TERMINAL_EVENTS_FILENAME = 'terminal-events.jsonl'

export interface TuiRetentionOptions {
  /** Override the production budget for deterministic tests. */
  byteBudget?: number
}

/**
 * Persist one immutable frame and swing latest.json atomically.
 *
 * @param sessionDir tui-sessions/<id>
 */
export function persistTuiFrame(
  sessionDir: string,
  snap: GridSnapshot,
  watermarks: ObservationWatermarks,
  semantic: ObservationSemanticState | null,
  options: TuiRetentionOptions = {},
): TuiLatestPointer {
  const byteBudget = resolveByteBudget(options.byteBudget)
  const framesDir = join(sessionDir, 'frames')
  mkdirSync(framesDir, { recursive: true })
  const id = String(watermarks.frameId).padStart(8, '0')
  const txtRel = `frames/${id}.txt`
  const jsonRel = `frames/${id}.json`
  const txtPath = join(sessionDir, txtRel)
  const jsonPath = join(sessionDir, jsonRel)
  const text = snap.lines.join('\n')
  const screenHash = createHash('sha256').update(text).digest('hex')
  const bundle: TuiFrameBundle = {
    schemaVersion: TUI_OBSERVE_SCHEMA,
    watermarks,
    screen: {
      lines: snap.lines,
      cursorCol: snap.cursorCol,
      cursorRow: snap.cursorRow,
      cursorVisible: snap.cursorVisible,
      hash: snap.hash,
      changedRows: snap.changedRows,
    },
    semantic,
    artifacts: [{ kind: 'cell_grid', path: txtRel, hash: screenHash }],
  }
  const json = `${JSON.stringify(bundle, null, 2)}\n`
  atomicWriteText(txtPath, `${text}\n`)
  atomicWriteText(jsonPath, json)
  atomicWriteText(join(sessionDir, 'latest.txt'), `${text}\n`)
  if (semantic) {
    atomicWriteText(join(sessionDir, 'latest.semantic.json'), `${JSON.stringify(semantic, null, 2)}\n`)
  }
  const pointer: TuiLatestPointer = {
    schemaVersion: TUI_OBSERVE_SCHEMA,
    frameId: watermarks.frameId,
    screen: txtRel,
    frame: jsonRel,
    hashes: {
      screen: screenHash,
      frame: createHash('sha256').update(json).digest('hex'),
    },
  }
  atomicWriteJson(join(sessionDir, 'latest.json'), pointer)
  enforceTuiSessionBudget(sessionDir, byteBudget)
  return pointer
}

/**
 * Read the latest complete frame bundle via the atomic pointer.
 *
 * @param sessionDir tui-sessions/<id>
 */
export function loadLatestTuiFrame(sessionDir: string): TuiFrameBundle | null {
  const pointerPath = join(sessionDir, 'latest.json')
  if (!existsSync(pointerPath)) return null
  const pointer = JSON.parse(readFileSync(pointerPath, 'utf8')) as TuiLatestPointer
  const framePath = join(sessionDir, pointer.frame)
  if (!existsSync(framePath)) return null
  const bundle = JSON.parse(readFileSync(framePath, 'utf8')) as TuiFrameBundle
  if (bundle.watermarks.frameId !== pointer.frameId) return null
  return bundle
}

/**
 * Point tui-sessions/latest.json at the current session directory.
 *
 * @param sessionsRoot BABEL_RUNS_DIR/tui-sessions
 * @param sessionDir Absolute session directory
 */
export function writeSessionsLatestPointer(sessionsRoot: string, sessionDir: string): void {
  mkdirSync(sessionsRoot, { recursive: true })
  atomicWriteJson(join(sessionsRoot, 'latest.json'), { sessionDir })
}

/**
 * Resolve the last observation session directory.
 *
 * @param sessionsRoot BABEL_RUNS_DIR/tui-sessions
 */
export function loadSessionsLatestPointer(sessionsRoot: string): string | null {
  const path = join(sessionsRoot, 'latest.json')
  if (!existsSync(path)) return null
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as { sessionDir?: string }
  if (!parsed.sessionDir || !existsSync(parsed.sessionDir)) return null
  return parsed.sessionDir
}

/**
 * Append one visible chunk to terminal-events.jsonl (same-geometry replay).
 *
 * @param sessionDir Observation session directory
 * @param ev Visible write
 */
export function appendTerminalVisibleEvent(
  sessionDir: string,
  ev: TerminalWriteEvent,
  options: TuiRetentionOptions = {},
): void {
  mkdirSync(sessionDir, { recursive: true })
  const line = `${JSON.stringify({ seq: ev.seq, stream: ev.stream, kind: ev.kind, bytes: ev.bytes, ts: ev.ts })}\n`
  writeFileSync(join(sessionDir, TERMINAL_EVENTS_FILENAME), line, { flag: 'a', encoding: 'utf8' })
  enforceTuiSessionBudget(sessionDir, resolveByteBudget(options.byteBudget))
}

/**
 * Replay recorded visible bytes at the original geometry.
 * Cross-width replay is not a success criterion.
 *
 * @param events Visible chunks in order
 * @param cols Original column count
 * @param rows Original row count
 */
export function replayVisibleEvents(
  events: readonly Pick<TerminalWriteEvent, 'bytes'>[],
  cols: number,
  rows: number,
): GridSnapshot {
  const grid = createVirtualCellGrid(cols, rows)
  for (const ev of events) grid.apply(ev.bytes)
  return grid.snapshot()
}

/**
 * Load terminal-events.jsonl if present.
 *
 * @param sessionDir Observation session directory
 */
export function loadTerminalVisibleEvents(sessionDir: string): TerminalWriteEvent[] {
  const path = join(sessionDir, TERMINAL_EVENTS_FILENAME)
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as TerminalWriteEvent)
}

/**
 * Enforce the deterministic per-session observation retention policy.
 *
 * The byte budget covers session metadata, the replay log, and immutable frame
 * files. The newest frame and its pointer are always retained. The replay log
 * receives at most one quarter of the budget; older complete frame pairs are
 * then pruned oldest-first. If the newest frame plus required metadata alone
 * exceeds the budget, that minimum usable state is retained.
 *
 * @param sessionDir tui-sessions/<id>
 * @param byteBudget Maximum session artifact budget
 */
export function enforceTuiSessionBudget(sessionDir: string, byteBudget = BYTE_BUDGET): void {
  const budget = resolveByteBudget(byteBudget)
  const eventPath = join(sessionDir, TERMINAL_EVENTS_FILENAME)
  compactEventLog(eventPath, Math.floor(budget * EVENT_LOG_BUDGET_FRACTION))

  const latestFrameId = readLatestFrameId(sessionDir)
  if (latestFrameId !== null) {
    pruneOldFrames(sessionDir, latestFrameId, budget)
  }

  const nonEventBytes = getSessionBytes(sessionDir, false)
  compactEventLog(eventPath, Math.max(0, budget - nonEventBytes))
}

function atomicWriteJson(path: string, value: unknown): void {
  atomicWriteText(path, `${JSON.stringify(value, null, 2)}\n`)
}

function atomicWriteText(path: string, text: string): void {
  const tmp = `${path}.${process.pid}.tmp`
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, path)
}

interface FrameRecord {
  id: number
  paths: string[]
}

function resolveByteBudget(byteBudget: number | undefined): number {
  const resolved = byteBudget ?? BYTE_BUDGET
  if (!Number.isInteger(resolved) || resolved <= 0) {
    throw new RangeError(`TUI observation byte budget must be a positive integer: ${resolved}`)
  }
  return resolved
}

function readLatestFrameId(sessionDir: string): number | null {
  const path = join(sessionDir, 'latest.json')
  if (!existsSync(path)) return null
  try {
    const pointer = JSON.parse(readFileSync(path, 'utf8')) as Partial<TuiLatestPointer>
    return typeof pointer.frameId === 'number' && Number.isInteger(pointer.frameId) ? pointer.frameId : null
  } catch {
    return null
  }
}

function pruneOldFrames(sessionDir: string, latestFrameId: number, byteBudget: number): void {
  let totalBytes = getSessionBytes(sessionDir, true)
  if (totalBytes <= byteBudget) return

  const framesDir = join(sessionDir, 'frames')
  if (!existsSync(framesDir)) return
  const frames = listFrameRecords(framesDir)
  for (const frame of frames) {
    if (totalBytes <= byteBudget) return
    if (frame.id === latestFrameId) continue
    for (const path of frame.paths) {
      const size = fileBytes(path)
      unlinkSync(path)
      totalBytes -= size
    }
  }
}

function listFrameRecords(framesDir: string): FrameRecord[] {
  const byId = new Map<number, string[]>()
  for (const entry of readdirSync(framesDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue
    const match = /^(\d+)\.(?:json|txt)$/.exec(entry.name)
    if (!match) continue
    const id = Number(match[1])
    const paths = byId.get(id) ?? []
    paths.push(join(framesDir, entry.name))
    byId.set(id, paths)
  }
  return [...byId.entries()]
    .map(([id, paths]) => ({ id, paths: paths.sort() }))
    .sort((a, b) => a.id - b.id)
}

function compactEventLog(path: string, maxBytes: number): void {
  if (!existsSync(path)) return
  const source = readFileSync(path, 'utf8')
  if (Buffer.byteLength(source, 'utf8') <= maxBytes) return
  if (maxBytes <= 0) {
    atomicWriteText(path, '')
    return
  }

  const lines = source
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => `${line}\n`)
  const retained: string[] = []
  let retainedBytes = 0
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!
    const lineBytes = Buffer.byteLength(line, 'utf8')
    if (retainedBytes + lineBytes > maxBytes) break
    retained.unshift(line)
    retainedBytes += lineBytes
  }
  atomicWriteText(path, retained.join(''))
}

function getSessionBytes(sessionDir: string, includeEventLog: boolean): number {
  if (!existsSync(sessionDir)) return 0
  let total = 0
  for (const entry of readdirSync(sessionDir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name !== 'frames') continue
      const framesDir = join(sessionDir, entry.name)
      for (const frame of readdirSync(framesDir, { withFileTypes: true })) {
        if (frame.isFile()) total += fileBytes(join(framesDir, frame.name))
      }
      continue
    }
    if (entry.isFile() && (includeEventLog || entry.name !== TERMINAL_EVENTS_FILENAME)) {
      total += fileBytes(join(sessionDir, entry.name))
    }
  }
  return total
}

function fileBytes(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}
