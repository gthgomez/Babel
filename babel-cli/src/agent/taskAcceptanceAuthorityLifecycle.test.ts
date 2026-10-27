import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { sha256Canonical } from '../acceptance/canonical.js'
import { bindExecutableVerifiersToTaskAcceptance } from './taskAcceptanceExecutableBinding.js'
import { createParityRuntime } from './chatEngineParityBridge.js'
import {
  prepareEngineInstructionAuthority,
  refreshEngineInstructionManifest,
} from './chatEngineLiveSession.js'
import {
  loadLiveSessionAuthorityStrict,
  persistLiveSessionAuthority,
  resolveLiveSessionAuthority,
} from './liveSessionBridge.js'
import { buildTaskContractV1, freezeTaskContract } from './taskContract.js'
import { inferTaskAcceptanceV1 } from './taskAcceptanceMeaning.js'
import {
  createTaskAcceptanceRevision,
  validateTaskAcceptanceRevision,
} from './taskAcceptanceRevision.js'

function freezeV1AdmissionContract(task: string) {
  const meaning = bindExecutableVerifiersToTaskAcceptance({
    meaning: inferTaskAcceptanceV1(task),
    trustedVerifierCommands: [],
    defaultWorkingDirectory: '.',
  })
  return freezeTaskContract(buildTaskContractV1({
    mode: 'chat',
    user_request: task,
    acceptance: meaning.criteria,
    provenance: meaning.provenance,
    source: 'taskAcceptanceAuthorityLifecycle.test',
  }))
}

const refreshContext = (runtime: ReturnType<typeof createParityRuntime>, root: string, task: string) => ({
  parity: runtime,
  options: { projectRoot: root, task },
  taskClass: 'general_swe',
  executionProfile: 'chat',
  engineRunDir: root,
})

test('refresh retains frozen v1 acceptance while the builder alone would emit v2', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-acceptance-lifecycle-'))
  const task = 'Fix it'
  try {
    const runtime = createParityRuntime('v1-retain-refresh')
    const v1Contract = freezeV1AdmissionContract(task)
    const shell = resolveLiveSessionAuthority({ mode: 'chat', projectRoot: root, task })
    runtime.liveAuthority = { ...shell, taskContract: v1Contract }
    persistLiveSessionAuthority(root, runtime.liveAuthority)

    const resolved = prepareEngineInstructionAuthority(refreshContext(runtime, root, task))
    assert.ok(
      resolved.taskContract.provenance.records.some(record => record.ref.startsWith('task-acceptance-meaning:v2:')),
      'resolveLiveSessionAuthority is a fresh builder; its contract is not adopted on refresh',
    )

    refreshEngineInstructionManifest(refreshContext(runtime, root, task))
    const retained = runtime.liveAuthority!.taskContract
    assert.equal(retained.contract_id, v1Contract.contract_id)
    assert.deepEqual(retained.acceptance_criteria, v1Contract.acceptance_criteria)
    assert.ok(retained.provenance.records.some(record => record.ref.startsWith('task-acceptance-meaning:v1:')))
    assert.equal(retained.provenance.records.some(record => record.ref.startsWith('task-acceptance-meaning:v2:')), false)

    const cold = loadLiveSessionAuthorityStrict(root)
    assert.deepEqual(cold.taskContract.acceptance_criteria, v1Contract.acceptance_criteria)
    assert.equal(cold.taskContract.contract_id, v1Contract.contract_id)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('forged v2 target provenance cannot pick its own validating interpreter for a v1 predecessor', () => {
  const previous = freezeV1AdmissionContract([
    'Update fixture behavior.',
    'Acceptance criteria:',
    '- Preserve the existing API.',
  ].join('\n'))
  const addition = 'Also require:\n- The task survives restart.'
  const inputDigest = sha256Canonical({ task: addition, requestedOperation: 'AUTO', requestedTaskIntent: null, requestedContinueTask: false })
  const revision = createTaskAcceptanceRevision(previous, {
    userInput: addition,
    inputDigest,
    attemptId: randomUUID(),
  })
  assert.ok(revision)
  const { contract: current, descriptor } = revision!
  const forgedRecords = current.provenance.records.map(record =>
    record.kind === 'derived_acceptance' && record.ref.startsWith('task-acceptance-meaning:v1:')
      ? { ...record, ref: record.ref.replace('task-acceptance-meaning:v1:', 'task-acceptance-meaning:v2:') }
      : record,
  )
  const forged = freezeTaskContract(buildTaskContractV1({
    ...current,
    provenance: forgedRecords,
    source: current.provenance.source,
    parent_contract_id: previous.contract_id,
    failure_class_budgets: current.budgets.failure_class_budgets,
  }))
  const errors = validateTaskAcceptanceRevision(previous, forged, descriptor)
  assert.ok(errors.includes('interpretation_version') || errors.includes('provenance'))
})
