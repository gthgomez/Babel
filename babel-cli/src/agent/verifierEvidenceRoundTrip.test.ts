import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { captureAndRecordVerifierReceipt, restorePersistedVerifierEvidence, upsertVerifierReceipt } from './chatEngineVerifierAdapter.js'
import { toExecutorVerifierReceipt, type BoundChatVerifierReceipt } from '../evidence/chatRevisionBinding.js'
import { createSessionEventLog, parseSessionEventLog, serializeSessionEventLog } from './sessionEvents.js'

const owner = { workspaceRoot: '/project', taskId: 'task', contractHash: 'contract', sessionId: 'session' }

test('capture publishes durable order and actual environment through adaptation and JSONL restore', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-verifier-roundtrip-'))
  try {
    writeFileSync(join(root, 'value.ts'), 'export const value = 1\n')
    const boundOwner = { ...owner, workspaceRoot: realpathSync.native(root) }
    const log = createSessionEventLog('session')
    const ledger: BoundChatVerifierReceipt[] = []
    const cache = new Map()
    const receipt = await captureAndRecordVerifierReceipt({
      projectRoot: root, command: 'node --test', exitCode: 0, summary: 'executed', stdout: '# tests 1\n# skipped 0',
      mutationPaths: ['value.ts'], sessionEvents: log, turnId: 'turn', ledger, cache, writeCount: 1,
      cacheIdentity: { key: 'cache', cwd: realpathSync.native(root), envKey: 'frozen-real-environment' }, verifierOwner: boundOwner,
    })
    assert.ok(receipt)
    assert.equal(receipt.environment_policy, 'host-process')
    assert.equal(receipt.executionContext?.environmentFingerprint, 'frozen-real-environment')
    const { chatReceiptDispatchesToRequirement } = await import('../authority/criterionVerifierDispatch.js')
    const { sha256Canonical } = await import('../acceptance/canonical.js')
    const requirement = { id: 'native-test', description: 'The native tests pass.', type: 'unit_test' as const,
      required: true, verification_strategy: 'Run the frozen native check.', verification: {
        kind: 'unit_test' as const, verifier_id: 'verifier:node', executable_id: 'node', argv: ['--test'],
        command_hash: sha256Canonical({ executable_id: 'node', argv: ['--test'] }),
        working_directory: '.', environment_policy: 'host-process',
      } }
    assert.equal(chatReceiptDispatchesToRequirement(receipt, requirement), true)
    assert.equal(chatReceiptDispatchesToRequirement({ ...receipt, environment_policy: 'other-policy' }, requirement), false)

    assert.deepEqual(receipt.order, { sessionId: 'session', seq: 0 })
    assert.strictEqual(ledger[0], receipt)
    assert.strictEqual(cache.get('cache').receipt, receipt)
    const event = log.events[0]!
    assert.equal(event.kind, 'verifier_attempt')
    if (event.kind === 'verifier_attempt') assert.equal(event.receipt?.order, undefined, 'stored receipt is immutable; order belongs to event wrapper')
    const adapted = toExecutorVerifierReceipt(receipt)
    assert.equal(adapted.ok, true)
    if (adapted.ok) {
      assert.deepEqual(adapted.receipt.executionContext, receipt.executionContext)
      assert.deepEqual(adapted.receipt.order, receipt.order)
      assert.equal(adapted.receipt.working_directory, receipt.working_directory)
      assert.equal(adapted.receipt.environment_policy, receipt.environment_policy)
      assert.deepEqual(adapted.receipt.argv, receipt.argv)
    }
    const restoredLedger: BoundChatVerifierReceipt[] = []
    const restored = restorePersistedVerifierEvidence(parseSessionEventLog(serializeSessionEventLog(log)), restoredLedger, boundOwner)
    assert.deepEqual(restored, JSON.parse(JSON.stringify(receipt)))
    assert.equal(restorePersistedVerifierEvidence(log, [], { ...boundOwner, taskId: 'other' }), null)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('publication ownership rejection earns neither a durable attempt nor cache credit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-verifier-unpublished-'))
  try {
    writeFileSync(join(root, 'value.ts'), 'v1')
    const log = createSessionEventLog('session')
    const ledger: BoundChatVerifierReceipt[] = []
    const cache = new Map()
    const result = await captureAndRecordVerifierReceipt({
      projectRoot: root, command: 'node --test', exitCode: 0, summary: 'executed', mutationPaths: ['value.ts'],
      sessionEvents: log, turnId: 'turn', ledger, cache, writeCount: 1, canPublish: () => false,
    })
    assert.equal(result, null)
    assert.equal(log.events.length, 0)
    assert.equal(ledger.length, 0)
    assert.equal(cache.size, 0)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('upsert preserves attempt history and separates execution contexts', () => {
  const receipt = (seq: number, env = 'one'): BoundChatVerifierReceipt => ({
    command: 'node --test', exit_code: 0, summary: 'executed', order: { sessionId: 'session', seq },
    executionContext: { workspaceRoot: '/project', taskId: 'task', contractHash: 'contract', workingDirectory: '/project', environmentFingerprint: env, targetSelectors: [] },
  })
  const ledger: BoundChatVerifierReceipt[] = []
  upsertVerifierReceipt(ledger, receipt(3))
  upsertVerifierReceipt(ledger, receipt(1))
  upsertVerifierReceipt(ledger, receipt(2, 'two'))
  assert.equal(ledger.length, 3)
  assert.equal(ledger[0]?.order?.seq, 3)
  upsertVerifierReceipt(ledger, receipt(3))
  assert.equal(ledger.length, 3, 'repeated projection of one event is idempotent')
})

test('each physical attempt has its own receipt identity even with tied host timestamps', async () => {
  const { mock } = await import('node:test')
  const root = mkdtempSync(join(tmpdir(), 'babel-verifier-attempt-'))
  const clock = mock.method(Date, 'now', () => 1000)
  try {
    writeFileSync(join(root, 'value.ts'), 'v1')
    const log = createSessionEventLog('session')
    const input = { projectRoot: root, command: 'node --test', exitCode: 0, summary: 'green', mutationPaths: ['value.ts'], sessionEvents: log, turnId: 'turn', ledger: [], cache: new Map(), writeCount: 1 }
    const first = await captureAndRecordVerifierReceipt(input)
    const second = await captureAndRecordVerifierReceipt(input)
    assert.ok(first && second)
    assert.notEqual(first.receiptId, second.receiptId)
    assert.notEqual(first.order?.seq, second.order?.seq)
  } finally { clock.mock.restore(); rmSync(root, { recursive: true, force: true }) }
})

test('unknown environment relevance cannot reuse proof across differing host variables', async () => {
  const { verifierEnvironmentKey } = await import('./chatEngineVerifierAdapter.js')
  assert.notEqual(verifierEnvironmentKey({ PATH: '/bin', CUSTOM_TEST_MODE: 'red' }),
    verifierEnvironmentKey({ PATH: '/bin', CUSTOM_TEST_MODE: 'green' }))
})

test('environment serialization cannot alias embedded separators with separate variables', async () => {
  const { verifierEnvironmentKey } = await import('./chatEngineVerifierAdapter.js')
  assert.notEqual(verifierEnvironmentKey({ A: 'x\nB=y' }), verifierEnvironmentKey({ A: 'x', B: 'y' }))
})

test('canonical adaptation preserves independent historical integrity evidence', async () => {
  const { prepareKernelVerifierInput } = await import('./chatEngineVerifierAdapter.js')
  const { evaluateCompletionGateForEngine } = await import('./completionGatePolicy.js')
  const root = mkdtempSync(join(tmpdir(), 'babel-verifier-integrity-'))
  try {
    writeFileSync(join(root, 'value.ts'), 'v1')
    const log = createSessionEventLog('session')
    const ledger: BoundChatVerifierReceipt[] = []
    const boundOwner = { ...owner, workspaceRoot: realpathSync.native(root) }
    const input = { projectRoot: root, command: 'node --test', exitCode: 0, summary: 'green', stdout: '# tests 1\n# skipped 0', mutationPaths: ['value.ts'], sessionEvents: log, turnId: 'turn', ledger, cache: new Map(), writeCount: 1, verifierOwner: boundOwner }
    const old = await captureAndRecordVerifierReceipt({ ...input, exitCode: 1, summary: 'VERIFIER_DEF_TAMPERED' })
    const current = await captureAndRecordVerifierReceipt(input)
    assert.ok(old && current)
    old.stale = true
    assert.equal(ledger.length, 2, 'a later same-slot green must retain independent integrity history')
    const adapted = prepareKernelVerifierInput(current, ledger)
    assert.equal(adapted.verifierEvidenceErrors.length, 0)
    assert.equal(evaluateCompletionGateForEngine({
      taskClass: 'general_swe', task: 'Fix and run tests before completing', turnType: 'completion', taskIntent: 'execute',
      toolCallLog: [{ tool: 'write_file', target: 'value.ts', effect_status: 'confirmed_change' }], lastVerifierReceipt: null,
      executedVerifierLedger: adapted.executedVerifierLedger, requiredVerifierCommands: ['node --test'],
      requiredVerifiers: [{ command: 'node --test', executionContext: current.executionContext!, requiredScope: 'full_suite', greenRequired: true }],
      verifierOwner: boundOwner, currentWorkspaceRevisionHash: current.boundRevision!.compositeTreeHash,
    }), 'reject')
    // A corrupt later current red is retained so its adaptation error cannot vanish on restore.
    const event = log.events[1]!
    if (event.kind === 'verifier_attempt' && event.receipt) event.receipt.receiptId = ''
    const restored: BoundChatVerifierReceipt[] = []
    restorePersistedVerifierEvidence(log, restored, boundOwner)
    assert.equal(prepareKernelVerifierInput(null, restored).verifierEvidenceErrors.length > 0, true)
    if (event.kind === 'verifier_attempt' && event.receipt) {
      for (const invalidContext of [undefined, null, { taskId: 'task' }]) {
        Object.defineProperty(event.receipt, 'executionContext', { value: invalidContext, configurable: true, writable: true, enumerable: true })
        const unknownContextLedger: BoundChatVerifierReceipt[] = []
        restorePersistedVerifierEvidence(log, unknownContextLedger, boundOwner)
        assert.equal(unknownContextLedger.length, 2, 'unknown current owner evidence cannot vanish as historical evidence')
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})
