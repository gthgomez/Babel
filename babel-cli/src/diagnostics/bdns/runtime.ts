/** Session-owned BDNS wiring for canonical, process, workspace, and storage planes. */

import { join } from 'node:path'
import {
  flushSessionEventObservations,
  subscribeSessionEventObservation,
  type SessionEvent,
} from '../../agent/sessionEvents.js'
import { BdnsDiagnostics } from './diagnostics.js'
import { BdnsDiagnosticStore } from './diagnosticStore.js'
import { getDefaultProcessWitness, type ProcessWitness } from './processWitness.js'
import { WorkspaceWitness } from './workspaceWitness.js'

export interface BdnsRuntimeOptions {
  runDir: string
  sessionId: string
  workspaceRoot: string
  processWitness?: ProcessWitness
  diagnosticRoot?: string
}

/**
 * Connect the independent planes for one session. All subscribers are
 * asynchronous and all writes are confined to the run's diagnostic directory.
 */
export class BdnsRuntime {
  readonly diagnostics: BdnsDiagnostics
  readonly store: BdnsDiagnosticStore
  readonly processWitness: ProcessWitness
  readonly workspaceWitness: WorkspaceWitness
  private readonly unsubscribeCanonical: () => void
  private readonly unsubscribeProcess: () => void
  private readonly unsubscribeWorkspace: () => void
  private closed = false

  constructor(options: BdnsRuntimeOptions) {
    this.diagnostics = new BdnsDiagnostics()
    this.store = new BdnsDiagnosticStore({
      root: options.diagnosticRoot ?? join(options.runDir, 'diagnostics', 'bdns'),
    })
    this.processWitness = options.processWitness ?? getDefaultProcessWitness()
    this.workspaceWitness = new WorkspaceWitness({
      root: options.workspaceRoot,
      diagnosticRoot: options.diagnosticRoot ?? join(options.runDir, 'diagnostics', 'bdns'),
    })
    this.unsubscribeCanonical = subscribeSessionEventObservation((event: SessionEvent) => {
      if (event.session_id !== options.sessionId) return
      const observation = {
        schemaVersion: 1 as const,
        observerSequence: event.seq,
        source: 'canonical' as const,
        kind: 'canonical_event' as const,
        correlation: {
          sessionId: event.session_id,
          ...(event.turn_id ? { turnId: event.turn_id } : {}),
          canonicalEventId: event.event_id,
        },
        wallTime: event.ts,
        monotonicTimeMs: event.seq,
        evidenceState: 'complete' as const,
        payload: event,
      }
      this.diagnostics.recordObservation(observation)
      this.store.appendObservation(observation)
    }, { id: `bdns-canonical-${options.sessionId}`, maxQueue: 256 })
    this.unsubscribeProcess = this.processWitness.subscribe((observation) => {
      const sessionId = observation.correlation.sessionId
      if (sessionId && sessionId !== options.sessionId) return
      this.diagnostics.recordObservation(observation)
      this.store.appendObservation(observation)
    }, { id: `bdns-process-${options.sessionId}`, maxQueue: 256 })
    this.unsubscribeWorkspace = this.workspaceWitness.bus.subscribe({
      id: `bdns-workspace-${options.sessionId}`,
      onObservation: (observation) => {
        this.diagnostics.recordObservation(observation)
        this.store.appendObservation(observation)
      },
    })
  }

  /** Reconcile process and canonical outcome while preserving both facts. */
  reconcileProcessOutcome(input: Parameters<BdnsDiagnostics['reconcileProcessOutcome']>[0]): void {
    const incident = this.diagnostics.reconcileProcessOutcome(input)
    if (incident) this.store.appendIncident(incident)
  }

  /** Reconcile bounded workspace evidence and persist any incident. */
  reconcileWorkspace(input: Parameters<BdnsDiagnostics['reconcileWorkspace']>[0]): void {
    const incident = this.diagnostics.reconcileWorkspace(input)
    if (incident) this.store.appendIncident(incident)
  }

  /** Flush and dispose session-owned observers without affecting execution. */
  async close(): Promise<boolean> {
    if (this.closed) return true
    this.closed = true
    await flushSessionEventObservations()
    this.unsubscribeCanonical()
    this.unsubscribeProcess()
    this.unsubscribeWorkspace()
    await this.processWitness.bus.flush()
    await this.workspaceWitness.bus.flush()
    this.store.writeSummary(this.diagnostics.summary())
    await this.store.flush()
    await this.workspaceWitness.close()
    const storeClosed = await this.store.close()
    return storeClosed && this.store.health().failures === 0
  }
}

/** Create a session-owned runtime with default bounded process observation. */
export function createBdnsRuntime(options: BdnsRuntimeOptions): BdnsRuntime {
  return new BdnsRuntime(options)
}
