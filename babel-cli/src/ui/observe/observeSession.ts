/**
 * Opt-in TUI observation host (BABEL_TUI_OBSERVE=1).
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { BABEL_RUNS_DIR } from '../../cli/constants.js'
import { setSessionEventObservationHook } from '../../agent/sessionEvents.js'
import { createObservationSemanticReducer } from './observationSemantic.js'
import {
  liveTerminalProfile,
  getTerminalTransport,
  installTerminalTransport,
  uninstallTerminalTransport,
  capabilityProfileId,
  type TerminalCapabilityProfile,
} from './terminalTransport.js'
import { appendTerminalVisibleEvent, persistTuiFrame, writeSessionsLatestPointer } from './tuiSessionStore.js'

/**
 * True when observation is requested.
 */
export function isTuiObserveEnabled(): boolean {
  const v = process.env['BABEL_TUI_OBSERVE']
  return v === '1' || v === 'true' || v === 'yes' || v === 'on'
}

/**
 * Start a TUI observation session if enabled.
 *
 * @param profile Optional capability/geometry override
 */
export function startTuiObservation(profile?: TerminalCapabilityProfile): string | null {
  if (!isTuiObserveEnabled()) return null
  const installed = getTerminalTransport()
  if (installed?.isInstalled()) {
    const sessionDir = tuiSessionDir(installed.sessionId)
    mkdirSync(sessionDir, { recursive: true })
    return sessionDir
  }
  const transport = installTerminalTransport(profile ?? liveTerminalProfile())
  const sessionsRoot = join(BABEL_RUNS_DIR, 'tui-sessions')
  const sessionDir = tuiSessionDir(transport.sessionId)
  mkdirSync(sessionDir, { recursive: true })
  const profileUsed = transport.getProfile()
  writeFileSync(
    join(sessionDir, 'profile.json'),
    `${JSON.stringify({ ...profileUsed, capabilityProfileId: capabilityProfileId(profileUsed) }, null, 2)}\n`,
    'utf8',
  )
  writeSessionsLatestPointer(sessionsRoot, sessionDir)
  transport.onChunk((ev) => {
    appendTerminalVisibleEvent(sessionDir, ev)
  })
  transport.onFlush((snap, marks) => {
    persistTuiFrame(sessionDir, snap, marks, transport.getSemantic())
  })
  let observedEventCount = 0
  let lastObservedEventId: string | null = null
  let semanticReducer = createObservationSemanticReducer()
  setSessionEventObservationHook((events) => {
    const previousEvent = observedEventCount > 0 ? events[observedEventCount - 1] : undefined
    if (events.length < observedEventCount || (previousEvent && previousEvent.event_id !== lastObservedEventId)) {
      observedEventCount = 0
      lastObservedEventId = null
      semanticReducer = createObservationSemanticReducer()
    }
    for (let index = observedEventCount; index < events.length; index += 1) {
      const event = events[index]
      if (!event) continue
      semanticReducer.apply(event)
      lastObservedEventId = event.event_id
    }
    observedEventCount = events.length
    getTerminalTransport()?.setSemantic(semanticReducer.current())
  })
  return sessionDir
}

/**
 * Write a pointer from a chat/interactive run dir to the observation session.
 *
 * @param runDir Chat or interactive run directory
 * @param sessionDir Observation session directory
 */
export function writeTuiSessionRef(runDir: string, sessionDir: string): void {
  mkdirSync(runDir, { recursive: true })
  writeFileSync(join(runDir, 'tui-session-ref.json'), `${JSON.stringify({ sessionDir }, null, 2)}\n`, 'utf8')
}

/** Stop wrapping stdout/stderr. */
export function stopTuiObservation(): void {
  setSessionEventObservationHook(null)
  uninstallTerminalTransport()
}

/** Directory for a live observation session. */
export function tuiSessionDir(sessionId: string): string {
  return join(BABEL_RUNS_DIR, 'tui-sessions', sessionId)
}
