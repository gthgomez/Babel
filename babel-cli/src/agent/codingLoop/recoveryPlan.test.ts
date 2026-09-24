import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyWorkingStateEvent, createWorkingState, recordControllerRecoveryStrategy, restoreWorkingStateSnapshot } from './workingState.js'
import { actualRecoveryEdit, admitRecoveryPlan, recoveryObservationId } from './recoveryPlan.js'
import { createSessionEventLog, parseSessionEventLog, recordWorkingStateSnapshot, serializeSessionEventLog } from '../sessionEvents.js'
import { ChatToolActionSchema, buildChatToolDefinitions } from '../chatToolDefinitions.js'
import { parseTextToolTurn } from '../textToolParser.js'

const binding = {
  schemaVersion: 1 as const, taskId: 'task', contractHash: 'contract',
  repositoryIdentity: '/repo', workspaceRevision: 'revision-A',
}

function readyState() {
  let state = applyWorkingStateEvent(createWorkingState('repair parser'), {
    type: 'mutation', path: 'src/parser.ts', fingerprint: 'failed-exact',
    canonicalFingerprint: 'failed-canonical',
  })
  state = applyWorkingStateEvent(state, {
    type: 'verifier', identity: 'npm test', exitCode: 1, summary: 'parser red',
  })
  state = applyWorkingStateEvent(state, {
    type: 'recovery_gate', failureSignature: 'parser-red', requiredEvidence: 'inspect parser',
    failingTargets: ['src/parser.ts'], binding,
    mutationFingerprint: 'failed-exact',
  })
  state = applyWorkingStateEvent(state, {
    type: 'add_evidence', evidence: 'read_file:src/parser.ts#call-1', discriminating: true,
    provenance: {
      tool: 'read_file', target: 'src/parser.ts', failureSignature: 'parser-red',
      binding, observationDigest: 'parser-content',
    },
  })
  return state
}

function proposal(state = readyState()) {
  return {
    schemaVersion: 1 as const,
    failureSignature: 'parser-red', workspaceRevision: 'revision-A',
    hypothesisClass: 'logic' as const,
    targetIdentities: ['src/parser.ts'], actionFamily: 'str_replace' as const,
    criterionId: 'npm test',
    supportingObservationIds: state.recoveryGate!.observedKeys!.map(recoveryObservationId),
  }
}

const changedEdit = { actionFamily: 'str_replace' as const, targetIdentities: ['src/parser.ts'], editFingerprint: 'changed-canonical', exactFingerprint: 'changed-exact' }

test('an inspection and changed hypothesis text do not admit a repair', () => {
  let state = readyState()
  assert.equal(state.recoveryGate?.satisfied, true)
  state = recordControllerRecoveryStrategy(state, { target: 'src/parser.ts', evidence: 'read_file:src/parser.ts' })
  state = applyWorkingStateEvent(state, { type: 'set_hypothesis', hypothesis: 'a different explanation' })
  assert.equal(state.recoveryGate?.planAdmitted, false)
  assert.equal(state.recoveryGate?.strategyChanged, false)
})

test('controller admits only a scoped plan backed by the observed candidate', () => {
  const state = readyState()
  const valid = admitRecoveryPlan(state, proposal(state), changedEdit, binding)
  assert.equal(valid.admitted, true)
  assert.equal(valid.state.recoveryGate?.planAdmitted, true)
  assert.equal(valid.state.recoveryGate?.admittedPlan?.editFingerprint, 'changed-canonical')
  for (const altered of [
    { workspaceRevision: 'revision-B' },
    { failureSignature: 'other-red' },
    { targetIdentities: ['src/other.ts'] },
    { criterionId: 'different test' },
    { supportingObservationIds: ['invented'] },
    { actionFamily: 'write_file' },
  ]) {
    const denied = admitRecoveryPlan(state, { ...proposal(state), ...altered } as ReturnType<typeof proposal>, changedEdit, binding)
    assert.equal(denied.admitted, false, JSON.stringify(altered))
  }
})

test('same edit and changed prose cannot reopen the failed strategy', () => {
  const state = readyState()
  assert.equal(admitRecoveryPlan(state, proposal(state), {
    ...changedEdit, editFingerprint: 'failed-canonical', exactFingerprint: 'failed-exact',
  }, binding).admitted, false)
  assert.equal(admitRecoveryPlan(state, { ...proposal(state), hypothesisClass: 'data_flow' }, {
    ...changedEdit, editFingerprint: 'failed-canonical', exactFingerprint: 'failed-exact',
  }, binding).admitted, false)
})

test('admitted repair is single-use and a later candidate cannot replay it', () => {
  const state = readyState()
  const admitted = admitRecoveryPlan(state, proposal(state), changedEdit, binding)
  assert.equal(admitted.admitted, true)
  const consumed = applyWorkingStateEvent(admitted.state, { type: 'recovery_plan_consumed' })
  assert.equal(consumed.recoveryGate?.planAdmitted, false)
  assert.equal(admitRecoveryPlan(consumed, proposal(state), changedEdit, binding).admitted, false)
  const drifted = applyWorkingStateEvent(admitted.state, { type: 'recovery_candidate_drift' })
  assert.equal(admitRecoveryPlan(drifted, proposal(state), changedEdit, { ...binding, workspaceRevision: 'revision-B' }).admitted, false)
})

test('a proven no-effect repair grants one new admission without replaying the old permit', () => {
  const initial = readyState()
  const first = admitRecoveryPlan(initial, proposal(initial), changedEdit, binding)
  assert.equal(first.admitted, true)
  const consumed = applyWorkingStateEvent(first.state, { type: 'recovery_plan_consumed' })
  const corrected = { ...changedEdit, editFingerprint: 'corrected-v2', exactFingerprint: 'corrected-exact' }
  assert.equal(admitRecoveryPlan(consumed, proposal(initial), corrected, binding).admitted, false)
  const noEffect = applyWorkingStateEvent(consumed, {
    type: 'recovery_proven_no_effect', fingerprint: changedEdit.exactFingerprint,
  })
  assert.equal(admitRecoveryPlan(noEffect, proposal(initial), changedEdit, binding).admitted, false)
  const second = admitRecoveryPlan(noEffect, proposal(initial), corrected, binding)
  assert.equal(second.admitted, true)
  const spent = applyWorkingStateEvent(second.state, { type: 'recovery_plan_consumed' })
  const bounded = applyWorkingStateEvent(spent, {
    type: 'recovery_proven_no_effect', fingerprint: corrected.exactFingerprint,
  })
  assert.equal(admitRecoveryPlan(bounded, proposal(initial), {
    ...corrected, editFingerprint: 'third-v2', exactFingerprint: 'third-exact',
  }, binding).admitted, false)
})

test('edit identity preserves significant newlines, whitespace, and per-file patch association', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-recovery-plan-'))
  try {
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src', 'parser.ts'), 'export const value = 1\n')
    writeFileSync(join(root, 'src', 'other.ts'), 'export const value = 1\n')
    const base = actualRecoveryEdit({
      type: 'str_replace', file_path: 'src/parser.ts', old_str: 'value = 1', new_str: 'value = 2',
    }, root)
    const commentOnly = actualRecoveryEdit({
      type: 'str_replace', file_path: './src/parser.ts', old_str: 'value = 1',
      new_str: 'value  =  2 // another explanation',
    }, root)
    const changed = actualRecoveryEdit({
      type: 'str_replace', file_path: 'src/parser.ts', old_str: 'value = 1', new_str: 'value = 3',
    }, root)
    assert.ok(base && commentOnly && changed)
    assert.notEqual(base.editFingerprint, commentOnly.editFingerprint)
    assert.notEqual(base.exactFingerprint, commentOnly.exactFingerprint)
    assert.notEqual(base.editFingerprint, changed.editFingerprint)

    const newlineA = actualRecoveryEdit({ type: 'write_file', path: 'src/parser.ts', content: 'function f(){return\n{ok:true};}' }, root)
    const newlineB = actualRecoveryEdit({ type: 'write_file', path: 'src/parser.ts', content: 'function f(){return {ok:true};}' }, root)
    assert.ok(newlineA && newlineB)
    assert.notEqual(newlineA.editFingerprint, newlineB.editFingerprint)
    assert.equal(new Function('function f(){return\n{ok:true};} return f()')(), undefined)
    assert.deepEqual(new Function('function f(){return {ok:true};} return f()')(), { ok: true })

    const patch = (file: string, value: number) => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-value = 0\n+value = ${value}\n`
    const patchA = patch('src/parser.ts', 1) + patch('src/other.ts', 2)
    const patchB = patch('src/parser.ts', 2) + patch('src/other.ts', 1)
    assert.notEqual(
      actualRecoveryEdit({ type: 'apply_patch', patch: patchA }, root)?.editFingerprint,
      actualRecoveryEdit({ type: 'apply_patch', patch: patchB }, root)?.editFingerprint,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a new bound observation admits a distinct second repair in the same class, file, and criterion', () => {
  const firstState = readyState()
  const first = admitRecoveryPlan(firstState, proposal(firstState), changedEdit, binding)
  assert.equal(first.admitted, true)
  let state = applyWorkingStateEvent(first.state, { type: 'recovery_plan_consumed' })
  assert.equal(admitRecoveryPlan(state, proposal(firstState), changedEdit, binding).admitted, false)
  state = applyWorkingStateEvent(state, {
    type: 'mutation', path: 'src/parser.ts', fingerprint: changedEdit.exactFingerprint,
    canonicalFingerprint: changedEdit.editFingerprint,
  })
  state = applyWorkingStateEvent(state, { type: 'verifier', identity: 'npm test', exitCode: 1, summary: 'still red' })
  const nextBinding = { ...binding, workspaceRevision: 'revision-B' }
  state = applyWorkingStateEvent(state, {
    type: 'recovery_gate', failureSignature: 'parser-still-red', requiredEvidence: 'inspect parser again',
    failingTargets: ['src/parser.ts'], binding: nextBinding, mutationFingerprint: changedEdit.exactFingerprint,
  })
  const stale = admitRecoveryPlan(state, proposal(firstState), {
    ...changedEdit, editFingerprint: 'second-canonical', exactFingerprint: 'second-exact',
  }, nextBinding)
  assert.equal(stale.admitted, false)
  state = applyWorkingStateEvent(state, {
    type: 'add_evidence', evidence: 'read_file:src/parser.ts#call-2', discriminating: true,
    provenance: {
      tool: 'read_file', target: 'src/parser.ts', failureSignature: 'parser-still-red',
      binding: nextBinding, observationDigest: 'new-discriminating-content',
    },
  })
  const secondProposal = {
    ...proposal(state), failureSignature: 'parser-still-red', workspaceRevision: 'revision-B',
  }
  const secondEdit = { ...changedEdit, editFingerprint: 'second-canonical', exactFingerprint: 'second-exact' }
  assert.equal(admitRecoveryPlan(state, secondProposal, changedEdit, nextBinding).admitted, false, 'same edit remains blocked')
  const second = admitRecoveryPlan(state, secondProposal, secondEdit, nextBinding)
  assert.equal(second.admitted, true)
  state = applyWorkingStateEvent(second.state, { type: 'recovery_plan_consumed' })
  state = applyWorkingStateEvent(state, {
    type: 'mutation', path: 'src/parser.ts', fingerprint: secondEdit.exactFingerprint,
    canonicalFingerprint: secondEdit.editFingerprint,
  })
  state = applyWorkingStateEvent(state, { type: 'verifier', identity: 'npm test', exitCode: 0, summary: 'green' })
  assert.equal(state.lastVerifier?.exitCode, 0)
  assert.equal(state.recoveryGate, undefined)
})

test('a resumed legacy lossy fingerprint cannot veto a literal CRLF repair', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-pr242-legacy-repair-'))
  try {
    const lf = actualRecoveryEdit({ type: 'write_file', path: 'src/parser.ts', content: 'a\nb\n' }, root)
    const crlf = actualRecoveryEdit({ type: 'write_file', path: 'src/parser.ts', content: 'a\r\nb\r\n' }, root)
    assert.ok(lf && crlf)
    const snapshot = readyState()
    snapshot.lastMutation = { path: 'src/parser.ts', at: 1,
      canonicalFingerprint: lf.editFingerprint.slice(3), fingerprint: 'old-exact' }
    snapshot.recoveryGate!.mutationFingerprint = 'old-exact'
    const restored = restoreWorkingStateSnapshot(snapshot)
    assert.ok(restored)
    const plan = { ...proposal(restored), actionFamily: 'write_file' as const }
    assert.equal(admitRecoveryPlan(restored, plan, crlf, binding).admitted, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('native and text tool paths carry a repair plan to the controller', () => {
  const state = readyState()
  const repairPlan = proposal(state)
  const action = {
    type: 'str_replace', file_path: 'src/parser.ts', old_str: 'value = 1',
    new_str: 'value = 2', repair_plan: repairPlan,
  }
  assert.equal(ChatToolActionSchema.safeParse(action).success, true)
  const native = buildChatToolDefinitions().find((tool) => tool.function.name === 'str_replace')
  assert.ok(native)
  assert.ok('repair_plan' in (native.function.parameters as { properties: Record<string, unknown> }).properties)
  const textTurn = parseTextToolTurn(`[TOOL:str_replace]\nfile_path: src/parser.ts\nold_str: value = 1\nnew_str: value = 2\nrepair_plan: ${JSON.stringify(repairPlan)}`)
  assert.equal(textTurn.type, 'tool_calls')
  if (textTurn.type === 'tool_calls') {
    assert.equal(textTurn.actions[0]?.type, 'str_replace')
    assert.deepEqual((textTurn.actions[0] as typeof action).repair_plan, repairPlan)
  }
})

test('versioned session snapshot preserves the consumed ledger and downgrades legacy permits', () => {
  const state = readyState()
  const log = createSessionEventLog('recovery-plan-snapshot')
  recordWorkingStateSnapshot(log, state, 'turn-1')
  const restoredLog = parseSessionEventLog(serializeSessionEventLog(log), 'recovery-plan-snapshot')
  const event = restoredLog.events.at(-1)
  assert.equal(event?.kind, 'working_state_snapshot')
  if (event?.kind !== 'working_state_snapshot') return
  const restored = restoreWorkingStateSnapshot(event.state)
  assert.equal(restored?.recoveryGate?.satisfied, true)
  assert.deepEqual(restored?.consumedRecoveryEvidence, state.consumedRecoveryEvidence)
  assert.equal(restored?.recoveryGate?.planAdmitted, false)

  const legacy = structuredClone(state)
  delete legacy.recoveryGate!.binding
  legacy.recoveryGate!.satisfied = true
  legacy.recoveryGate!.planAdmitted = true
  const downgraded = restoreWorkingStateSnapshot(legacy)
  assert.equal(downgraded?.recoveryGate?.satisfied, false)
  assert.equal(downgraded?.recoveryGate?.planAdmitted, false)
})
