import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ScreenManager } from '../screenManager.js'
import { OutputBuffer } from '../outputBuffer.js'
import { getTerminalWidth } from '../theme.js'
import {
  DEFAULT_PROFILE,
  createTerminalTransport,
  getObservedTerminalSize,
  installTerminalTransport,
  peekInjectedTerminalSize,
  setObservedTerminalSize,
  uninstallTerminalTransport,
} from './terminalTransport.js'
import {
  persistTuiFrame,
  loadLatestTuiFrame,
  appendTerminalVisibleEvent,
  loadTerminalVisibleEvents,
  replayVisibleEvents,
} from './tuiSessionStore.js'
import { formatInspectTui } from './inspectTui.js'
import { reduceObservationSemantic } from './observationSemantic.js'
import type { SessionEvent } from '../../agent/sessionEvents.js'

const PINNED = {
  ...DEFAULT_PROFILE,
  geometry: { cols: 20, rows: 8 },
  pinGeometry: true,
}

describe('TerminalTransport', () => {
  it('does X when Y: visible CSI 2A/2K mutates the cell grid not stripAnsi concatenation', () => {
    const transport = createTerminalTransport(PINNED, 'tui-test-vt')
    try {
      transport.ingestVisible('Hello\nWorld\n')
      transport.ingestVisible('\x1b[2A')
      transport.ingestVisible('\x1b[2K')
      transport.ingestVisible('Goodbye')
      const snap = transport.getGrid().snapshot()
      assert.equal(snap.lines[0], 'Goodbye')
      assert.notEqual(snap.lines.join(''), 'HelloWorldGoodbye')
    } finally {
      setObservedTerminalSize(null)
    }
  })

  it('does X when Y: intent is recorded while buffering withholds visible cells', () => {
    const transport = installTerminalTransport(PINNED, 'tui-test-buf')
    try {
      transport.noteIntent('SECRET')
      transport.startBuffering()
      process.stdout.write('SECRET')
      const during = transport.getGrid().snapshot()
      assert.equal(during.lines.every((l) => !l.includes('SECRET')), true)
      const flushed = transport.stopBuffering()
      assert.equal(flushed, 'SECRET')
      process.stdout.write(flushed)
      const after = transport.getGrid().snapshot()
      assert.equal(after.lines[0]?.includes('SECRET'), true)
      const intent = transport.drainIntentLog()
      const visible = transport.drainVisibleLog()
      assert.ok(intent.some((e) => e.kind === 'intent' && e.bytes === 'SECRET'))
      assert.ok(visible.some((e) => e.kind === 'visible' && e.bytes === 'SECRET'))
    } finally {
      uninstallTerminalTransport()
    }
  })

  it('does X when Y: injected geometry is used by ScreenManager, OutputBuffer, and getTerminalWidth', () => {
    const transport = createTerminalTransport(
      { ...DEFAULT_PROFILE, geometry: { cols: 120, rows: 40 }, pinGeometry: true },
      'tui-test-geo',
    )
    try {
      assert.deepEqual(peekInjectedTerminalSize(), { cols: 120, rows: 40 })
      assert.deepEqual(getObservedTerminalSize(), { cols: 120, rows: 40 })
      assert.equal(getTerminalWidth(), 120)
      assert.deepEqual(OutputBuffer.getTerminalSize(), { cols: 120, rows: 40 })
      const sm = new ScreenManager({
        model: 'm',
        mode: 'chat',
        project: 'p',
        totalTokens: 0,
        totalCost: 0,
        turnCount: 0,
      })
      assert.ok(sm)
      assert.equal(transport.getGrid().getGeometry().cols, 120)
    } finally {
      setObservedTerminalSize(null)
    }
  })
})

describe('tuiSessionStore + inspect tui', () => {
  it('does X when Y: latest.txt is the cell grid and inspect omits CSI', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tui-obs-'))
    const transport = createTerminalTransport(PINNED, 'tui-test-persist')
    try {
      transport.ingestVisible('Hello\n')
      transport.ingestVisible('\x1b[1A')
      transport.ingestVisible('\x1b[2K')
      transport.ingestVisible('Visible')
      const { snap, marks } = transport.observeManual()
      persistTuiFrame(dir, snap, marks, null)
      const bundle = loadLatestTuiFrame(dir)
      assert.ok(bundle)
      assert.equal(bundle!.screen.lines[0], 'Visible')
      const txt = readFileSync(join(dir, 'latest.txt'), 'utf8')
      assert.equal(txt.includes('\x1b'), false)
      assert.match(txt, /Visible/)
      const rendered = formatInspectTui(dir, 'screen')
      assert.equal(rendered.includes('\x1b['), false)
      assert.match(rendered, /Visible/)
    } finally {
      setObservedTerminalSize(null)
    }
  })

  it('does X when Y: torn latest.json pointer is refused', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tui-obs-torn-'))
    const transport = createTerminalTransport(PINNED, 'tui-test-torn')
    try {
      transport.ingestVisible('A')
      const { snap, marks } = transport.observeManual()
      persistTuiFrame(dir, snap, marks, null)
      const pointerPath = join(dir, 'latest.json')
      const pointer = JSON.parse(readFileSync(pointerPath, 'utf8')) as { frameId: number; frame: string }
      pointer.frameId = pointer.frameId + 99
      writeFileSync(pointerPath, `${JSON.stringify(pointer, null, 2)}\n`)
      assert.equal(loadLatestTuiFrame(dir), null)
    } finally {
      setObservedTerminalSize(null)
    }
  })

  it('does X when Y: a session-events run without renderer bytes is semantic-only not a fake screen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tui-sem-'))
    const events: SessionEvent[] = [
      {
        schema_version: 1,
        session_id: 's',
        event_id: 'e1',
        ts: new Date().toISOString(),
        kind: 'user_submitted',
        turn_id: 't1',
        seq: 1,
        task_preview: 'x',
      } as SessionEvent,
    ]
    const semantic = reduceObservationSemantic(events)
    assert.equal(semantic.terminalStatus, 'in_progress')
    assert.equal(existsSync(join(dir, 'latest.json')), false)
    const out = formatInspectTui(dir, 'screen')
    assert.match(out, /SCREEN unavailable|No TUI observation/)
    assert.equal(out.includes('FRAME'), false)
  })

  it('does X when Y: same-geometry replay of terminal-events.jsonl reproduces the cell hash', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tui-replay-'))
    const transport = createTerminalTransport(PINNED, 'tui-test-replay')
    try {
      transport.onChunk((ev) => appendTerminalVisibleEvent(dir, ev))
      transport.ingestVisible('Hello\nWorld\n')
      transport.ingestVisible('\x1b[2A')
      transport.ingestVisible('\x1b[2K')
      transport.ingestVisible('Goodbye')
      const live = transport.getGrid().snapshot()
      const events = loadTerminalVisibleEvents(dir)
      assert.ok(events.length >= 4)
      const replayed = replayVisibleEvents(events, 20, 8)
      assert.equal(replayed.hash, live.hash)
      assert.equal(replayed.lines[0], 'Goodbye')
    } finally {
      setObservedTerminalSize(null)
    }
  })
})


