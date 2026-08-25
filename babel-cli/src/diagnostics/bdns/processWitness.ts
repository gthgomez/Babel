/** Explicit process lifecycle witness for Babel-owned execution boundaries. */

import { createHash, randomUUID } from 'node:crypto'
import { relative, sep } from 'node:path'
import { redactSecrets } from '../../utils/redaction.js'
import { createBdnsObservationBus, type BdnsObservationBus } from './observationBus.js'
import type { BdnsCorrelation, BdnsObservation, BdnsObservationKind } from './types.js'

const MAX_ARGUMENTS = 64
const MAX_ARGUMENT_CHARS = 256
const MAX_RECORDS = 1_024

export interface ProcessWitnessInput {
  executable: string
  args: readonly string[]
  cwd: string
  projectRoot?: string
  sessionId?: string
  turnId?: string
  toolCallId?: string
  toolName?: string
  timeoutMs?: number
}

export interface ProcessWitnessResult {
  exitCode: number | null
  signal?: string | null
  stdoutBytes?: number
  stderrBytes?: number
  stdoutTruncated?: boolean
  stderrTruncated?: boolean
  error?: string
}

export interface ProcessLifecyclePayload {
  executionId: string
  commandClass: string
  executable: string
  args: string[]
  argsTruncated: boolean
  cwdClass: 'workspace' | 'external' | 'unknown'
  pid?: number
  exitCode?: number | null
  signal?: string | null
  timeoutMs?: number
  stdoutBytes?: number
  stderrBytes?: number
  stdoutTruncated?: boolean
  stderrTruncated?: boolean
  error?: string
}

export interface ProcessWitnessRecord {
  executionId: string
  requestedAt: string
  status: 'requested' | 'started' | 'exited' | 'failed_to_start' | 'cancel_requested' | 'killed' | 'timeout'
  payload: ProcessLifecyclePayload
}

function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

function sanitizeArg(value: string, previous: string | undefined): string {
  const isSecretFlag = previous !== undefined && /(?:api[-_]?key|token|secret|password|authorization|credential)/iu.test(previous)
  if (isSecretFlag) return '[REDACTED]'
  return redactSecrets(value).slice(0, MAX_ARGUMENT_CHARS)
}

function sanitizeCwd(cwd: string, projectRoot: string | undefined): { cwdClass: ProcessLifecyclePayload['cwdClass']; value: string } {
  if (!projectRoot) return { cwdClass: 'unknown', value: digest(cwd) }
  const rel = relative(projectRoot, cwd)
  const outside = rel === '..' || rel.startsWith(`..${sep}`) || rel.includes(`..${sep}`)
  return outside
    ? { cwdClass: 'external', value: digest(cwd) }
    : { cwdClass: 'workspace', value: rel || '.' }
}

function buildPayload(input: ProcessWitnessInput, executionId: string): ProcessLifecyclePayload {
  const args = input.args.slice(0, MAX_ARGUMENTS).map((value, index, values) => sanitizeArg(value, values[index - 1]))
  const sanitizedCwd = sanitizeCwd(input.cwd, input.projectRoot)
  return {
    executionId,
    commandClass: input.toolName ?? input.executable.split(/[\\/]/u).pop() ?? 'unknown',
    executable: redactSecrets(input.executable).slice(0, MAX_ARGUMENT_CHARS),
    args,
    argsTruncated: input.args.length > MAX_ARGUMENTS,
    cwdClass: sanitizedCwd.cwdClass,
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
  }
}

function withCorrelation(input: ProcessWitnessInput): BdnsCorrelation {
  return {
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.turnId ? { turnId: input.turnId } : {}),
    ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
  }
}

/** Bounded, explicit process witness. It never changes process behavior. */
export class ProcessWitness {
  readonly bus: BdnsObservationBus<ProcessLifecyclePayload>
  private readonly records = new Map<string, ProcessWitnessRecord>()

  constructor(options: { maxQueue?: number; maxRecords?: number } = {}) {
    const maxRecords = Math.max(1, Math.floor(options.maxRecords ?? MAX_RECORDS))
    this.bus = createBdnsObservationBus<ProcessLifecyclePayload>(
      options.maxQueue === undefined ? {} : { maxQueue: options.maxQueue },
    )
    this.maxRecords = maxRecords
  }

  private readonly maxRecords: number

  /** Subscribe to independent process observations. */
  subscribe(onObservation: (observation: BdnsObservation<ProcessLifecyclePayload>) => void | Promise<void>, options: { id?: string; maxQueue?: number } = {}): () => void {
    return this.bus.subscribe({ ...options, onObservation })
  }

  requested(input: ProcessWitnessInput): string {
    const executionId = randomUUID()
    this.emit(input, executionId, 'process_requested', 'requested')
    return executionId
  }

  started(input: ProcessWitnessInput, executionId: string, pid: number | undefined): void {
    this.emit(input, executionId, 'process_started', 'started', pid === undefined ? {} : { pid })
  }

  failedToStart(input: ProcessWitnessInput, executionId: string, error: unknown): void {
    this.emit(input, executionId, 'process_failed_to_start', 'failed_to_start', { error: redactSecrets(error instanceof Error ? error.message : String(error)) })
  }

  exited(input: ProcessWitnessInput, executionId: string, result: ProcessWitnessResult): void {
    this.emit(input, executionId, 'process_exited', 'exited', {
      exitCode: result.exitCode,
      signal: result.signal ?? null,
      ...(result.stdoutBytes === undefined ? {} : { stdoutBytes: result.stdoutBytes }),
      ...(result.stderrBytes === undefined ? {} : { stderrBytes: result.stderrBytes }),
      ...(result.stdoutTruncated === undefined ? {} : { stdoutTruncated: result.stdoutTruncated }),
      ...(result.stderrTruncated === undefined ? {} : { stderrTruncated: result.stderrTruncated }),
      ...(result.error ? { error: redactSecrets(result.error) } : {}),
    })
  }

  cancelRequested(input: ProcessWitnessInput, executionId: string): void {
    this.emit(input, executionId, 'process_cancel_requested', 'cancel_requested')
  }

  killed(input: ProcessWitnessInput, executionId: string): void {
    this.emit(input, executionId, 'process_killed', 'killed')
  }

  timeout(input: ProcessWitnessInput, executionId: string): void {
    this.emit(input, executionId, 'process_timeout', 'timeout')
  }

  list(): ProcessWitnessRecord[] {
    return [...this.records.values()].map((record) => ({ ...record, payload: { ...record.payload, args: [...record.payload.args] } }))
  }

  health() {
    return this.bus.health()
  }

  async close(): Promise<void> {
    await this.bus.close()
    this.records.clear()
  }

  private emit(
    input: ProcessWitnessInput,
    executionId: string,
    kind: BdnsObservationKind,
    status: ProcessWitnessRecord['status'],
    fields: Partial<ProcessLifecyclePayload> = {},
  ): void {
    const payload = { ...buildPayload(input, executionId), ...fields }
    const record: ProcessWitnessRecord = {
      executionId,
      requestedAt: new Date().toISOString(),
      status,
      payload,
    }
    this.records.set(executionId, record)
    while (this.records.size > this.maxRecords) this.records.delete(this.records.keys().next().value as string)
    this.bus.publish({
      schemaVersion: 1,
      source: 'process',
      kind,
      correlation: { ...withCorrelation(input), processExecutionId: executionId },
      evidenceState: payload.stdoutTruncated || payload.stderrTruncated ? 'truncated' : 'complete',
      payload,
    })
  }
}

let defaultWitness: ProcessWitness | undefined

/** Process witness shared by explicit Babel execution bridges. */
export function getDefaultProcessWitness(): ProcessWitness {
  defaultWitness ??= new ProcessWitness()
  return defaultWitness
}

/** Replace the default witness in tests or during deterministic teardown. */
export async function resetDefaultProcessWitness(): Promise<void> {
  await defaultWitness?.close()
  defaultWitness = undefined
}
