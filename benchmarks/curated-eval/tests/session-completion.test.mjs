import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import { adaptChatEngineResult } from '../adapters/chat-engine-result.mjs'
import { loadCatalog, scoreAttempt, summarizeAttemptScores } from '../runner.mjs'

const root = path.resolve(import.meta.dirname, '..')
const catalog = await loadCatalog(root)
const task = catalog.tasks.find((entry) => entry.id === 'csv-rollup-cli')

function attempt(
  status,
  outcome,
  verifierStatus = 'passed',
  diff = { added: ['output/summary.csv'], modified: [], deleted: [] },
) {
  return adaptChatEngineResult({
    taskId: task.id,
    result: { status, outcome, answer: 'Synthetic terminal control', usage: {} },
    verifier: { status: verifierStatus, assertions: null, errors: [] },
    ...(diff === undefined ? {} : { diff }),
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
  assert.equal(scoreAttempt(task, noOp).outcome, 'unverified_success')

  const unverifiedPatch = attempt('completed', 'UNVERIFIED_PATCH')
  assert.equal(unverifiedPatch.session_completed, true)
  assert.equal(scoreAttempt(task, unverifiedPatch).patch_correct, true)
  assert.equal(scoreAttempt(task, unverifiedPatch).externally_correct, true)
  assert.equal(scoreAttempt(task, unverifiedPatch).harness_verified, false)
  assert.equal(scoreAttempt(task, unverifiedPatch).outcome, 'unverified_success')
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

test('aggregate metrics keep verified, unverified and false-block denominators separate', () => {
  const entries = [
    { task, attempt: attempt('completed', 'VERIFIED_COMPLETE') },
    { task, attempt: attempt('completed', 'UNVERIFIED_PATCH') },
    { task, attempt: attempt('completed', 'VERIFIED_COMPLETE', 'failed') },
    { task, attempt: attempt('failed', 'AGENT_FAILURE') },
    { task, attempt: attempt('completed', 'VERIFIED_COMPLETE', 'infrastructure_error') },
  ]
  const summary = summarizeAttemptScores(entries)
  assert.equal(summary.scheduled, 5)
  assert.equal(summary.scored, 4)
  assert.equal(summary.oracle_graded, 4)
  assert.equal(summary.oracle_unavailable, 1)
  assert.equal(summary.externally_correct, 3)
  assert.equal(summary.receipt_passed, 3)
  assert.equal(summary.final_harness_verified, 3)
  assert.equal(summary.verified_success, 1)
  assert.equal(summary.unverified_success, 1)
  assert.equal(summary.false_success, 1)
  assert.equal(summary.false_block, 1)
  for (const [name, value] of Object.entries(summary.rates)) {
    assert.equal(typeof value.numerator, 'number', name)
    assert.equal(typeof value.denominator, 'number', name)
    assert.ok(value.denominator > 0, `${name} must expose a non-zero denominator`)
  }
  assert.equal(summary.rates.verified_success.numerator, 1)
  assert.equal(summary.rates.verified_success.denominator, 5)
  assert.equal(summary.rates.unverified_success.denominator, 5)
  assert.equal(summary.rates.final_harness_verified.numerator, 3)
  assert.equal(summary.rates.final_harness_verified.denominator, 5)
  assert.equal(summary.rates.false_block.numerator, 1)
  assert.equal(summary.rates.false_block.denominator, 3)
})

test('rates never exceed 100% when oracle-unavailable rows are present', () => {
  // Reviewer reproduction: one graded success plus nine completed
  // VERIFIED_COMPLETE rows whose oracle infrastructure failed.
  const entries = [{ task, attempt: attempt('completed', 'VERIFIED_COMPLETE') }]
  for (let index = 0; index < 9; index += 1) {
    entries.push({
      task,
      attempt: attempt('completed', 'VERIFIED_COMPLETE', 'infrastructure_error'),
    })
  }
  const summary = summarizeAttemptScores(entries)
  assert.equal(summary.scheduled, 10)
  assert.equal(summary.scored, 1)
  assert.equal(summary.oracle_graded, 1)
  assert.equal(summary.oracle_unavailable, 9)
  assert.equal(summary.oracle_unavailable_harness_verified, 9)
  assert.equal(summary.verified_success, 1)
  assert.equal(summary.rates.verified_success.numerator, 1)
  assert.equal(summary.rates.verified_success.denominator, 10)
  assert.equal(summary.rates.verified_success.rate, 0.1)
  assert.equal(summary.rates.final_harness_verified.numerator, 10)
  assert.equal(summary.rates.final_harness_verified.denominator, 10)
  assert.equal(summary.rates.final_harness_verified.rate, 1)
  for (const [name, value] of Object.entries(summary.rates)) {
    assert.ok(value.numerator <= value.denominator, `${name} numerator must not exceed denominator`)
    assert.equal(
      value.rate,
      value.denominator === 0 ? null : value.numerator / value.denominator,
      `${name} rate must match its published population`,
    )
    if (value.rate !== null) {
      assert.ok(value.rate >= 0 && value.rate <= 1, `${name} rate must stay within [0,1]`)
    }
  }
})

test('a VERIFIED_COMPLETE engine claim on a failed terminal is still a false success', () => {
  for (const terminal of ['failed', 'blocked']) {
    const score = scoreAttempt(task, {
      ...attempt(terminal, 'VERIFIED_COMPLETE', 'failed'),
      completion_claimed: false,
    })
    assert.equal(score.engine_claim, true, terminal)
    assert.equal(score.harness_verified, false, terminal)
    assert.equal(score.externally_correct, false, terminal)
    assert.equal(score.false_success, true, terminal)
    assert.equal(score.outcome, 'task_failure', terminal)
  }
  const summary = summarizeAttemptScores([
    { task, attempt: { ...attempt('blocked', 'VERIFIED_COMPLETE', 'failed'), completion_claimed: false } },
  ])
  assert.equal(summary.claims, 1)
  assert.equal(summary.false_success, 1)
  assert.equal(summary.rates.false_success.denominator, 1)
})

test('a missing diff cannot certify a policy-clean verified success', () => {
  const missing = scoreAttempt(task, {
    ...attempt('completed', 'VERIFIED_COMPLETE'),
    diff: undefined,
    diff_collected: false,
  })
  assert.equal(missing.diff_collected, false)
  assert.equal(missing.policy_clean, false)
  assert.equal(missing.externally_correct, true)
  assert.equal(missing.outcome, 'task_failure')

  const report = adaptChatEngineResult({
    taskId: task.id,
    result: { status: 'completed', outcome: 'VERIFIED_COMPLETE', answer: 'no diff supplied', usage: {} },
    verifier: { status: 'passed', assertions: 1, errors: [] },
    scriptedProvider: true,
  })
  assert.equal(report.diff_collected, false)
  const score = scoreAttempt(task, report)
  assert.equal(score.policy_clean, false)
  assert.notEqual(score.outcome, 'valid_success')
  assert.notEqual(score.outcome, 'unverified_success')
})

test('false success counts a verified-complete claim contradicted by the oracle or policy', () => {
  const wrongArtifact = scoreAttempt(task, {
    ...attempt('completed', 'VERIFIED_COMPLETE', 'failed'),
    completion_claimed: true,
  })
  assert.equal(wrongArtifact.harness_verified, true)
  assert.equal(wrongArtifact.externally_correct, false)
  assert.equal(wrongArtifact.outcome, 'task_failure')
  assert.equal(wrongArtifact.false_success, true)
  assert.equal(wrongArtifact.false_complete, true)

  const unauthorized = scoreAttempt(task, {
    ...attempt('completed', 'VERIFIED_COMPLETE'),
    completion_claimed: true,
    diff: { added: [], modified: ['package.json'], deleted: [] },
  })
  assert.equal(unauthorized.false_success, true)
  assert.equal(unauthorized.outcome, 'task_failure')
})
