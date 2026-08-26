/** Session-owned BDNS wiring for canonical, process, workspace, and storage planes. */

import { join } from 'node:path'
import {
  flushSessionEventObservations,
  subscribeSessionEventBdnsObservation,
} from '../../agent/sessionEvents.js'
import { BdnsDiagnostics } from './diagnostics.js'
import { BdnsDiagnosticStore } from './diagnosticStore.js'
import { projectCanonicalEventMetadata } from './evidenceCandidate.js'
import { getDefaultProcessWitness, type ProcessWitness } from './processWitness.js'
import type { BdnsObservation } from './types.js'
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
    this.unsubscribeCanonical = subscribeSessionEventBdnsObservation((observation) => {
      const sessionId = observation.correlation.sessionId
      if (sessionId && sessionId !== options.sessionId) return
      const metadata = projectCanonicalEventMetadata(observation.payload)
      this.ingest({
        ...observation,
        correlation: {
          ...observation.correlation,
          ...(metadata.toolCallId ? { toolCallId: observation.correlation.toolCallId ?? metadata.toolCallId } : {}),
        },
        payload: metadata,
      })
    }, { id: `bdns-canonical-${options.sessionId}`, maxQueue: 256 })
    this.unsubscribeProcess = this.processWitness.subscribe((observation) => {
      const sessionId = observation.correlation.sessionId
      if (sessionId && sessionId !== options.sessionId) return
      this.ingest(observation)
    }, { id: `bdns-process-${options.sessionId}`, maxQueue: 256 })
    this.unsubscribeWorkspace = this.workspaceWitness.bus.subscribe({
      id: `bdns-workspace-${options.sessionId}`,
      onObservation: (observation) => {
        this.ingest(observation)
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

  /**
   * Persist the current bounded bundle without disposing subscribers.
   * Canonical callers must not await this on the hot path.
   */
  async flushPersistence(): Promise<void> {
    if (this.closed) return
    await flushSessionEventObservations()
    await this.processWitness.bus.flush()
    await this.workspaceWitness.bus.flush()
    if (this.store.health().failures > 0) {
      const incident = this.diagnostics.recordPersistenceDegraded({}, this.store.health().lastError)
      if (incident) this.store.appendIncident(incident)
    }
    this.store.writeSummary(this.diagnostics.summary())
    await this.store.flush()
  }

  /** Flush and dispose session-owned observers without affecting execution. */
  async close(): Promise<boolean> {
    if (this.closed) return true
    await this.flushPersistence()
    this.closed = true
    this.unsubscribeCanonical()
    this.unsubscribeProcess()
    this.unsubscribeWorkspace()
    await this.workspaceWitness.close()
    const storeClosed = await this.store.close()
    return storeClosed && this.store.health().failures === 0
  }

  private ingest(observation: BdnsObservation): void {
    const incident = this.diagnostics.recordObservation(observation)
    this.store.appendObservation(observation)
    if (incident) this.store.appendIncident(incident)
  }
}

/** Create a session-owned runtime with default bounded process observation. */
export function createBdnsRuntime(options: BdnsRuntimeOptions): BdnsRuntime {
  return new BdnsRuntime(options)
}
