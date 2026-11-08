import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, realpathSync } from 'node:fs'
import type { BigIntStats } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { z } from 'zod'

import type { ToolEffectClass } from './contracts.js'
import type { EffectParentIdentity } from './effectPathIdentity.js'
import { checkedFileBytes } from '../utils/checkedFileRead.js'

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
  /** A new effect restoring an earlier effect; the original history is immutable. */
  compensatesOperationId?: string
  /** Expected restored identities, including the canonical missing-path digest. */
  restorationHashes?: Record<string, string>
  /** Retained captured entry; recovery must preserve it until reconciliation. */
  compensationCapturePath?: string
  targetParentIdentities?: Record<string, EffectParentIdentity>
  status: EffectLedgerStatus
  postImageHashes?: Record<string, string>
  error?: string
  createdAt: string
  updatedAt: string
}

const stringMap = z.record(z.string(), z.string())
const EffectLedgerRecordSchema = z.object({
  schemaVersion: z.literal(1), operationId: z.string().min(1), sessionId: z.string().min(1),
  turnId: z.string().nullable(), mutationBatchId: z.string().min(1),
  effectClass: z.enum(['read_only', 'idempotent', 'reconcilable_mutation', 'non_idempotent_local_effect', 'external_side_effect']),
  toolName: z.string().min(1), targetPaths: z.array(z.string()), preImageHashes: stringMap,
  intendedDigest: z.string().optional(), compensatesOperationId: z.string().optional(),
  restorationHashes: stringMap.optional(), compensationCapturePath: z.string().optional(),
  targetParentIdentities: z.record(z.string(), z.object({ canonicalPath: z.string(), device: z.string(), inode: z.string(), relativeParent: z.array(z.string()).optional() })).optional(),
  status: z.enum(['intent', 'completed', 'failed', 'cancelled']), postImageHashes: stringMap.optional(),
  error: z.string().optional(), createdAt: z.string(), updatedAt: z.string(),
}).passthrough()

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stableValue(item)]))
  }
  return value
}

function effectIdentity(record: EffectLedgerRecord): string {
  const { status: _status, postImageHashes: _post, error: _error, updatedAt: _updated, ...identity } = record
  return JSON.stringify(stableValue(identity))
}

function ledgerPath(runDir: string): string {
  return join(runDir, 'effect-ledger.jsonl')
}

const MAX_EFFECT_LEDGER_BYTES = 16 * 1024 * 1024

function assertPhysicalExistingAncestor(path: string): void {
  const normalize = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value
  let ancestor = resolve(path)
  for (;;) {
    try {
      const info = lstatSync(ancestor)
      if (!info.isDirectory() || info.isSymbolicLink() || normalize(realpathSync(ancestor)) !== normalize(ancestor)) throw new Error('Unsafe effect ledger directory.')
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || ancestor === dirname(ancestor)) throw error
      ancestor = dirname(ancestor)
    }
  }
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function appendDurably(path: string, record: EffectLedgerRecord): void {
  const parent = dirname(resolve(path))
  const normalize = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value
  assertPhysicalExistingAncestor(parent)
  mkdirSync(parent, { recursive: true })
  const validParent = () => normalize(realpathSync(parent)) === normalize(parent) && lstatSync(parent).isDirectory() && !lstatSync(parent).isSymbolicLink()
  if (!validParent()) throw new Error('Unsafe effect ledger directory.')
  let expected: ReturnType<typeof lstatSync> | undefined
  let expectedExact: { dev: bigint; ino: bigint } | undefined
  try {
    const exact = lstatSync(path, { bigint: true })
    expected = lstatSync(path)
    if (!exact.isFile() || exact.isSymbolicLink() || exact.nlink !== 1n || exact.ino <= 0n ||
      !expected.isFile() || expected.isSymbolicLink() || expected.nlink !== 1 ||
      expected.dev !== Number(exact.dev) || expected.ino !== Number(exact.ino)) throw new Error('Unsafe linked or changed effect ledger.')
    expectedExact = exact
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const flags = constants.O_WRONLY | constants.O_APPEND | (expected ? 0 : constants.O_CREAT | constants.O_EXCL) | (constants.O_NOFOLLOW ?? 0)
  const fd = openSync(path, flags, 0o600)
  try {
    const validate = () => {
      const opened = fstatSync(fd, { bigint: true }); const named = lstatSync(path, { bigint: true })
      return opened.isFile() && named.isFile() && !named.isSymbolicLink() && opened.ino > 0n && named.ino > 0n && opened.nlink === 1n && named.nlink === 1n &&
        opened.dev === named.dev && opened.ino === named.ino && (!expectedExact || (opened.dev === expectedExact.dev && opened.ino === expectedExact.ino)) && validParent()
    }
    if (!validate()) throw new Error('Unsafe or changed effect ledger.')
    const entry = `${JSON.stringify(record)}\n`
    if (fstatSync(fd).size + Buffer.byteLength(entry, 'utf8') > MAX_EFFECT_LEDGER_BYTES) throw new Error('Effect ledger is oversized; retain it for inspection.')
    appendFileSync(fd, entry, 'utf8')
    fsyncSync(fd)
    if (!validate()) throw new Error('Effect ledger changed during append; outcome is uncertain.')
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
  compensatesOperationId?: string
  restorationHashes?: Record<string, string>
  compensationCapturePath?: string
  targetParentIdentities?: Record<string, EffectParentIdentity>
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
    ...(input.compensatesOperationId ? { compensatesOperationId: input.compensatesOperationId } : {}),
    ...(input.restorationHashes ? { restorationHashes: { ...input.restorationHashes } } : {}),
    ...(input.compensationCapturePath ? { compensationCapturePath: input.compensationCapturePath } : {}),
    ...(input.targetParentIdentities ? { targetParentIdentities: { ...input.targetParentIdentities } } : {}),
    status: 'intent',
    createdAt: now,
    updatedAt: now,
  }
  appendDurably(ledgerPath(input.runDir), record)
  return record
}

/**
 * Outcome of comparing observed post-operation bytes against the requested
 * post-image. An exit-zero tool result alone never proves a write happened.
 */
export type IntendedWriteOutcome =
  | 'unverified'
  | 'real_change'
  | 'legitimate_no_change'
  | 'effect_missing'
  | 'postimage_mismatch'

/**
 * Classify an observed post-image against the recorded intended content
 * digest for a single-target content write (write_file). Callers must never
 * pass a patch-text digest here — only the digest of the intended file bytes.
 *
 * - `real_change`: every observed post-image matches the intended digest and
 *   differs from the pre-image.
 * - `legitimate_no_change`: the file already matched the requested content,
 *   so a no-op write is the correct result.
 * - `effect_missing`: the requested content differs from the pre-image but
 *   the bytes on disk are unchanged — the requested write never happened.
 * - `postimage_mismatch`: the bytes changed, but to something other than the
 *   requested content (wrong-target or partial write).
 */
export function classifyIntendedWriteOutcome(
  intendedDigest: string,
  preImageHashes: Record<string, string>,
  postImageHashes: Record<string, string>,
): IntendedWriteOutcome {
  const paths = Object.keys(preImageHashes)
  if (paths.length === 0 || !hashesMatchPaths(preImageHashes, postImageHashes)) return 'unverified'
  const postMatchesIntended = paths.every(
    (path) => postImageHashes[path] === intendedDigest,
  )
  if (postMatchesIntended) {
    const unchanged = paths.every(
      (path) => postImageHashes[path] === preImageHashes[path],
    )
    return unchanged ? 'legitimate_no_change' : 'real_change'
  }
  const unchanged = paths.every(
    (path) => postImageHashes[path] === preImageHashes[path],
  )
  return unchanged ? 'effect_missing' : 'postimage_mismatch'
}

function hashesMatchPaths(left: Record<string, string>, right: Record<string, string>): boolean {
  const keys = Object.keys(left)
  return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key))
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
  /** Number of non-empty lines that are invalid JSON or invalid/conflicting records. */
  malformedLines: number
  /** Malformed lines that are not the torn final line (genuine corruption). */
  corruptLines: number
  /** The final line is incomplete (no trailing newline) — the expected torn tail. */
  tornFinalLine: boolean
}

/**
 * Load complete, shape-valid and identity-consistent ledger records, and classify dropped lines.
 * A torn final line is expected after a crash; any other malformed line is
 * reported as corruption so a caller never treats a damaged history as whole.
 */
export function loadEffectLedgerWithDiagnostics(runDir: string): EffectLedgerLoadResult {
  const path = ledgerPath(runDir)
  const parent = dirname(resolve(path))
  assertPhysicalExistingAncestor(parent)
  let exact: BigIntStats
  try { exact = lstatSync(path, { bigint: true }) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { records: [], malformedLines: 0, corruptLines: 0, tornFinalLine: false }
    throw error
  }
  const normalize = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value
  if (exact.ino <= 0n) throw new Error('Unsafe effect ledger identity is unavailable.')
  const bytes = checkedFileBytes(path, MAX_EFFECT_LEDGER_BYTES, () =>
    normalize(realpathSync(parent)) === normalize(parent) && normalize(realpathSync(path)) === normalize(resolve(path)), undefined, exact)
  if (!bytes) throw new Error('Unsafe, linked, changed, or oversized effect ledger.')
  const content = bytes.toString('utf8')
  const endsWithNewline = content.endsWith('\n')
  const rawLines = content.split('\n')
  const records: EffectLedgerRecord[] = []
  let malformedLines = 0
  let corruptLines = 0
  let tornFinalLine = false
  const identities = new Map<string, string>()
  const terminals = new Map<string, string>()
  for (let index = 0; index < rawLines.length; index += 1) {
    const line = rawLines[index]!
    if (line.trim().length === 0) continue
    try {
      const parsed = EffectLedgerRecordSchema.safeParse(JSON.parse(line))
      if (!parsed.success) throw new Error('Invalid effect ledger record')
      const record = parsed.data as EffectLedgerRecord
      const identity = effectIdentity(record)
      const previous = identities.get(record.operationId)
      if (record.status !== 'intent' && previous === undefined) throw new Error('Terminal effect without intent')
      if (previous !== undefined && previous !== identity) throw new Error('Conflicting effect identity')
      if (record.status !== 'intent') {
        const terminal = JSON.stringify(stableValue({ status: record.status, postImageHashes: record.postImageHashes, error: record.error }))
        const existing = terminals.get(record.operationId)
        if (existing !== undefined && existing !== terminal) throw new Error('Conflicting terminal effect')
        terminals.set(record.operationId, terminal)
      }
      identities.set(record.operationId, identity)
      records.push(record)
    } catch {
      malformedLines += 1
      if (index === rawLines.length - 1 && !endsWithNewline) tornFinalLine = true
      else corruptLines += 1
    }
  }
  return { records, malformedLines, corruptLines, tornFinalLine }
}

/**
 * Load complete ledger records, dropping invalid or conflicting lines (a torn final
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

/** Cold interpretation of append-only compensation history, never a replay grant. */
export function interpretCompensations(records: EffectLedgerRecord[]): Array<{
  originalOperationId: string
  compensation: EffectLedgerRecord
  compensationOperationIds: string[]
  state: 'completed' | 'failed' | 'uncertain'
}> {
  const latest = new Map<string, EffectLedgerRecord>()
  for (const record of records) latest.set(record.operationId, record)
  const byOriginal = new Map<string, EffectLedgerRecord[]>()
  for (const record of latest.values()) {
    if (record.compensatesOperationId) {
      const attempts = byOriginal.get(record.compensatesOperationId) ?? []
      attempts.push(record)
      byOriginal.set(record.compensatesOperationId, attempts)
    }
  }
  return [...byOriginal].map(([originalOperationId, attempts]) => {
    const compensation = attempts[attempts.length - 1]!
    const original = latest.get(originalOperationId)
    const expected = compensation.restorationHashes
    const confirmed = original?.status === 'completed' && compensation.status === 'completed'
      && expected !== undefined && Object.keys(expected).length > 0
      && hashesMatch(expected, compensation.postImageHashes ?? {})
    return { originalOperationId, compensation, compensationOperationIds: attempts.map(attempt => attempt.operationId),
      state: attempts.length > 1 ? 'uncertain' : confirmed ? 'completed' : compensation.status === 'failed' ? 'failed' : 'uncertain' }
  })
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
  compensatesOperationId?: string
  /** Host-owned proof that the original physical worker can no longer produce effects. */
  physicalSettlement?: 'proven'
}

/**
 * Decide what a restarted executor may do with an interrupted effect.
 *
 * The caller supplies hashes observed after restart. A mutation may only be
 * retried after physical settlement is proven and every target still has
 * its recorded pre-image. A matching intended post-image is treated as complete
 * only after settlement. Unknown or external effects are never replayed.
 */
export function reconcileInterruptedEffect(
  intent: ReconcilableEffect,
  currentImageHashes: Record<string, string>,
  options?: { readonly trustedPersistedIntent?: boolean },
): EffectReconciliationDecision {
  // A durable admission outbox intent is itself host-persisted evidence that the
  // original owner committed this intent; reconstructed restore records are not.
  const settlementProven = intent.physicalSettlement === 'proven' || options?.trustedPersistedIntent === true;
  // An interrupted restoration may already have changed bytes. Never replay it
  // as an ordinary write or declare it settled from the original post-image.
  if (intent.compensatesOperationId) return 'manual_review'
  if (
    intent.effectClass === 'non_idempotent_local_effect' ||
    intent.effectClass === 'external_side_effect'
  ) {
    return 'manual_review'
  }

  const postHashes = intent.postImageHashes
  if (postHashes && Object.keys(postHashes).length > 0 && hashesMatch(postHashes, currentImageHashes)) {
    if (intent.effectClass !== 'read_only' && !settlementProven) return 'manual_review'
    return 'recovered_complete'
  }

  if (hashesMatch(intent.preImageHashes, currentImageHashes)) {
    if (intent.effectClass !== 'read_only' && Object.keys(intent.preImageHashes).length === 0) return 'manual_review'
    if (intent.effectClass !== 'read_only' && !settlementProven) return 'manual_review'
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
