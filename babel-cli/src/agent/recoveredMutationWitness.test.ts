import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { recordEffectIntent, recordEffectTerminal } from '../executor/effectLedger.js'
import { hasRecoveredMutationWitness } from './recoveredMutationWitness.js'
import { createSessionEventLog, recordMutationBatch, recordToolProposed, recordToolStarted, recordUserSubmitted } from './sessionEvents.js'
import { buildTaskContractV1, freezeTaskContract } from './taskContract.js'

test('a cold verifier can use a committed, current effect from this task before the mutation event was published', t => {
  const directory = mkdtempSync(join(tmpdir(), 'babel-mutation-witness-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const root = realpathSync.native(directory)
  const projectRoot = join(root, 'project')
  const runDir = join(root, 'runs')
  mkdirSync(projectRoot)
  const path = join(projectRoot, 'fixture.txt')
  const contract = freezeTaskContract(buildTaskContractV1({
    mode: 'chat', task_id: 'task:recover-fixture', user_request: 'Update the fixture and run npm test.',
  }))
  const log = createSessionEventLog('fixture-session')
  const binding = { task: contract.user_request, task_id: contract.task_id, contract_hash: contract.contract_hash,
    contract_id: contract.contract_id }
  recordUserSubmitted(log, { ...binding, turn_id: 'first-turn', attempt_id: 'attempt:first' })
  const call = { turn_id: 'first-turn', tool_call_id: 'write-call', tool_name: 'str_replace',
    idempotency_key: 'write-call', effect_class: 'reconcilable_mutation' as const }
  recordToolProposed(log, call)
  recordToolStarted(log, call)
  const hash = (value: string) => createHash('sha256').update(value).digest('hex')
  const intent = recordEffectIntent({
    runDir, sessionId: log.session_id, turnId: 'first-turn', toolCallId: 'write-call',
    mutationBatchId: 'batch-write', toolName: 'write_file', effectClass: 'reconcilable_mutation',
    targetPaths: [path], preImageHashes: { [path]: hash('before') }, intendedContent: 'after',
  })
  writeFileSync(path, 'after')
  recordUserSubmitted(log, { ...binding, turn_id: 'resumed-turn', attempt_id: 'attempt:resumed' })
  const input = { log, runDir, projectRoot, turnId: 'resumed-turn', contract }
  assert.equal(hasRecoveredMutationWitness(input), false, 'post-image alone does not settle an intent')
  recordEffectTerminal(runDir, intent, { status: 'completed', postImageHashes: { [path]: hash('after') } })
  assert.equal(hasRecoveredMutationWitness(input), true)
  assert.equal(hasRecoveredMutationWitness({ ...input, log: { ...log, events: log.events.filter(row =>
    row.kind !== 'tool_started') } }), false, 'the ledger must name a canonical dispatch')
  assert.equal(hasRecoveredMutationWitness({ ...input, contract: { ...contract, task_id: 'task:successor' } }), false)

  const legacyLog = createSessionEventLog('legacy-session')
  const legacyRunDir = join(root, 'legacy-runs')
  recordUserSubmitted(legacyLog, { ...binding, turn_id: 'first-turn', attempt_id: 'attempt:first' })
  const legacyIntent = recordEffectIntent({
    runDir: legacyRunDir, sessionId: legacyLog.session_id, mutationBatchId: 'legacy-write', toolName: 'write_file',
    effectClass: 'reconcilable_mutation', targetPaths: [path], preImageHashes: { [path]: hash('before') }, intendedContent: 'after',
  })
  recordEffectTerminal(legacyRunDir, legacyIntent, { status: 'completed', postImageHashes: { [path]: hash('after') } })
  recordMutationBatch(legacyLog, 'first-turn', { paths: [path], batch_id: legacyIntent.mutationBatchId,
    pre_image_hashes: legacyIntent.preImageHashes, post_image_hashes: { [path]: hash('after') }, status: 'committed' })
  recordUserSubmitted(legacyLog, { ...binding, turn_id: 'resumed-turn', attempt_id: 'attempt:resumed' })
  assert.equal(hasRecoveredMutationWitness({ ...input, log: legacyLog, runDir: legacyRunDir }), true)
  writeFileSync(path, 'changed after restart')
  assert.equal(hasRecoveredMutationWitness(input), false)
})
