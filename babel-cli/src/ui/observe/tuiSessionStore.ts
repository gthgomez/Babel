/**
 * Atomic TUI session observation store.
 *
 * inspect tui reads latest.json first, then only assets for that frame_id.
 * latest.txt is the virtual cell grid — never a projector reconstruction.
 */

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs'
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
): TuiLatestPointer {
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
export function appendTerminalVisibleEvent(sessionDir: string, ev: TerminalWriteEvent): void {
  mkdirSync(sessionDir, { recursive: true })
  const line = `${JSON.stringify({ seq: ev.seq, stream: ev.stream, kind: ev.kind, bytes: ev.bytes, ts: ev.ts })}\n`
  writeFileSync(join(sessionDir, 'terminal-events.jsonl'), line, { flag: 'a', encoding: 'utf8' })
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
  const path = join(sessionDir, 'terminal-events.jsonl')
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as TerminalWriteEvent)
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
