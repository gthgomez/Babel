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

/** Recover current project-relative paths from a prior committed mutation of this task. */
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
    event.contract_hash === contract.contract_hash && event.session_id === log.session_id)
  if (!current) return []
  for (const event of log.events) {
    if (event.seq >= current.seq || event.session_id !== log.session_id || !event.turn_id) continue
    if (event.kind === 'user_submitted' && event.task_id === contract.task_id &&
        event.contract_hash === contract.contract_hash) priorTurns.add(event.turn_id)
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
    const compensated = new Set(ledger.records.map(record => record.compensatesOperationId))
    let latest: EffectLedgerRecord | undefined
    for (const record of ledger.records) {
      if (record.status === 'intent') {
        intents.set(record.operationId, record)
        continue
      }
      const intent = intents.get(record.operationId)
      const post = record.postImageHashes
      if (!intent || !post || record.sessionId !== log.session_id || record.status !== 'completed' ||
          record.effectClass !== 'reconcilable_mutation' || compensated.has(record.operationId)) continue
      const paths = new Set(intent.targetPaths)
      if (paths.size !== Object.keys(post).length || paths.size !== Object.keys(intent.preImageHashes).length ||
          [...paths].some(path => !Object.hasOwn(post, path) || !Object.hasOwn(intent.preImageHashes, path)) ||
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
      if (linked) latest = record
    }
    if (!latest?.postImageHashes) return []
    const root = realpathSync.native(input.projectRoot)
    const paths: string[] = []
    for (const [path, digest] of Object.entries(latest.postImageHashes)) {
      if (!isAbsolute(path)) return []
      const fromRoot = relative(root, path).replaceAll('\\', '/')
      if (!fromRoot || fromRoot === '..' || fromRoot.startsWith('../') || isAbsolute(fromRoot) ||
          isCredentialTargetPath(fromRoot)) return []
      if (digest === WorkspaceTransactionManager.missingPathDigest()) {
        const parent = latest.targetParentIdentities?.[path]
        if (!parent || relative(path, resolveOwnedEffectPath(path, parent)) !== '' ||
            lstatSync(path, { throwIfNoEntry: false }) !== undefined) return []
      } else {
        const bytes = checkedFileBytes(path, 16 * 1024 * 1024, () => relative(path, realpathSync.native(path)) === '')
        if (!bytes || createHash('sha256').update(bytes).digest('hex') !== digest) return []
      }
      paths.push(fromRoot)
    }
    return paths
  } catch {
    return []
  }
}
