import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { evaluateChatCompletionProof, mutationPathsFromSessionEvents } from '../evidence/chatRevisionBinding.js'
import { recordEffectIntent, recordEffectTerminal } from '../executor/effectLedger.js'
import { captureAndRecordVerifierReceipt } from './chatEngineVerifierAdapter.js'
import { recoverCurrentTaskMutationPaths } from './recoveredMutationWitness.js'
import { createSessionEventLog, recordMutationBatch, recordToolProposed, recordToolStarted, recordUserSubmitted } from './sessionEvents.js'
import { buildTaskContractV1, freezeTaskContract } from './taskContract.js'

for (const firstBatchPublished of [true, false]) {
  test(`recovery retains both disjoint effects when the first batch is ${firstBatchPublished ? 'present' : 'missing'}`, t => {
    const directory = mkdtempSync(join(tmpdir(), 'babel-mutation-witness-'))
    t.after(() => rmSync(directory, { recursive: true, force: true }))
    const root = realpathSync.native(directory)
    const projectRoot = join(root, 'project')
    const runDir = join(root, 'runs')
    mkdirSync(projectRoot)
    const contract = freezeTaskContract(buildTaskContractV1({
      mode: 'chat', task_id: 'task:two-files', user_request: 'Update a.txt and b.txt and run node --test check.test.mjs.',
    }))
    const log = createSessionEventLog('two-edit-session')
    const binding = { task: contract.user_request, task_id: contract.task_id, contract_hash: contract.contract_hash, contract_id: contract.contract_id }
    const hash = (value: string) => createHash('sha256').update(value).digest('hex')
    for (const filename of ['a.txt', 'b.txt']) {
      const path = join(projectRoot, filename)
      writeFileSync(path, 'before')
      recordUserSubmitted(log, { ...binding, turn_id: filename, attempt_id: `attempt:${filename}` })
      const dispatch = { turn_id: filename, tool_call_id: `call:${filename}`, tool_name: 'write_file',
        idempotency_key: `write:${filename}`, effect_class: 'reconcilable_mutation' as const }
      recordToolProposed(log, dispatch)
      recordToolStarted(log, dispatch)
      const intent = recordEffectIntent({ runDir, sessionId: log.session_id, turnId: filename, toolCallId: dispatch.tool_call_id,
        mutationBatchId: `batch:${filename}`, toolName: 'write_file', effectClass: 'reconcilable_mutation',
        targetPaths: [path], preImageHashes: { [path]: hash('before') }, intendedContent: 'after' })
      writeFileSync(path, 'after')
      const postImageHashes = { [path]: hash('after') }
      recordEffectTerminal(runDir, intent, { status: 'completed', postImageHashes })
      if (firstBatchPublished || filename === 'b.txt') {
        recordMutationBatch(log, filename, { paths: [filename], batch_id: intent.mutationBatchId,
          pre_image_hashes: intent.preImageHashes, post_image_hashes: postImageHashes, status: 'committed' })
      }
    }
    recordUserSubmitted(log, { ...binding, turn_id: 'resumed-turn', attempt_id: 'attempt:resumed' })
    const recover = () => recoverCurrentTaskMutationPaths({ log, runDir, projectRoot, turnId: 'resumed-turn', contract })
    assert.deepEqual(mutationPathsFromSessionEvents(log.events, recover()), ['a.txt', 'b.txt'])
    assert.deepEqual(recover(), ['a.txt', 'b.txt'])

    writeFileSync(join(projectRoot, 'b.txt'), 'externally replaced')
    assert.deepEqual(recover(), ['a.txt'], 'stale later output must not erase an unrelated current effect')
  })
}

test('cold completion can use a committed, current effect before the mutation event was published', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'babel-mutation-witness-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const root = realpathSync.native(directory)
  const projectRoot = join(root, 'project')
  const runDir = join(root, 'runs')
  mkdirSync(projectRoot)
  const path = join(projectRoot, 'fixture.txt')
  const contract = freezeTaskContract(buildTaskContractV1({
    mode: 'chat', task_id: 'task:recover-fixture', user_request: 'Update the fixture and run node --test check.test.mjs.',
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
  assert.deepEqual(recoverCurrentTaskMutationPaths(input), [], 'post-image alone does not settle an intent')
  recordEffectTerminal(runDir, intent, { status: 'completed', postImageHashes: { [path]: hash('after') } })
  assert.deepEqual(recoverCurrentTaskMutationPaths(input), ['fixture.txt'])
  assert.deepEqual(recoverCurrentTaskMutationPaths({ ...input, log: { ...log, events: log.events.filter(row =>
    row.kind !== 'tool_started') } }), [], 'the ledger must name a canonical dispatch')
  assert.deepEqual(recoverCurrentTaskMutationPaths({ ...input, contract: { ...contract, task_id: 'task:successor' } }), [])

  writeFileSync(join(projectRoot, 'check.test.mjs'), [
    "import { test } from 'node:test'",
    "import assert from 'node:assert/strict'",
    "import { readFileSync } from 'node:fs'",
    "test('retained change', () => assert.equal(readFileSync('fixture.txt', 'utf8'), 'after'))",
  ].join('\n'))
  const env = { ...process.env }
  delete env['NODE_TEST_CONTEXT']
  const execution = spawnSync(process.execPath, ['--test', '--test-reporter=tap', 'check.test.mjs'],
    { cwd: projectRoot, env, encoding: 'utf8', timeout: 5_000, windowsHide: true })
  assert.equal(execution.status, 0)
  const capture = {
    projectRoot, command: 'node --test check.test.mjs', exitCode: execution.status,
    summary: 'fixture verifier passed', stdout: execution.stdout, stderr: execution.stderr,
    allowRepositoryScopeForGreenNoChange: true, sessionEvents: log, turnId: input.turnId,
    ledger: [], cache: new Map(), writeCount: 0, executionBackend: 'host-process' as const,
  }
  assert.equal(await captureAndRecordVerifierReceipt({ ...capture, mutationPaths: [] }), null)
  const receipt = await captureAndRecordVerifierReceipt({
    ...capture,
    mutationPaths: recoverCurrentTaskMutationPaths(input),
  })
  assert.ok(receipt)
  assert.ok(receipt.boundRevision?.fileHashes['fixture.txt'])
  const proof = () => evaluateChatCompletionProof({
    projectRoot, hasMutation: true, verifierTampered: false, receipt, events: log.events,
    recoveredMutationPaths: recoverCurrentTaskMutationPaths(input), isAuthoritativeCommand: () => true,
    env: {}, executionProfile: 'safe_repo',
  })
  assert.deepEqual(proof(), { compliant: true })

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
  assert.deepEqual(recoverCurrentTaskMutationPaths({ ...input, log: legacyLog, runDir: legacyRunDir }), ['fixture.txt'])
  // A later operation can own the same bytes. Do not resurrect the earlier
  // effect's task lineage based solely on a matching current digest.
  const foreignIntent = recordEffectIntent({
    runDir, sessionId: log.session_id, turnId: 'other-objective', toolCallId: 'other-call',
    mutationBatchId: 'other-batch', toolName: 'write_file', effectClass: 'reconcilable_mutation',
    targetPaths: [path], preImageHashes: { [path]: hash('different') }, intendedContent: 'after',
  })
  recordEffectTerminal(runDir, foreignIntent, { status: 'completed', postImageHashes: { [path]: hash('after') } })
  assert.deepEqual(recoverCurrentTaskMutationPaths(input), [], 'same bytes from another operation do not reestablish custody')
  writeFileSync(path, 'changed after restart')
  assert.deepEqual(recoverCurrentTaskMutationPaths(input), [])
  assert.equal(proof().compliant, false)
})
