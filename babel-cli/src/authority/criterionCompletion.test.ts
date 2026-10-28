import { kernelVerifierFixture } from '../testinfra/kernelVerifierFixture.js'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { buildTaskContractV1, freezeTaskContract } from '../agent/taskContract.js'
import { createExecutorKernel } from '../executor/kernel.js'
import {
  createCriterionCompletionServiceV1, evaluateCriterionCompletionV1,
  type CriterionCompletionOwnerV1, type CriterionCompletionRequestV1,
} from './criterionCompletion.js'

function contract() {
  return freezeTaskContract(buildTaskContractV1({
    mode: 'chat', user_request: 'Produce the required fixture output.',
    acceptance: [{ id: 'output', description: 'The output matches the required value.',
      type: 'custom', required: true, verification_strategy: 'Independent output evidence.',
      verification: { kind: 'custom', verifier_id: 'fixture:output' } }],
  }))
}
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'babel-criterion-context-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const owner: CriterionCompletionOwnerV1 = { contract: contract(), runId: 'fixture-run', projectRoot: root }
  const service = createCriterionCompletionServiceV1(() => owner)
  const request: CriterionCompletionRequestV1 = {
    context: service.context, contract: owner.contract!, run_id: owner.runId, project_root: root,
  }
  return { root, owner, service, request }
}

test('an owned context reports required criteria missing without trusted executions', t => {
  const { request } = fixture(t)
  const result = evaluateCriterionCompletionV1(request)
  assert.equal(result.status, 'UNVERIFIED')
  assert.equal(result.verified, false)
  assert.deepEqual(result.missing_requirements, ['output'])
  assert.deepEqual(result.satisfied_requirements, [])
})

test('a serialized context cannot retain parent-process authority', t => {
  const { request } = fixture(t)
  const result = evaluateCriterionCompletionV1({ ...request, context: JSON.parse(JSON.stringify(request.context)) })
  assert.equal(result.verified, false)
  assert.deepEqual(result.errors, ['acceptance_context_untrusted'])
})

test('caller-made pass callbacks are never invoked by the kernel', t => {
  const { request } = fixture(t)
  let called = false
  const forged = { ...request.context, evaluate: () => { called = true; return { verified: true } } }
  const result = createExecutorKernel('chat').completion.decide({
    mode: 'chat', requestedOutcome: 'VERIFIED_COMPLETE', hasWrite: true,
    verificationPolicy: 'none', toolCallLog: [], proof: { compliant: true },
    acceptance: { ...request, context: forged },
  })
  assert.equal(result.allowed, false)
  assert.equal(result.finalOutcome, 'UNVERIFIED_PATCH')
  assert.equal(called, false)
})

test('a current owned context cannot turn coarse proof into criterion evidence', t => {
  const { request } = fixture(t)
  const result = createExecutorKernel('deep').completion.decide({
    ...kernelVerifierFixture(),
    mode: 'deep', requestedOutcome: 'VERIFIED_COMPLETE', hasWrite: true,
    verificationPolicy: 'none', toolCallLog: [], proof: { compliant: true }, acceptance: request,
  })
  assert.equal(result.allowed, false)
  assert.equal(result.reason, 'completion_downgraded:acceptance_unverified')
})

test('a replaced accepted head cannot be evaluated through its predecessor request', t => {
  const { owner, request } = fixture(t)
  owner.contract = contract()
  const result = evaluateCriterionCompletionV1(request)
  assert.equal(result.verified, false)
  assert.deepEqual(result.errors, ['acceptance_head_mismatch'])
})

test('the service builds fresh request identity from its current owner', t => {
  const { owner, service } = fixture(t)
  owner.contract = contract()
  owner.runId = 'new-owner-run'
  const request = service.currentRequest()!
  assert.equal(request.contract, owner.contract)
  assert.equal(request.run_id, owner.runId)
  assert.equal(evaluateCriterionCompletionV1(request).verified, false)
})

test('an engine run replacement cannot reuse the prior request', t => {
  const { owner, request } = fixture(t)
  owner.runId = 'replacement-run'
  assert.deepEqual(evaluateCriterionCompletionV1(request).errors, ['acceptance_run_mismatch'])
})

test('a request cannot substitute a different physical project', t => {
  const { request } = fixture(t)
  const other = fixture(t)
  const result = evaluateCriterionCompletionV1({ ...request, project_root: other.root })
  assert.equal(result.verified, false)
  assert.deepEqual(result.errors, ['acceptance_project_mismatch'])
})

test('conversation scope cannot acquire project certification from ambient cwd', t => {
  const { owner, request } = fixture(t)
  owner.projectRoot = null
  assert.deepEqual(evaluateCriterionCompletionV1(request).errors, ['acceptance_project_unavailable'])
})

test('unavailable owner errors do not leak their payload', t => {
  const { request } = fixture(t)
  const service = createCriterionCompletionServiceV1(() => { throw new Error('fixture-private-error') })
  assert.deepEqual(evaluateCriterionCompletionV1({ ...request, context: service.context }).errors,
    ['acceptance_context_unavailable'])
})

test('Plan and nonverified terminals do not consult criterion authority', t => {
  const { request } = fixture(t)
  let reads = 0
  const service = createCriterionCompletionServiceV1(() => { reads++; throw new Error('must not evaluate') })
  const acceptance = { ...request, context: service.context }
  const plan = createExecutorKernel('plan').completion.decide({
    mode: 'plan', requestedOutcome: 'PLAN_COMPLETE', hasWrite: false,
    verificationPolicy: 'strict', toolCallLog: [], acceptance,
  })
  const unverified = createExecutorKernel('chat').completion.decide({
    mode: 'chat', requestedOutcome: 'UNVERIFIED_PATCH', hasWrite: true,
    verificationPolicy: 'none', toolCallLog: [], acceptance,
  })
  assert.equal(plan.finalOutcome, 'PLAN_COMPLETE')
  assert.equal(plan.allowed, true)
  assert.equal(unverified.finalOutcome, 'UNVERIFIED_PATCH')
  assert.equal(reads, 0)
})
