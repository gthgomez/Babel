/** Bounded workspace mutation witness. Watcher signals are never truth. */

import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { createBdnsObservationBus, type BdnsObservationBus } from './observationBus.js'
import type { BdnsCorrelation, BdnsEvidenceState } from './types.js'

const MAX_PATHS = 256
const MAX_HASH_BYTES = 2 * 1024 * 1024

export interface WorkspaceWitnessOptions {
  root: string
  maxPaths?: number
  maxHashBytes?: number
  diagnosticRoot?: string
}

export interface WorkspacePathSnapshot {
  path: string
  exists: boolean
  kind: 'file' | 'directory' | 'other' | 'missing'
  sizeBytes?: number
  modifiedMs?: number
  hash?: string
  hashTruncated?: boolean
  error?: string
}

export interface WorkspaceReconciliation {
  transactionId: string
  declaredPaths: string[]
  changedPaths: string[]
  unexpectedChangedPaths: string[]
  missingExpectedPaths: string[]
  watcherPaths: string[]
  watcherEvidenceState: 'complete' | 'partial' | 'source_unavailable'
  evidenceState: BdnsEvidenceState
  before: WorkspacePathSnapshot[]
  after: WorkspacePathSnapshot[]
}

function hashBytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function normalizeRelative(root: string, input: string): string {
  const absolute = resolve(root, input)
  if (!isInside(root, absolute)) {
    throw new Error(`workspace witness path escapes root: ${input}`)
  }
  return relative(root, absolute) || '.'
}

function changed(before: WorkspacePathSnapshot, after: WorkspacePathSnapshot): boolean {
  return before.exists !== after.exists || before.kind !== after.kind || before.sizeBytes !== after.sizeBytes ||
    before.modifiedMs !== after.modifiedMs || before.hash !== after.hash
}

/** Independent bounded filesystem metadata/hash witness. */
export class WorkspaceWitness {
  readonly bus: BdnsObservationBus<WorkspaceReconciliation | { path: string; event: string }>
  private readonly root: string
  private readonly maxPaths: number
  private readonly maxHashBytes: number
  private readonly diagnosticRoot: string | undefined

  constructor(options: WorkspaceWitnessOptions) {
    this.root = resolve(options.root)
    this.maxPaths = Math.max(1, Math.floor(options.maxPaths ?? MAX_PATHS))
    this.maxHashBytes = Math.max(1, Math.floor(options.maxHashBytes ?? MAX_HASH_BYTES))
    this.diagnosticRoot = options.diagnosticRoot ? resolve(options.diagnosticRoot) : undefined
    this.bus = createBdnsObservationBus({ maxQueue: 256 })
  }

  /** Stop workspace observation after a bounded final flush. */
  async close(timeoutMs = 1_000): Promise<void> {
    await this.bus.close(timeoutMs)
  }

  /** Capture bounded metadata and a targeted content hash for files. */
  async capture(paths: readonly string[]): Promise<WorkspacePathSnapshot[]> {
    const selected = [...new Set(paths)].slice(0, this.maxPaths)
    const snapshots: WorkspacePathSnapshot[] = []
    for (const input of selected) {
      const path = normalizeRelative(this.root, input)
      if (this.diagnosticRoot && isInside(this.diagnosticRoot, resolve(this.root, path))) continue
      const absolute = resolve(this.root, path)
      try {
        const stats = await fs.stat(absolute)
        const snapshot: WorkspacePathSnapshot = {
          path,
          exists: true,
          kind: stats.isFile() ? 'file' : stats.isDirectory() ? 'directory' : 'other',
          sizeBytes: stats.size,
          modifiedMs: stats.mtimeMs,
        }
        if (stats.isFile()) {
          const handle = await fs.open(absolute, 'r')
          try {
            const bounded = Buffer.alloc(Math.min(this.maxHashBytes, stats.size))
            const { bytesRead } = await handle.read(bounded, 0, bounded.length, 0)
            snapshot.hash = hashBytes(bounded.subarray(0, bytesRead))
            if (stats.size > this.maxHashBytes) snapshot.hashTruncated = true
          } finally {
            await handle.close()
          }
        }
        snapshots.push(snapshot)
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
        if (code === 'ENOENT') snapshots.push({ path, exists: false, kind: 'missing' })
        else snapshots.push({ path, exists: false, kind: 'missing', error: error instanceof Error ? error.message : String(error) })
      }
    }
    return snapshots
  }

  /** Record a watcher signal as a non-authoritative observation. */
  recordWatcherSignal(path: string, event: 'add' | 'change' | 'unlink' | 'rename', correlation: BdnsCorrelation = {}): void {
    const normalized = normalizeRelative(this.root, path)
    if (this.diagnosticRoot && isInside(this.diagnosticRoot, resolve(this.root, normalized))) return
    this.bus.publish({
      schemaVersion: 1,
      source: 'watcher',
      kind: 'workspace_watcher_signal',
      correlation,
      evidenceState: 'complete',
      payload: { path: normalized, event },
    })
  }

  /** Reconcile declared intent, targeted snapshots, and watcher signals. */
  reconcile(input: {
    transactionId?: string
    declaredPaths: readonly string[]
    before: readonly WorkspacePathSnapshot[]
    after: readonly WorkspacePathSnapshot[]
    watcherPaths?: readonly string[]
    watcherAvailable?: boolean
    correlation?: BdnsCorrelation
  }): WorkspaceReconciliation {
    const transactionId = input.transactionId ?? randomUUID()
    const declaredPaths = [...new Set(input.declaredPaths.map((path) => normalizeRelative(this.root, path)))].slice(0, this.maxPaths)
    const beforeByPath = new Map(input.before.map((item) => [item.path, item]))
    const afterByPath = new Map(input.after.map((item) => [item.path, item]))
    const paths = [...new Set([...beforeByPath.keys(), ...afterByPath.keys()])]
    const changedPaths = paths.filter((path) => changed(
      beforeByPath.get(path) ?? { path, exists: false, kind: 'missing' },
      afterByPath.get(path) ?? { path, exists: false, kind: 'missing' },
    ))
    const unexpectedChangedPaths = changedPaths.filter((path) => !declaredPaths.includes(path))
    const missingExpectedPaths = declaredPaths.filter((path) => !changedPaths.includes(path))
    const watcherEvidenceState = input.watcherAvailable === false ? 'source_unavailable' : 'complete'
    const evidenceState = input.before.some((item) => item.error) || input.after.some((item) => item.error)
      ? 'source_unavailable'
      : input.before.some((item) => item.hashTruncated) || input.after.some((item) => item.hashTruncated)
        ? 'truncated'
        : 'complete'
    const reconciliation: WorkspaceReconciliation = {
      transactionId,
      declaredPaths,
      changedPaths,
      unexpectedChangedPaths,
      missingExpectedPaths,
      watcherPaths: [...new Set(input.watcherPaths ?? [])],
      watcherEvidenceState,
      evidenceState,
      before: [...input.before],
      after: [...input.after],
    }
    this.bus.publish({
      schemaVersion: 1,
      source: 'workspace',
      kind: 'workspace_reconciled',
      correlation: { ...(input.correlation ?? {}), workspaceTransactionId: transactionId },
      evidenceState,
      payload: reconciliation,
    })
    return reconciliation
  }
}
