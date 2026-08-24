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
  enforceTuiSessionBudget,
  loadLatestTuiFrame,
  loadTerminalVisibleEvents,
  persistTuiFrame,
} from './tuiSessionStore.js'
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
})
