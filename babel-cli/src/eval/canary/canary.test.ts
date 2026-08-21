import assert from 'node:assert/strict'
import test from 'node:test'

import { interleaveTrials } from './interleave.js'
import { runCodingCanary } from './runner.js'
import { uncertaintyForTrials } from './score.js'
import { CANARY_TASKS } from './tasks.js'
import { verifyCanaryTaskValidity } from './validity.js'
import { isLiveSuccessScope } from '../evalTypes.js'

test('n=1 uncertainty is null', () => {
  assert.equal(uncertaintyForTrials(1), null)
  assert.ok(typeof uncertaintyForTrials(3) === 'number')
})

test('interleave alternates arm order', () => {
  const rows = interleaveTrials(['C01', 'C02'], 1)
  assert.equal(rows[0]!.first, 'baseline')
  assert.equal(rows[1]!.first, 'candidate')
})

test('mock canary: C08 no mutation, C10 false_complete, C09 honest block', () => {
  const c08 = runCodingCanary({ provider: 'mock', taskId: 'C08', trials: 1 })
  assert.equal(c08.trials[0]!.production_mutated, false)
  assert.equal(c08.trials[0]!.contract_success, true)
  assert.equal(c08.evidence_scope, 'MOCK_ORCHESTRATION')
  assert.equal(isLiveSuccessScope(c08.evidence_scope), false)

  const c10 = runCodingCanary({ provider: 'mock', taskId: 'C10', trials: 1 })
  assert.equal(c10.trials[0]!.false_complete, true)
  assert.equal(c10.trials[0]!.hidden_ok, false)
  assert.equal(c10.trials[0]!.visible_ok, true)
  assert.equal(c10.trials[0]!.contract_success, true)

  const c09 = runCodingCanary({ provider: 'mock', taskId: 'C09', trials: 1 })
  assert.equal(c09.trials[0]!.honest_block, true)
  assert.equal(c09.trials[0]!.claimed_complete, false)
  assert.equal(c09.trials[0]!.contract_success, true)
})

test('mock C01 gold patch is contract success and not live-aggregatable', () => {
  const c01 = runCodingCanary({ provider: 'mock', taskId: 'C01', trials: 3 })
  assert.equal(c01.tasks[0]!.all_trials_reliable, true)
  assert.equal(c01.trials[0]!.code_fix_success, true)
})

test('every canary task has a validity receipt', () => {
  for (const spec of CANARY_TASKS) {
    const receipt = verifyCanaryTaskValidity(spec, 2)
    assert.equal(receipt.task_id, spec.id, spec.id)
    assert.equal(receipt.baseline_verified, true, `${spec.id} baseline`)
    assert.equal(receipt.reference_verified, true, `${spec.id} reference`)
    assert.equal(receipt.oracle_stable, true, `${spec.id} stable`)
  }
})

test('live provider is refused without authorization path', () => {
  assert.throws(() => runCodingCanary({ provider: 'live' }), /authorization/)
})
