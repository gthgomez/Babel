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

/** Load complete ledger records and ignore only an incomplete final JSONL line. */
export function loadEffectLedger(runDir: string): EffectLedgerRecord[] {
  const path = ledgerPath(runDir)
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as EffectLedgerRecord]
      } catch {
        return []
      }
    })
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

/**
 * Decide what a restarted executor may do with an interrupted effect.
 *
 * The caller supplies hashes observed after restart. A mutation may only be
 * retried when every target still has its recorded pre-image. A matching
 * intended post-image is treated as already complete. Unknown or external
 * effects are never replayed automatically.
 */
export function reconcileInterruptedEffect(
  intent: EffectLedgerRecord,
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
