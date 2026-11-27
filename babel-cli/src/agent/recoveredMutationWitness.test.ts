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
import { createTaskAcceptanceRevision } from './taskAcceptanceRevision.js'
import { inferFreshTaskAcceptance } from './taskAcceptanceMeaning.js'
import { appendTaskAcceptanceRevision } from './taskModeRevision.js'
import { bindInitialObjective } from './taskObjectiveLifecycle.js'
import { sha256Canonical } from '../acceptance/canonical.js'

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
        idempotency_key: `call:${filename}`, effect_class: 'reconcilable_mutation' as const }
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

    const before = log.events.find(row => row.kind === 'tool_started' && row.turn_id === 'a.txt')!
    const ambiguous = { ...log, events: log.events.flatMap(row => row === before ? [row, row] : [row]) }
    assert.deepEqual(recoverCurrentTaskMutationPaths({ log: ambiguous, runDir, projectRoot, turnId: 'resumed-turn', contract }), ['b.txt'])

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
  const request = 'Update the fixture and run node --test check.test.mjs.'
  const meaning = inferFreshTaskAcceptance(request)
  const seed = freezeTaskContract(buildTaskContractV1({
    mode: 'chat', task_id: 'task:recover-fixture', user_request: request,
    acceptance: meaning.criteria, provenance: meaning.provenance,
  }))
  const { taskContract: contract, taskModeHistory } = bindInitialObjective({ taskContract: seed })
  const log = createSessionEventLog('fixture-session')
  const binding = { task: contract.user_request, task_id: contract.task_id, contract_hash: contract.contract_hash,
    contract_id: contract.contract_id }
  recordUserSubmitted(log, { ...binding, turn_id: 'first-turn', attempt_id: 'attempt:first' })
  const call = { turn_id: 'first-turn', tool_call_id: 'write-call', tool_name: 'write_file',
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

  const addition = 'Also require:\n- The fixture survives a restart.'
  const revision = createTaskAcceptanceRevision(contract, { userInput: addition, inputDigest: sha256Canonical(addition), attemptId: 'attempt:amended' })!
  const history = appendTaskAcceptanceRevision(taskModeHistory!, revision.contract, revision.descriptor)
  const amendedLog = { ...log, events: [...log.events] }
  recordUserSubmitted(amendedLog, { ...binding, task: addition, contract_id: revision.contract.contract_id,
    contract_hash: revision.contract.contract_hash, turn_id: 'amend', attempt_id: revision.descriptor.source_attempt_id })
  const amendedInput = { ...input, log: amendedLog, turnId: 'amend', contract: revision.contract }
  assert.deepEqual(recoverCurrentTaskMutationPaths(amendedInput), [], 'a new hash alone cannot inherit facts')
  assert.deepEqual(recoverCurrentTaskMutationPaths({ ...amendedInput, history }), ['fixture.txt'], 'accepted additive lineage retains the original effect')

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

test('kernel string replacement custody links its write ledger operation without widening patch ownership', t => {
  const directory = mkdtempSync(join(tmpdir(), 'babel-mutation-witness-tool-compat-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const root = realpathSync.native(directory)
  const projectRoot = join(root, 'project')
  const runDir = join(root, 'runs')
  mkdirSync(projectRoot)
  const hash = (value: string) => createHash('sha256').update(value).digest('hex')
  const path = join(projectRoot, 'math.js')
  writeFileSync(path, 'before')
  const contract = freezeTaskContract(buildTaskContractV1({ mode: 'chat', task_id: 'task:tool-compat', user_request: 'Fix math.js.' }))
  const binding = { task: contract.user_request, task_id: contract.task_id, contract_id: contract.contract_id, contract_hash: contract.contract_hash }
  const log = createSessionEventLog('tool-compat-session')
  recordUserSubmitted(log, { ...binding, turn_id: 'first-turn', attempt_id: 'attempt:first' })
  const dispatch = { turn_id: 'first-turn', tool_call_id: 'same-key', tool_name: 'str_replace', idempotency_key: 'same-key', effect_class: 'reconcilable_mutation' as const }
  recordToolProposed(log, dispatch)
  recordToolStarted(log, dispatch)
  const intent = recordEffectIntent({ runDir, sessionId: log.session_id, turnId: 'first-turn', toolCallId: 'same-key',
    mutationBatchId: 'batch:compat', toolName: 'write_file', effectClass: 'reconcilable_mutation',
    targetPaths: [path], preImageHashes: { [path]: hash('before') }, intendedContent: 'after' })
  writeFileSync(path, 'after')
  recordEffectTerminal(runDir, intent, { status: 'completed', postImageHashes: { [path]: hash('after') } })

  // A same-key operation from another turn without its own canonical start is
  // not allowed to borrow the string-replacement custody.
  const unrelated = join(projectRoot, 'unrelated.txt')
  writeFileSync(unrelated, 'before')
  const unrelatedIntent = recordEffectIntent({ runDir, sessionId: log.session_id, turnId: 'other-turn', toolCallId: 'same-key',
    mutationBatchId: 'batch:unrelated', toolName: 'write_file', effectClass: 'reconcilable_mutation',
    targetPaths: [unrelated], preImageHashes: { [unrelated]: hash('before') }, intendedContent: 'after' })
  writeFileSync(unrelated, 'after')
  recordEffectTerminal(runDir, unrelatedIntent, { status: 'completed', postImageHashes: { [unrelated]: hash('after') } })

  // An apply_patch start must not satisfy the special str_replace/write_file
  // compatibility pair, even when it reuses the same call key.
  const patchPath = join(projectRoot, 'patch.txt')
  writeFileSync(patchPath, 'before')
  recordUserSubmitted(log, { ...binding, turn_id: 'patch-turn', attempt_id: 'attempt:patch' })
  recordToolProposed(log, { ...dispatch, turn_id: 'patch-turn', tool_name: 'apply_patch' })
  recordToolStarted(log, { ...dispatch, turn_id: 'patch-turn', tool_name: 'apply_patch' })
  const patchIntent = recordEffectIntent({ runDir, sessionId: log.session_id, turnId: 'patch-turn', toolCallId: 'same-key',
    mutationBatchId: 'batch:patch', toolName: 'write_file', effectClass: 'reconcilable_mutation',
    targetPaths: [patchPath], preImageHashes: { [patchPath]: hash('before') }, intendedContent: 'after' })
  writeFileSync(patchPath, 'after')
  recordEffectTerminal(runDir, patchIntent, { status: 'completed', postImageHashes: { [patchPath]: hash('after') } })

  recordUserSubmitted(log, { ...binding, turn_id: 'resumed-turn', attempt_id: 'attempt:resumed' })
  assert.deepEqual(recoverCurrentTaskMutationPaths({ log, runDir, projectRoot, turnId: 'resumed-turn', contract }), ['math.js'])
})
