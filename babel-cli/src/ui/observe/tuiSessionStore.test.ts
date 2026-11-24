import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { emptyObservationSemantic } from './observationSemantic.js'
import { DEFAULT_PROFILE, createTerminalTransport, setObservedTerminalSize } from './terminalTransport.js'
import {
  BYTE_BUDGET,
  appendTerminalVisibleEvent,
  appendTuiLifecycleEvent,
  enforceTuiSessionBudget,
  loadLatestTuiFrame,
  loadTerminalVisibleEvents,
  loadTuiLifecycleEvents,
  persistTuiFrame,
  type TuiLatestPointer,
} from './tuiSessionStore.js'
import { formatInspectTui } from './inspectTui.js'
import type { TerminalWriteEvent } from './terminalTransport.js'

const PINNED = {
  ...DEFAULT_PROFILE,
  geometry: { cols: 40, rows: 10 },
  pinGeometry: true,
}

function sessionBytes(sessionDir: string): number {
  let total = 0
  for (const entry of readdirSync(sessionDir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      for (const frame of readdirSync(join(sessionDir, entry.name), { withFileTypes: true })) {
        if (frame.isFile()) total += statSync(join(sessionDir, entry.name, frame.name)).size
      }
    } else if (entry.isFile()) {
      total += statSync(join(sessionDir, entry.name)).size
    }
  }
  return total
}

function frameFiles(sessionDir: string): string[] {
  const framesDir = join(sessionDir, 'frames')
  return existsSync(framesDir) ? readdirSync(framesDir).sort() : []
}

function persistNextFrame(
  sessionDir: string,
  transport: ReturnType<typeof createTerminalTransport>,
  text: string,
  byteBudget: number,
): number {
  transport.ingestVisible(text)
  const { snap, marks } = transport.observeManual()
  persistTuiFrame(sessionDir, snap, marks, emptyObservationSemantic(), { byteBudget })
  return marks.frameId
}

function event(seq: number): TerminalWriteEvent {
  return {
    seq,
    stream: 'stdout',
    kind: 'visible',
    bytes: `event-${seq}`,
    ts: seq,
  }
}

describe('tuiSessionStore retention', () => {
  it('keeps a complete newest frame and metadata below the production budget', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tui-retention-under-'))
    const transport = createTerminalTransport(PINNED, 'tui-retention-under')
    try {
      writeFileSync(join(dir, 'profile.json'), '{}\n')
      const frameId = persistNextFrame(dir, transport, 'below-budget\n', BYTE_BUDGET)
      const latest = loadLatestTuiFrame(dir)
      assert.ok(latest)
      assert.equal(latest!.watermarks.frameId, frameId)
      assert.equal(existsSync(join(dir, 'profile.json')), true)
      assert.ok(sessionBytes(dir) <= BYTE_BUDGET)
    } finally {
      setObservedTerminalSize(null)
    }
  })

  it('prunes oldest frame pairs while keeping the newest pointer readable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tui-retention-frames-'))
    const transport = createTerminalTransport(PINNED, 'tui-retention-frames')
    const byteBudget = 4096
    try {
      writeFileSync(join(dir, 'profile.json'), '{}\n')
      const frameIds: number[] = []
      for (let i = 0; i < 8; i += 1) {
        frameIds.push(persistNextFrame(dir, transport, `${String(i).repeat(120)}\n`, byteBudget))
        const latest = loadLatestTuiFrame(dir)
        assert.ok(latest)
        assert.equal(latest!.watermarks.frameId, frameIds.at(-1))
        assert.equal(existsSync(join(dir, latest!.artifacts[0]!.path)), true)
      }

      const retained = frameFiles(dir)
      assert.ok(retained.length < frameIds.length * 2)
      assert.ok(retained.some((name) => name.startsWith(String(frameIds.at(-1)).padStart(8, '0'))))
      assert.equal(existsSync(join(dir, 'profile.json')), true)
    } finally {
      setObservedTerminalSize(null)
    }
  })

  it('keeps the event log parseable and deterministic after crossing its retention budget', () => {
    const firstDir = mkdtempSync(join(tmpdir(), 'tui-retention-events-a-'))
    const secondDir = mkdtempSync(join(tmpdir(), 'tui-retention-events-b-'))
    const byteBudget = 2048
    const writeEvents = (dir: string): void => {
      for (let seq = 1; seq <= 120; seq += 1) {
        appendTerminalVisibleEvent(dir, event(seq), { byteBudget })
      }
      enforceTuiSessionBudget(dir, byteBudget)
    }

    writeEvents(firstDir)
    writeEvents(secondDir)

    const first = loadTerminalVisibleEvents(firstDir)
    const second = loadTerminalVisibleEvents(secondDir)
    assert.ok(first.length > 0)
    assert.deepEqual(second, first)
    assert.ok(first.every((item, index) => index === 0 || item.seq > first[index - 1]!.seq))
    assert.ok(statSync(join(firstDir, 'terminal-events.jsonl')).size <= byteBudget / 4)
    assert.equal(readFileSync(join(firstDir, 'terminal-events.jsonl'), 'utf8').endsWith('\n'), true)
  })

  it('bounds combined frame and event artifacts without dangling the latest pointer', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tui-retention-combined-'))
    const transport = createTerminalTransport(PINNED, 'tui-retention-combined')
    const byteBudget = 16 * 1024
    try {
      writeFileSync(join(dir, 'profile.json'), '{}\n')
      for (let i = 0; i < 24; i += 1) {
        persistNextFrame(dir, transport, `${String(i).repeat(300)}\n`, byteBudget)
        appendTerminalVisibleEvent(dir, event(i + 1), { byteBudget })
      }

      const latest = loadLatestTuiFrame(dir)
      assert.ok(latest)
      assert.ok(existsSync(join(dir, latest!.artifacts[0]!.path)))
      assert.ok(sessionBytes(dir) <= byteBudget)
      assert.ok(loadTerminalVisibleEvents(dir).length > 0)
    } finally {
      setObservedTerminalSize(null)
    }
  })

  it('bounds lifecycle-events.jsonl alongside terminal-events without starving terminal replay log', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tui-retention-lifecycle-'))
    const byteBudget = 4096
    try {
      writeFileSync(join(dir, 'profile.json'), '{}\n')
      // Append a large volume of lifecycle events and terminal events
      for (let i = 1; i <= 80; i += 1) {
        appendTerminalVisibleEvent(dir, event(i), { byteBudget })
        appendTuiLifecycleEvent(
          dir,
          {
            seq: i,
            kind: 'policy_intervened',
            turn_id: `turn-${i}`,
            detail: { rule: 'read_only_audit', action: 'blocked', payload: 'x'.repeat(100) },
          },
          { byteBudget },
        )
      }

      const terminalEvents = loadTerminalVisibleEvents(dir)
      const lifecycleEvents = loadTuiLifecycleEvents(dir)

      assert.ok(terminalEvents.length > 0, 'terminal events must not be starved')
      assert.ok(lifecycleEvents.length > 0, 'lifecycle events must be retained')
      assert.ok(sessionBytes(dir) <= byteBudget, `session bytes (${sessionBytes(dir)}) must not exceed budget (${byteBudget})`)

      // Lifecycle event records preserve seq, kind, turn_id, and detail payload
      const lastLifecycle = lifecycleEvents.at(-1)
      assert.ok(lastLifecycle)
      assert.equal(lastLifecycle!.kind, 'policy_intervened')
      assert.equal(lastLifecycle!.turn_id, 'turn-80')
      assert.equal(lastLifecycle!.detail['rule'], 'read_only_audit')
    } finally {
      // cleanup handled by tmpdir
    }
  })

  it('persists a separate visual digest for style-only frames and keeps the text screen hash', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tui-style-digest-'))
    const transport = createTerminalTransport(PINNED, 'tui-style-digest')
    try {
      transport.ingestVisible('OK')
      const first = transport.observeManual()
      persistTuiFrame(dir, first.snap, first.marks, null)
      const firstPointer = JSON.parse(
        readFileSync(join(dir, 'latest.json'), 'utf8'),
      ) as TuiLatestPointer

      transport.ingestVisible('\x1b[1;1H\x1b[1mOK')
      const second = transport.observeManual()
      persistTuiFrame(dir, second.snap, second.marks, null)
      const secondPointer = JSON.parse(
        readFileSync(join(dir, 'latest.json'), 'utf8'),
      ) as TuiLatestPointer

      assert.notEqual(second.marks.frameId, first.marks.frameId)
      assert.equal(second.snap.textHash, first.snap.textHash)
      assert.notEqual(second.snap.visualHash, first.snap.visualHash)
      // Historical screen hash stays text-only; the visual digest is additive.
      assert.equal(secondPointer.hashes.screen, firstPointer.hashes.screen)
      assert.equal(secondPointer.hashes.visual, second.snap.visualHash)
      assert.notEqual(secondPointer.hashes.visual, firstPointer.hashes.visual)

      const latest = loadLatestTuiFrame(dir)
      assert.ok(latest)
      assert.equal(latest!.artifacts[0]!.hash, secondPointer.hashes.screen)
      assert.equal(latest!.screen.visualHash, second.snap.visualHash)
      assert.ok((latest!.screen.styleRuns ?? []).length > 0)
      assert.match(
        formatInspectTui(dir, 'screen'),
        new RegExp(`VISUAL_HASH ${second.snap.visualHash}`),
      )
      assert.equal(frameFiles(dir).length, 4)
    } finally {
      setObservedTerminalSize(null)
    }
  })

  it('loads a legacy latest pointer that has no separate visual digest', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tui-pointer-legacy-'))
    const transport = createTerminalTransport(PINNED, 'tui-pointer-legacy')
    try {
      transport.ingestVisible('Legacy pointer')
      const { snap, marks } = transport.observeManual()
      persistTuiFrame(dir, snap, marks, null)

      const pointerPath = join(dir, 'latest.json')
      const pointer = JSON.parse(readFileSync(pointerPath, 'utf8')) as {
        hashes: Record<string, string>
      }
      delete pointer.hashes['visual']
      writeFileSync(pointerPath, `${JSON.stringify(pointer, null, 2)}\n`)

      const loaded = loadLatestTuiFrame(dir)
      assert.ok(loaded)
      assert.equal(loaded!.screen.visualHash, snap.visualHash)
    } finally {
      setObservedTerminalSize(null)
    }
  })

  it('rejects modified frame bytes even when the frame id still matches', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tui-tampered-frame-'))
    const transport = createTerminalTransport(PINNED, 'tui-tampered-frame')
    try {
      transport.ingestVisible('Original')
      const { snap, marks } = transport.observeManual()
      const pointer = persistTuiFrame(dir, snap, marks, null)
      assert.ok(loadLatestTuiFrame(dir))
      const path = join(dir, pointer.frame)
      writeFileSync(path, readFileSync(path, 'utf8').replace('Original', 'Modified'))
      assert.equal(loadLatestTuiFrame(dir), null)
    } finally {
      setObservedTerminalSize(null)
    }
  })
})
