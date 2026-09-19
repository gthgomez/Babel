import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { ToolEffectClass } from './contracts.js'

/** Durable effect state written before and after a potentially mutating tool. */
export type EffectLedgerStatus = 'intent' | 'completed' | 'failed' | 'cancelled'

/** One crash-recovery record for a tool effect. */
export interface EffectLedgerRecord {
  schemaVersion: 1
  operationId: string
  sessionId: string
  turnId: string | null
  mutationBatchId: string
  effectClass: ToolEffectClass
  toolName: string
  targetPaths: string[]
  preImageHashes: Record<string, string>
  intendedDigest?: string
  status: EffectLedgerStatus
  postImageHashes?: Record<string, string>
  error?: string
  createdAt: string
  updatedAt: string
}

function ledgerPath(runDir: string): string {
  return join(runDir, 'effect-ledger.jsonl')
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function appendDurably(path: string, record: EffectLedgerRecord): void {
  mkdirSync(dirname(path), { recursive: true })
  const fd = openSync(path, 'a')
  try {
    appendFileSync(fd, `${JSON.stringify(record)}\n`, 'utf8')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/** Record a pre-effect intent; failures prevent the caller from executing the effect. */
export function recordEffectIntent(input: {
  runDir: string
  sessionId: string
  turnId?: string | null
  mutationBatchId: string
  effectClass: ToolEffectClass
  toolName: string
  targetPaths: string[]
  preImageHashes: Record<string, string>
  intendedContent?: string
}): EffectLedgerRecord {
  const now = new Date().toISOString()
  const record: EffectLedgerRecord = {
    schemaVersion: 1,
    operationId: randomUUID(),
    sessionId: input.sessionId,
    turnId: input.turnId ?? null,
    mutationBatchId: input.mutationBatchId,
    effectClass: input.effectClass,
    toolName: input.toolName,
    targetPaths: [...input.targetPaths],
    preImageHashes: { ...input.preImageHashes },
    ...(input.intendedContent !== undefined ? { intendedDigest: digest(input.intendedContent) } : {}),
    status: 'intent',
    createdAt: now,
    updatedAt: now,
  }
  appendDurably(ledgerPath(input.runDir), record)
  return record
}

/** Record the terminal state for a previously persisted effect intent. */
export function recordEffectTerminal(
  runDir: string,
  intent: EffectLedgerRecord,
  input: {
    status: Exclude<EffectLedgerStatus, 'intent'>
    postImageHashes?: Record<string, string>
    error?: string
  },
): EffectLedgerRecord {
  const record: EffectLedgerRecord = {
    ...intent,
    status: input.status,
    ...(input.postImageHashes ? { postImageHashes: { ...input.postImageHashes } } : {}),
    ...(input.error ? { error: input.error.slice(0, 500) } : {}),
    updatedAt: new Date().toISOString(),
  }
  appendDurably(ledgerPath(runDir), record)
  return record
}

/** Diagnostics from loading the JSONL ledger; makes silent line drops explicit. */
export interface EffectLedgerLoadResult {
  records: EffectLedgerRecord[]
  /** Number of non-empty lines that could not be parsed as JSON. */
  malformedLines: number
  /** Malformed lines that are not the torn final line (genuine corruption). */
  corruptLines: number
  /** The final line is incomplete (no trailing newline) — the expected torn tail. */
  tornFinalLine: boolean
}

/**
 * Load complete ledger records and classify the lines that were dropped.
 * A torn final line is expected after a crash; any other malformed line is
 * reported as corruption so a caller never treats a damaged history as whole.
 */
export function loadEffectLedgerWithDiagnostics(runDir: string): EffectLedgerLoadResult {
  const path = ledgerPath(runDir)
  if (!existsSync(path)) {
    return { records: [], malformedLines: 0, corruptLines: 0, tornFinalLine: false }
  }
  const content = readFileSync(path, 'utf8')
  const endsWithNewline = content.endsWith('\n')
  const rawLines = content.split('\n')
  const records: EffectLedgerRecord[] = []
  let malformedLines = 0
  let corruptLines = 0
  let tornFinalLine = false
  for (let index = 0; index < rawLines.length; index += 1) {
    const line = rawLines[index]!
    if (line.trim().length === 0) continue
    try {
      records.push(JSON.parse(line) as EffectLedgerRecord)
    } catch {
      malformedLines += 1
      if (index === rawLines.length - 1 && !endsWithNewline) tornFinalLine = true
      else corruptLines += 1
    }
  }
  return { records, malformedLines, corruptLines, tornFinalLine }
}

/**
 * Load complete ledger records, dropping every unparseable line (a torn final
 * line is the expected crash tail; any other drop is corruption). Callers that
 * must distinguish the two use `loadEffectLedgerWithDiagnostics`.
 */
export function loadEffectLedger(runDir: string): EffectLedgerRecord[] {
  return loadEffectLedgerWithDiagnostics(runDir).records
}

/** Return effect intents that have no terminal record after a crash. */
export function findInterruptedEffects(records: EffectLedgerRecord[]): EffectLedgerRecord[] {
  const terminalIds = new Set(
    records
      .filter((record) => record.status !== 'intent')
      .map((record) => record.operationId),
  )
  return records.filter((record) => record.status === 'intent' && !terminalIds.has(record.operationId))
}

export type EffectReconciliationDecision =
  | 'retry_reconcilable'
  | 'recovered_complete'
  | 'workspace_conflict'
  | 'manual_review'

/** Minimal effect identity required to reconcile an interrupted effect. */
export interface ReconcilableEffect {
  effectClass: ToolEffectClass
  preImageHashes: Record<string, string>
  postImageHashes?: Record<string, string>
}

/**
 * Decide what a restarted executor may do with an interrupted effect.
 *
 * The caller supplies hashes observed after restart. A mutation may only be
 * retried when every target still has its recorded pre-image. A matching
 * intended post-image is treated as already complete. Unknown or external
 * effects are never replayed automatically.
 */
export function reconcileInterruptedEffect(
  intent: ReconcilableEffect,
  currentImageHashes: Record<string, string>,
): EffectReconciliationDecision {
  if (
    intent.effectClass === 'non_idempotent_local_effect' ||
    intent.effectClass === 'external_side_effect'
  ) {
    return 'manual_review'
  }

  const postHashes = intent.postImageHashes
  if (postHashes && hashesMatch(postHashes, currentImageHashes)) {
    return 'recovered_complete'
  }

  if (hashesMatch(intent.preImageHashes, currentImageHashes)) {
    return intent.effectClass === 'read_only' || intent.effectClass === 'idempotent' || intent.effectClass === 'reconcilable_mutation'
      ? 'retry_reconcilable'
      : 'manual_review'
  }

  return 'workspace_conflict'
}

function hashesMatch(expected: Record<string, string>, actual: Record<string, string>): boolean {
  const expectedPaths = Object.keys(expected).sort()
  const actualPaths = Object.keys(actual).sort()
  if (expectedPaths.length !== actualPaths.length) return false
  return expectedPaths.every((path) => expected[path] === actual[path])
}
