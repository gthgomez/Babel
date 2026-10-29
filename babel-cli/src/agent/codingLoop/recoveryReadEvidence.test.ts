import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyWorkingStateEvent, createWorkingState, formatWorkingStateBlock, recoveryEvidenceKey, restoreWorkingStateSnapshot, type RecoveryCandidateBinding, type RecoveryReadEvidence, type WorkingState } from './workingState.js'
import { admitRecoveryPlan, recoveryObservationId, type ActualRecoveryEdit } from './recoveryPlan.js'
const binding: RecoveryCandidateBinding = { schemaVersion: 2, taskId: 'task', contractHash: 'contract', sessionId: 'session', repositoryIdentity: 'root', workspaceRevision: 'revision', executionContextHash: 'context' }
function fresh(target = 'src/implementation.ts', startLine = 1, endLine = 1, totalLines = 1): RecoveryReadEvidence {
  return { tool: 'read_range', target, failureSignature: 'red', binding, observationDigest: 'same-delivered-bytes', window: { startLine, endLine, totalLines, completeFile: startLine === 1 && endLine === totalLines, byteTruncated: false } }
}
function initial(): WorkingState {
  const state = applyWorkingStateEvent(createWorkingState('repair'), { type: 'verifier', identity: 'npm test', exitCode: 1, summary: 'red' })
  return applyWorkingStateEvent(state, { type: 'recovery_gate', failureSignature: 'red', binding, requiredEvidence: 'inspect', failingTargets: ['test.test.ts'] })
}
const add = (state: WorkingState, provenance: RecoveryReadEvidence): WorkingState => applyWorkingStateEvent(state, { type: 'add_evidence', evidence: provenance.target, discriminating: true, provenance })
test('equal delivered bytes at different windows have different host evidence keys', () => {
  assert.notEqual(recoveryEvidenceKey(fresh('large.ts', 1, 5, 300), 'red'), recoveryEvidenceKey(fresh('large.ts', 201, 205, 300), 'red'))
})
test('read evidence is tied to the host session and execution context', () => {
  assert.notEqual(recoveryEvidenceKey(fresh(), 'red'), recoveryEvidenceKey({ ...fresh(), binding: { ...binding, sessionId: 'other-session' } }, 'red'))
  assert.notEqual(recoveryEvidenceKey(fresh(), 'red'), recoveryEvidenceKey({ ...fresh(), binding: { ...binding, executionContextHash: 'other-context' } }, 'red'))
})
test('fresh source reads are retained after satisfaction without AST or failing-path membership', () => {
  let state = add(initial(), fresh('test.test.ts')); state = add(state, fresh('src/implementation.ts'))
  assert.equal(state.recoveryGate?.readRecords?.length, 2); assert.equal(state.recoveryGate?.observedKeys?.length, 2)
  assert.match(formatWorkingStateBlock(state), /src\/implementation\.ts/)
  assert.match(formatWorkingStateBlock(state), /startLine|lines/)
})
test('each existing mutation target requires its own referenced delivered read', () => {
  let state = add(initial(), fresh('src/a.ts')); state = add(state, fresh('src/b.ts', 201, 205, 300))
  const keys = state.recoveryGate!.observedKeys!
  const actual: ActualRecoveryEdit = { actionFamily: 'apply_patch', targetIdentities: ['src/a.ts', 'src/b.ts'], existingTargetIdentities: ['src/a.ts', 'src/b.ts'], editFingerprint: 'new-edit', exactFingerprint: 'new-exact' }
  const plan = { schemaVersion: 2, recoveryGateRef: state.recoveryGate!.recoveryGateRef, workspaceRevision: 'revision', hypothesisClass: 'logic', targetIdentities: actual.targetIdentities, actionFamily: 'apply_patch', criterionId: 'npm test', supportingObservationIds: keys.map(recoveryObservationId) }
  assert.equal(admitRecoveryPlan(state, { ...plan, supportingObservationIds: [recoveryObservationId(keys[0]!)] }, actual, binding).reason, 'missing_target_read')
  assert.equal(admitRecoveryPlan(state, plan, actual, binding).admitted, true)
})
test('eviction and reread republish a record without restoring permits or progress identity', () => {
  const first = fresh('src/first.ts'); let state = add(initial(), first)
  for (let i = 0; i < 65; i++) state = add(state, fresh(`src/file${i}.ts`))
  assert.equal(state.recoveryGate?.readRecords?.length, 64)
  const consumed = [...state.consumedRecoveryEvidence]
  state = { ...state, recoveryGate: { ...state.recoveryGate!, satisfied: false, permitConsumed: true } }; state = add(state, first)
  assert.ok(state.recoveryGate?.readRecords?.some(record => record.target === first.target)); assert.deepEqual(state.consumedRecoveryEvidence, consumed)
  assert.equal(state.recoveryGate?.satisfied, false); assert.equal(state.recoveryGate?.permitConsumed, true)
})
test('legacy bare keys cannot restore satisfied edit authority', () => {
  const state = initial(); state.recoveryGate = { ...state.recoveryGate!, observedKeys: ['legacy-key'], satisfied: true }
  const restored = restoreWorkingStateSnapshot(state); assert.ok(restored)
  assert.equal(restored.recoveryGate?.satisfied, false); assert.match(formatWorkingStateBlock(restored), /fresh.*read|reread/i)
})

test('legacy recovery bindings retain failure history but cannot restore old read or edit authority', () => {
  let state = add(initial(), fresh())
  const gate = state.recoveryGate!
  const legacyBinding = {
    schemaVersion: 1,
    taskId: binding.taskId,
    contractHash: binding.contractHash,
    repositoryIdentity: binding.repositoryIdentity,
    workspaceRevision: binding.workspaceRevision,
  }
  const legacy = {
    ...state,
    recoveryGate: { ...gate, binding: legacyBinding, satisfied: true, planAdmitted: true,
      readRecords: gate.readRecords!.map(record => ({ ...record, binding: legacyBinding })) },
    localization: { ...state.localization, binding: legacyBinding },
  }
  const restored = restoreWorkingStateSnapshot(legacy)
  assert.ok(restored)
  assert.equal(restored.failureSurface?.errorSignature, state.failureSurface?.errorSignature)
  assert.equal(restored.recoveryGate?.binding, undefined)
  assert.equal(restored.recoveryGate?.satisfied, false)
  assert.equal(restored.recoveryGate?.planAdmitted, false)
  assert.equal(restored.recoveryGate?.readRecords?.length, 0)
  assert.equal(restored.localization, undefined)
})

test('search snippets, untyped records, malformed windows and other owners grant no record', () => {
  for (const altered of [
    { tool: 'grep' }, { window: undefined }, { target: '../outside.ts' },
    { window: { ...fresh().window, startLine: 2, endLine: 1 } },
    { binding: { ...binding, taskId: 'other-task' } },
    { binding: { ...binding, repositoryIdentity: 'other-root' } },
    { binding: { ...binding, workspaceRevision: 'other-revision' } },
    { binding: { ...binding, sessionId: 'other-session' } },
    { binding: { ...binding, executionContextHash: 'other-context' } },
  ]) {
    const state = add(initial(), { ...fresh(), ...altered } as RecoveryReadEvidence)
    assert.equal(state.recoveryGate?.satisfied, false)
    assert.equal(state.recoveryGate?.readRecords?.length, 0)
  }
})

test('same-episode gate events cannot replenish a consumed edit permit', () => {
  let state = add(initial(), fresh())
  state = { ...state, recoveryGate: { ...state.recoveryGate!, permitConsumed: true, satisfied: false } }
  state = applyWorkingStateEvent(state, { type: 'recovery_gate', failureSignature: 'red', binding, requiredEvidence: 'inspect again' })
  state = add(state, fresh())
  assert.equal(state.recoveryGate?.permitConsumed, true)
  assert.equal(state.recoveryGate?.satisfied, false)
})

test('fabricated record contents and ambiguous short handles do not support edits', () => {
  const state = add(add(initial(), fresh('src/a.ts')), fresh('src/b.ts'))
  const records = state.recoveryGate!.readRecords!
  const plan = { schemaVersion: 2, recoveryGateRef: state.recoveryGate!.recoveryGateRef, workspaceRevision: 'revision', hypothesisClass: 'logic',
    targetIdentities: ['src/a.ts'], actionFamily: 'str_replace', criterionId: 'npm test', supportingObservationIds: [records[0]!.id] }
  const actual: ActualRecoveryEdit = { actionFamily: 'str_replace', targetIdentities: ['src/a.ts'], editFingerprint: 'new-edit', exactFingerprint: 'new-exact' }
  const forged = { ...state, recoveryGate: { ...state.recoveryGate!, readRecords: [{ ...records[0]!, target: 'src/elsewhere.ts' }] } }
  assert.equal(admitRecoveryPlan(forged, plan, actual, binding).admitted, false)
  const collision = { ...state, recoveryGate: { ...state.recoveryGate!, readRecords: [records[0]!, { ...records[1]!, id: records[0]!.id }] } }
  assert.equal(admitRecoveryPlan(collision, plan, actual, binding).reason, 'ambiguous_observation')
  assert.equal(restoreWorkingStateSnapshot(forged), null)
})

test('a host-confirmed absent target needs current source evidence, not an impossible read', () => {
  const state = add(initial(), fresh('src/current.ts'))
  const id = state.recoveryGate!.readRecords![0]!.id
  const actual: ActualRecoveryEdit = { actionFamily: 'write_file', targetIdentities: ['src/new.ts'], existingTargetIdentities: [], editFingerprint: 'new-edit', exactFingerprint: 'new-exact' }
  const plan = { schemaVersion: 2, recoveryGateRef: state.recoveryGate!.recoveryGateRef, workspaceRevision: 'revision', hypothesisClass: 'logic',
    targetIdentities: actual.targetIdentities, actionFamily: 'write_file', criterionId: 'npm test', supportingObservationIds: [id] }
  assert.equal(admitRecoveryPlan(state, plan, actual, binding).admitted, true)
  assert.equal(admitRecoveryPlan(state, { ...plan, supportingObservationIds: [] }, actual, binding).admitted, false)
})

test('malformed persisted delivered records fail closed without crashing resume', () => {
  const state = add(initial(), fresh())
  for (const alteration of [{ target: undefined }, { target: 2 }, { tool: null }, { observationDigest: {} }, { window: null }, { key: {} }, { id: null }, { binding: null }]) {
    const malformed = structuredClone(state)
    Object.assign(malformed.recoveryGate!.readRecords![0]!, alteration)
    assert.equal(restoreWorkingStateSnapshot(malformed), null, JSON.stringify(alteration))
  }
})
