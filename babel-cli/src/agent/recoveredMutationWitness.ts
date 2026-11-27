import { createHash } from 'node:crypto'
import { lstatSync, realpathSync } from 'node:fs'
import { isAbsolute, relative } from 'node:path'
import { sha256Canonical } from '../acceptance/canonical.js'
import { classifyIntendedWriteOutcome, loadEffectLedgerWithDiagnostics, type EffectLedgerRecord } from '../executor/effectLedger.js'
import { resolveOwnedEffectPath } from '../executor/effectPathIdentity.js'
import { WorkspaceTransactionManager } from '../services/workspaceTransactions.js'
import { checkedFileBytes } from '../utils/checkedFileRead.js'
import { isCredentialTargetPath } from './autonomyEnforcement.js'
import type { SessionEvent, SessionEventLog } from './sessionEvents.js'
import type { TaskContractV1 } from './taskContract.js'

function currentEffectPaths(root: string, effect: EffectLedgerRecord): string[] {
  const paths: string[] = []
  for (const [path, digest] of Object.entries(effect.postImageHashes ?? {})) {
    if (!isAbsolute(path)) return []
    const fromRoot = relative(root, path).replaceAll('\\', '/')
    if (!fromRoot || fromRoot === '..' || fromRoot.startsWith('../') || isAbsolute(fromRoot) ||
        isCredentialTargetPath(fromRoot)) return []
    if (digest === WorkspaceTransactionManager.missingPathDigest()) {
      const parent = effect.targetParentIdentities?.[path]
      if (!parent || relative(path, resolveOwnedEffectPath(path, parent)) !== '' ||
          lstatSync(path, { throwIfNoEntry: false }) !== undefined) return []
    } else {
      const bytes = checkedFileBytes(path, 16 * 1024 * 1024, () => relative(path, realpathSync.native(path)) === '')
      if (!bytes || createHash('sha256').update(bytes).digest('hex') !== digest) return []
    }
    paths.push(fromRoot)
  }
  return paths
}

/** Recover current project-relative paths from prior committed mutations of this task. */
export function recoverCurrentTaskMutationPaths(input: {
  log: SessionEventLog
  runDir: string
  projectRoot: string
  turnId: string
  contract: TaskContractV1
}): string[] {
  const { log, contract } = input
  const priorTurns = new Set<string>()
  const starts = new Map<string, Set<string>>()
  const batches = new Map<string, Extract<SessionEvent, { kind: 'mutation_batch' }>>()
  const current = log.events.find(event => event.kind === 'user_submitted' &&
    event.turn_id === input.turnId && event.task_id === contract.task_id &&
    event.contract_id === contract.contract_id && event.contract_hash === contract.contract_hash &&
    event.session_id === log.session_id)
  if (!current) return []
  for (const event of log.events) {
    if (event.seq >= current.seq || event.session_id !== log.session_id || !event.turn_id) continue
    if (event.kind === 'user_submitted' && event.task_id === contract.task_id &&
        event.contract_id === contract.contract_id && event.contract_hash === contract.contract_hash) priorTurns.add(event.turn_id)
    if (!priorTurns.has(event.turn_id)) continue
    if (event.kind === 'tool_started' && event.effect_class === 'reconcilable_mutation') {
      const calls = starts.get(event.turn_id) ?? new Set<string>()
      calls.add(event.tool_call_id)
      starts.set(event.turn_id, calls)
    }
    if (event.kind === 'mutation_batch' && event.status === 'committed' && event.batch_id)
      batches.set(event.batch_id, event)
  }
  if (starts.size === 0 && batches.size === 0) return []
  try {
    const ledger = loadEffectLedgerWithDiagnostics(input.runDir)
    if (ledger.malformedLines > 0) return []
    const intents = new Map<string, EffectLedgerRecord>()
    const latestOwnerByPath = new Map<string, string>()
    const pathIdentity = (path: string) => {
      const name = relative(input.projectRoot, path)
      return process.platform === 'win32' ? name.toLowerCase() : name
    }
    for (const record of ledger.records) {
      if (record.status !== 'intent' || intents.has(record.operationId)) continue
      intents.set(record.operationId, record)
      for (const path of record.targetPaths) {
        if (isAbsolute(path)) latestOwnerByPath.set(pathIdentity(path), record.operationId)
      }
    }
    const compensated = new Set(ledger.records.map(record => record.compensatesOperationId))
    const recovered = new Set<string>()
    const root = realpathSync.native(input.projectRoot)
    for (const record of ledger.records) {
      const intent = intents.get(record.operationId)
      const post = record.postImageHashes
      if (!intent || !post || record.sessionId !== log.session_id || record.status !== 'completed' ||
          record.effectClass !== 'reconcilable_mutation' || record.compensatesOperationId || compensated.has(record.operationId)) continue
      const paths = new Set(intent.targetPaths)
      if (paths.size !== Object.keys(post).length || paths.size !== Object.keys(intent.preImageHashes).length ||
          [...paths].some(path => !Object.hasOwn(post, path) || !Object.hasOwn(intent.preImageHashes, path)) ||
          [...paths].some(path => !isAbsolute(path) || latestOwnerByPath.get(pathIdentity(path)) !== record.operationId) ||
          ![...paths].some(path => post[path] !== intent.preImageHashes[path]) ||
          (intent.toolName === 'write_file' && (paths.size !== 1 || !intent.intendedDigest ||
            classifyIntendedWriteOutcome(intent.intendedDigest, intent.preImageHashes, post) !== 'real_change'))) continue
      // New records can prove a committed effect even if the process died
      // before publishing the later mutation_batch event. Legacy rows must
      // join the canonical mutation batch; do not infer their task from bytes.
      const batch = batches.get(record.mutationBatchId)
      const linked = record.toolCallId && record.turnId
        ? starts.get(record.turnId)?.has(record.toolCallId)
        : !record.toolCallId && record.turnId === null && batch?.pre_image_hashes && batch.post_image_hashes &&
          sha256Canonical(batch.pre_image_hashes) === sha256Canonical(intent.preImageHashes) &&
          sha256Canonical(batch.post_image_hashes) === sha256Canonical(post)
      if (linked) {
        // A stale or replaced operation cannot erase a disjoint current one.
        try {
          for (const path of currentEffectPaths(root, record)) recovered.add(path)
        } catch {
          continue
        }
      }
    }
    return [...recovered].sort()
  } catch {
    return []
  }
}
