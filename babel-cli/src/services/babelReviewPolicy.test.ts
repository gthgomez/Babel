import test from 'node:test'
import assert from 'node:assert/strict'
import { assertNoPriorReviewBlock, babelReviewModels, settledBabelReviews } from './babelReviewPolicy.js'

test('one independent reviewer by default and explicit dual-model escalation', () => {
  assert.deepEqual(babelReviewModels(undefined), ['mimo-v2.5'])
  assert.deepEqual(babelReviewModels('1'), ['mimo-v2.5'])
  assert.deepEqual(babelReviewModels('2'), ['mimo-v2.5', 'longcat-2.0'])
})

test('artifact-only and stale handoff blockers cannot be replaced by approval', () => {
  for (const prior of [
    { verdict: { verdict: 'BLOCK', blocking_findings: ['defect'] } },
    { reviews: [{ verdict: 'BLOCK', reviewed_at: '2000-01-01', blocking_findings: [] }] },
    { verdict: { verdict: 'APPROVE', blocking_findings: ['contradictory blocker'] } },
  ]) {
    assert.throws(() => {
      for (const artifact of [prior, { verdict: { verdict: 'APPROVE', blocking_findings: [] } }]) assertNoPriorReviewBlock(artifact)
    }, /PRIOR_BLOCKING_REVIEW_REQUIRES_REPAIR/)
  }
  assert.doesNotThrow(() => assertNoPriorReviewBlock({ verdict: { verdict: 'APPROVE', blocking_findings: [] } }))
})
test('resuming cannot discard an existing second review', () => {
  for (const count of [undefined, '1', '2']) {
    assert.deepEqual(babelReviewModels(count, true), ['mimo-v2.5', 'longcat-2.0'])
  }
})
test('invalid reviewer counts fail closed', () => {
  for (const count of ['', '0', '3', '1.0', '-1', 'auto']) {
    assert.throws(() => babelReviewModels(count), /INVALID_REVIEWER_COUNT/)
  }
})

test('cached BLOCK can resume publication after interrupted POST and peer failure', () => {
  const block = { reviews: [{ verdict: 'BLOCK' }] }
  const approve = { reviews: [{ verdict: 'APPROVE' }] }
  const failed: PromiseRejectedResult = { status: 'rejected', reason: new Error('peer failed') }
  const blocked: PromiseFulfilledResult<typeof block> = { status: 'fulfilled', value: block }
  const approved: PromiseFulfilledResult<typeof approve> = { status: 'fulfilled', value: approve }
  assert.deepEqual(settledBabelReviews([blocked, failed]), [block])
  assert.deepEqual(settledBabelReviews([failed, blocked]), [block])
  assert.deepEqual(settledBabelReviews([approved, blocked]), [approve, block])
  assert.deepEqual(settledBabelReviews([approved]), [approve])
  assert.throws(() => settledBabelReviews([approved, failed]), /peer failed/)
  assert.throws(() => settledBabelReviews([failed]), /peer failed/)
})
