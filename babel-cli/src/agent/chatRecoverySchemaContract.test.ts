import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildChatToolDefinitions } from './chatToolDefinitions.js'
import { RecoveryPlanProposalSchema } from './codingLoop/recoveryPlan.js'
import { applyWorkingStateEvent, createWorkingState, formatWorkingStateBlock } from './codingLoop/workingState.js'

test('native recovery proposals advertise the same evidence and scope boundaries the controller validates', () => {
  const proposal = {
    schemaVersion: 1, failureSignature: 'failure', workspaceRevision: 'revision',
    hypothesisClass: 'logic', targetIdentities: ['example.js'], actionFamily: 'str_replace',
    criterionId: 'npm test', supportingObservationIds: ['0123456789abcdef'],
  }
  assert.equal(RecoveryPlanProposalSchema.safeParse(proposal).success, true)
  for (const name of ['write_file', 'str_replace', 'apply_patch']) {
    const tool = buildChatToolDefinitions().find(tool => tool.function.name === name)
    assert.ok(tool)
    const properties = tool.function.parameters.properties as Record<string, {
      properties?: Record<string, { description?: string; minItems?: number; maxItems?: number; items?: { minLength?: number; maxLength?: number } }>
    }>
    const plan = properties.repair_plan?.properties
    assert.ok(plan)
    assert.deepEqual([plan.supportingObservationIds?.minItems, plan.supportingObservationIds?.maxItems], [1, 8])
    assert.deepEqual([plan.supportingObservationIds?.items?.minLength, plan.supportingObservationIds?.items?.maxLength], [16, 16])
    assert.deepEqual([plan.targetIdentities?.minItems, plan.targetIdentities?.maxItems], [1, 4])
    assert.match(plan.criterionId?.description ?? '', /exact verifier command/)
  }
  for (const length of [0, 15, 17])
    assert.equal(RecoveryPlanProposalSchema.safeParse({ ...proposal, supportingObservationIds: ['a'.repeat(length)] }).success, false)
  for (const count of [0, 9])
    assert.equal(RecoveryPlanProposalSchema.safeParse({ ...proposal, supportingObservationIds: Array(count).fill('0123456789abcdef') }).success, false)
})

test('empty recovery evidence directs inspection instead of inventing observation references', () => {
  const state = applyWorkingStateEvent(createWorkingState('repair implementation'), {
    type: 'recovery_gate', failureSignature: 'test-red', requiredEvidence: 'inspect the failing assertion',
    failingTargets: ['example.test.js'],
  })
  const context = formatWorkingStateBlock(state)
  assert.match(context, /recovery_observation_keys: \[\]/)
  assert.match(context, /No admissible observation IDs exist yet/)
  assert.match(context, /reread the failing assertion and relevant source after the failed verifier/)
})

test('recovery context names the exact verifier criterion separately from its assertion label', () => {
  let state=applyWorkingStateEvent(createWorkingState('repair'),{type:'verifier',identity:'npm test',exitCode:1,summary:'addition failed'})
  state=applyWorkingStateEvent(state,{type:'recovery_gate',failureSignature:'addition',requiredEvidence:'inspect'})
  assert.match(formatWorkingStateBlock(state),/recovery_criterion_id: "npm test"/)
})

test('recovery observation schema explains controller-owned bounded references', () => {
  assert.match(RecoveryPlanProposalSchema.shape.supportingObservationIds.description ?? '', /exact 16-character/)
  assert.match(RecoveryPlanProposalSchema.shape.supportingObservationIds.description ?? '', /recovery_observation_keys/)
})
