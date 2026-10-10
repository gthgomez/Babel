import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import { adaptChatEngineResult } from '../adapters/chat-engine-result.mjs'
import { loadCatalog, scoreAttempt } from '../runner.mjs'

const root = path.resolve(import.meta.dirname, '..')
const catalog = await loadCatalog(root)
const task = catalog.tasks.find((entry) => entry.id === 'csv-rollup-cli')

function attempt(status, outcome, verifierStatus = 'passed') {
  return adaptChatEngineResult({
    taskId: task.id,
    result: { status, outcome, answer: 'Synthetic terminal control', usage: {} },
    verifier: { status: verifierStatus, assertions: null, errors: [] },
    scriptedProvider: true,
  })
}

test('a passing patch oracle cannot turn a blocked ChatEngine result into a completed session', () => {
  const report = attempt('completed', 'BLOCKED_EXTERNAL')
  const score = scoreAttempt(task, report)
  assert.equal(score.outcome, 'task_failure')
  assert.equal(score.patch_correct, true)
  assert.equal(report.terminal_status, 'blocked')
  assert.equal(report.session_completed, false)
  assert.equal(score.session_completed, false)
  assert.equal(report.usage.cost_usd, null)
})

test('engine completion and patch correctness remain independent', () => {
  const correct = attempt('completed', 'VERIFIED_COMPLETE')
  assert.equal(correct.session_completed, true)
  assert.equal(scoreAttempt(task, correct).outcome, 'valid_success')

  const incorrect = scoreAttempt(task, attempt('completed', 'VERIFIED_COMPLETE', 'failed'))
  assert.equal(incorrect.session_completed, true)
  assert.equal(incorrect.patch_correct, false)
  assert.equal(incorrect.outcome, 'task_failure')

  const noOp = attempt('completed', 'NO_CHANGE_REQUIRED')
  assert.equal(noOp.session_completed, true)
  assert.equal(scoreAttempt(task, noOp).outcome, 'valid_success')

  const unverifiedPatch = attempt('completed', 'UNVERIFIED_PATCH')
  assert.equal(unverifiedPatch.session_completed, true)
  assert.equal(scoreAttempt(task, unverifiedPatch).patch_correct, true)
  assert.equal(scoreAttempt(task, unverifiedPatch).outcome, 'valid_success')
})

test('missing engine outcome and missing verifier evidence stay unknown', () => {
  const missingOutcome = attempt('completed', undefined)
  assert.equal(missingOutcome.session_completed, null)
  assert.equal(scoreAttempt(task, missingOutcome).session_completed, null)
  assert.equal(scoreAttempt(task, missingOutcome).outcome, 'task_failure')

  const missingVerifier = scoreAttempt(task, attempt('completed', 'VERIFIED_COMPLETE', 'not_run'))
  assert.equal(missingVerifier.patch_correct, null)
  assert.equal(missingVerifier.session_completed, true)
  assert.equal(missingVerifier.outcome, 'task_failure')
})

test('non-success terminals retain an independently correct patch verdict', () => {
  for (const [status, terminal, outcome] of [
    ['blocked', 'BLOCKED_EXTERNAL', 'task_failure'],
    ['failed', 'AGENT_FAILURE', 'task_failure'],
    ['cancelled', 'CANCELLED', 'cancelled'],
    ['budget_exhausted', 'BUDGET_EXHAUSTED', 'budget_truncated'],
    ['failed', 'INFRA_FAILURE', 'infrastructure_error'],
  ]) {
    const report = attempt(status, terminal)
    const score = scoreAttempt(task, report)
    assert.equal(report.session_completed, false, terminal)
    assert.equal(score.session_completed, false, terminal)
    assert.equal(score.patch_correct, true, terminal)
    assert.equal(score.outcome, outcome, terminal)
  }
})

test('an unavailable grader keeps patch correctness unknown', () => {
  const score = scoreAttempt(task, attempt('completed', 'VERIFIED_COMPLETE', 'infrastructure_error'))
  assert.equal(score.patch_correct, null)
  assert.equal(score.session_completed, true)
  assert.equal(score.outcome, 'infrastructure_error')
})

test('missing grading evidence does not establish a false completion claim', () => {
  for (const verifierStatus of ['not_run', 'infrastructure_error']) {
    const score = scoreAttempt(task, {
      ...attempt('completed', 'UNVERIFIED_PATCH', verifierStatus),
      completion_claimed: true,
    })
    assert.equal(score.false_complete, false, verifierStatus)
    assert.equal(score.patch_correct, null, verifierStatus)
  }

  const contradictedClaim = scoreAttempt(task, {
    ...attempt('completed', 'BLOCKED_EXTERNAL'), completion_claimed: true,
  })
  assert.equal(contradictedClaim.false_complete, true)
})

test('an explicit contradicted completion claim survives non-task outcome classification', () => {
  for (const [status, terminal, outcome] of [
    ['cancelled', 'CANCELLED', 'cancelled'],
    ['budget_exhausted', 'BUDGET_EXHAUSTED', 'budget_truncated'],
    ['failed', 'INFRA_FAILURE', 'infrastructure_error'],
  ]) {
    const score = scoreAttempt(task, { ...attempt(status, terminal), completion_claimed: true })
    assert.equal(score.false_complete, true, terminal)
    assert.equal(score.outcome, outcome, terminal)
  }
})

test('conflicting blocked and failed engine outcomes veto a completed status', () => {
  for (const terminal of ['BLOCKED_EXTERNAL', 'BLOCKED_POLICY', 'INVALID_TASK', 'NEEDS_HUMAN_DECISION', 'AGENT_FAILURE']) {
    const report = attempt('completed', terminal)
    assert.equal(report.session_completed, false, terminal)
    assert.equal(scoreAttempt(task, report).outcome, 'task_failure', terminal)
    assert.equal(scoreAttempt(task, report).patch_correct, true, terminal)
    // The scoring boundary independently checks the engine evidence, even if
    // a caller bypasses the ChatEngine adapter and supplies a completion flag.
    assert.equal(scoreAttempt(task, {
      ...report, terminal_status: 'completed', session_completed: true,
    }).outcome, 'task_failure', terminal)
  }
})

test('session completion schema permits an unknown value', async () => {
  const schema = JSON.parse(await readFile(path.join(root, 'report.schema.json'), 'utf8'))
  assert.ok(schema.required.includes('session_completed'))
  assert.deepEqual(schema.properties.session_completed.type, ['boolean', 'null'])
})
