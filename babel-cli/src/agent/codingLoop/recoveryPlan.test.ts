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

test('canonical edit identity ignores plan prose, formatting, comments, and patch hunk order', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-recovery-plan-'))
  try {
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src', 'parser.ts'), 'export const value = 1\n')
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
    assert.equal(base.editFingerprint, commentOnly.editFingerprint)
    assert.notEqual(base.exactFingerprint, commentOnly.exactFingerprint)
    assert.notEqual(base.editFingerprint, changed.editFingerprint)

    const patchA = 'diff --git a/src/parser.ts b/src/parser.ts\n--- a/src/parser.ts\n+++ b/src/parser.ts\n@@ -1 +1 @@\n-value = 1\n+value = 2\n@@ -3 +3 @@\n-old = true\n+old = false\n'
    const patchB = 'diff --git a/src/parser.ts b/src/parser.ts\n--- a/src/parser.ts\n+++ b/src/parser.ts\n@@ -3 +3 @@\n-old = true\n+old = false\n@@ -1 +1 @@\n-value = 1\n+value = 2\n'
    assert.equal(
      actualRecoveryEdit({ type: 'apply_patch', patch: patchA }, root)?.editFingerprint,
      actualRecoveryEdit({ type: 'apply_patch', patch: patchB }, root)?.editFingerprint,
    )
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
