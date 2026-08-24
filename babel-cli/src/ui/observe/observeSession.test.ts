import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'

const runsDir = mkdtempSync(join(tmpdir(), 'tui-observe-session-'))
const priorRunsDir = process.env['BABEL_RUNS_DIR']
const priorObserve = process.env['BABEL_TUI_OBSERVE']
process.env['BABEL_RUNS_DIR'] = runsDir
process.env['BABEL_TUI_OBSERVE'] = '1'

const { startTuiObservation, stopTuiObservation, tuiSessionDir, writeTuiSessionRef } = await import('./observeSession.js')
const { getTerminalTransport } = await import('./terminalTransport.js')

const PINNED = {
  geometry: { cols: 20, rows: 8 },
  terminal: 'minimal' as const,
  syncUpdate: false,
  scrollRegions: true,
  trueColor: true,
  emoji: true,
  pinGeometry: true,
}

describe('observeSession lifecycle', () => {
  it('returns one valid session directory across repeated startup and restores the transport on shutdown', () => {
    const firstRunDir = mkdtempSync(join(tmpdir(), 'tui-observe-ref-a-'))
    const secondRunDir = mkdtempSync(join(tmpdir(), 'tui-observe-ref-b-'))
    let wrappedStdoutWrite: typeof process.stdout.write | null = null
    let wrappedStderrWrite: typeof process.stderr.write | null = null

    try {
      const first = startTuiObservation(PINNED)
      assert.ok(first)
      assert.equal(isAbsolute(first), true)
      assert.equal(statSync(first).isDirectory(), true)
      wrappedStdoutWrite = process.stdout.write
      wrappedStderrWrite = process.stderr.write

      const installed = getTerminalTransport()
      assert.ok(installed)
      assert.equal(first, tuiSessionDir(installed.sessionId))

      writeTuiSessionRef(firstRunDir, first)
      assert.equal(JSON.parse(readFileSync(join(firstRunDir, 'tui-session-ref.json'), 'utf8')).sessionDir, first)

      const second = startTuiObservation(PINNED)
      assert.equal(second, first)
      assert.equal(getTerminalTransport(), installed)
      writeTuiSessionRef(secondRunDir, second!)
      assert.equal(JSON.parse(readFileSync(join(secondRunDir, 'tui-session-ref.json'), 'utf8')).sessionDir, first)
      assert.equal(existsSync(second), true)
    } finally {
      stopTuiObservation()
      assert.equal(getTerminalTransport(), null)
      assert.notEqual(process.stdout.write, wrappedStdoutWrite)
      assert.notEqual(process.stderr.write, wrappedStderrWrite)
      if (priorRunsDir === undefined) delete process.env['BABEL_RUNS_DIR']
      else process.env['BABEL_RUNS_DIR'] = priorRunsDir
      if (priorObserve === undefined) delete process.env['BABEL_TUI_OBSERVE']
      else process.env['BABEL_TUI_OBSERVE'] = priorObserve
    }
  })
})
