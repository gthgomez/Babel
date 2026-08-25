/** Bounded, redacted, fail-soft local BDNS diagnostic storage. */

import { appendFile, mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { stringifyBdns } from './serialization.js'
import type { BdnsIncident, BdnsObservation } from './types.js'

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024
const DEFAULT_MAX_RECORD_BYTES = 256 * 1024

export interface BdnsDiagnosticStoreOptions {
  root: string
  maxBytes?: number
  maxRecordBytes?: number
  appendLine?: (path: string, line: string) => Promise<void>
}

export interface BdnsStoreHealth {
  evidenceState: 'complete' | 'partial' | 'truncated' | 'persistence_degraded'
  recordsWritten: number
  bytesWritten: number
  truncated: number
  failures: number
  lastError?: string
}

/** Local-only store for BDNS evidence. It has no user-workspace write authority. */
export class BdnsDiagnosticStore {
  readonly observationsPath: string
  readonly incidentsPath: string
  readonly summaryPath: string
  private readonly root: string
  private readonly maxBytes: number
  private readonly maxRecordBytes: number
  private readonly appendLineOverride: ((path: string, line: string) => Promise<void>) | undefined
  private queue: Promise<void> = Promise.resolve()
  private bytesWritten = 0
  private recordsWritten = 0
  private truncated = 0
  private failures = 0
  private lastError: string | undefined
  private closed = false

  constructor(options: BdnsDiagnosticStoreOptions) {
    this.root = options.root
    this.maxBytes = Math.max(1, Math.floor(options.maxBytes ?? DEFAULT_MAX_BYTES))
    this.maxRecordBytes = Math.max(256, Math.floor(options.maxRecordBytes ?? DEFAULT_MAX_RECORD_BYTES))
    this.appendLineOverride = options.appendLine
    this.observationsPath = join(this.root, 'bdns-observations.jsonl')
    this.incidentsPath = join(this.root, 'bdns-incidents.jsonl')
    this.summaryPath = join(this.root, 'bdns-summary.json')
  }

  /** Queue one observation for bounded asynchronous persistence. */
  appendObservation<T>(observation: BdnsObservation<T>): void {
    this.enqueue(this.observationsPath, observation)
  }

  /** Queue one incident for bounded asynchronous persistence. */
  appendIncident(incident: BdnsIncident): void {
    this.enqueue(this.incidentsPath, incident)
  }

  /** Atomically write the current machine-readable summary. */
  writeSummary(summary: unknown): void {
    this.enqueueTask(async () => {
      await mkdir(this.root, { recursive: true })
      const tempPath = `${this.summaryPath}.tmp`
      await writeFile(tempPath, `${stringifyBdns(summary)}\n`, 'utf8')
      await rename(tempPath, this.summaryPath)
    })
  }

  /** Wait for currently queued writes; failures are represented in health. */
  async flush(): Promise<void> {
    await this.queue
  }

  /** Stop accepting writes after one bounded best-effort flush. */
  async close(timeoutMs = 1_000): Promise<boolean> {
    this.closed = true
    let completed = false
    await Promise.race([
      this.queue.then(() => { completed = true }),
      new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, timeoutMs))),
    ])
    return completed
  }

  health(): BdnsStoreHealth {
    return {
      evidenceState: this.failures > 0
        ? 'persistence_degraded'
        : this.truncated > 0
          ? 'truncated'
          : 'complete',
      recordsWritten: this.recordsWritten,
      bytesWritten: this.bytesWritten,
      truncated: this.truncated,
      failures: this.failures,
      ...(this.lastError ? { lastError: this.lastError } : {}),
    }
  }

  private enqueue(path: string, value: unknown): void {
    if (this.closed) return
    this.enqueueTask(async () => {
      const raw = `${stringifyBdns(value)}\n`
      const bytes = Buffer.byteLength(raw, 'utf8')
      if (this.bytesWritten + bytes > this.maxBytes) {
        this.truncated += 1
        return
      }
      const line = bytes > this.maxRecordBytes
        ? `${stringifyBdns({ schemaVersion: 1, evidenceState: 'truncated', reason: 'record_size_limit' })}\n`
        : raw
      if (this.appendLineOverride) await this.appendLineOverride(path, line)
      else {
        await mkdir(this.root, { recursive: true })
        await appendFile(path, line, 'utf8')
      }
      this.bytesWritten += Buffer.byteLength(line, 'utf8')
      this.recordsWritten += 1
      if (line !== raw) this.truncated += 1
    })
  }

  private enqueueTask(task: () => Promise<void>): void {
    this.queue = this.queue.then(task).catch((error) => {
      this.failures += 1
      this.lastError = error instanceof Error ? error.message : String(error)
    })
  }
}
