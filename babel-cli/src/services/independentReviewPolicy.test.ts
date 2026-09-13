import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  assertNoPriorBlockInRecord,
  assertNoUnresolvedPriorBlock,
  recordUnresolvedBlock,
  resolveIndependentReviewPlan,
  settleIndependentReviewRound,
} from './independentReviewPolicy.js'

test('independentReviewPolicy: resolveIndependentReviewPlan defaults to 1 and allows 2', () => {
  assert.equal(resolveIndependentReviewPlan().reviewerCount, 1)
  assert.equal(resolveIndependentReviewPlan({ reviewerCount: 1 }).reviewerCount, 1)
  assert.equal(resolveIndependentReviewPlan({ reviewerCount: '1' }).reviewerCount, 1)
  assert.equal(resolveIndependentReviewPlan({ reviewerCount: 2 }).reviewerCount, 2)
  assert.equal(resolveIndependentReviewPlan({ reviewerCount: '2' }).reviewerCount, 2)
  assert.equal(resolveIndependentReviewPlan({ hasExistingSecondReview: true }).reviewerCount, 2)
  assert.throws(() => resolveIndependentReviewPlan({ reviewerCount: 3 as any }), /INVALID_REVIEWER_COUNT/)
  assert.throws(() => resolveIndependentReviewPlan({ reviewerCount: 'invalid' as any }), /INVALID_REVIEWER_COUNT/)
})

test('independentReviewPolicy: assertNoPriorBlockInRecord throws on BLOCK or blocking findings', () => {
  assert.doesNotThrow(() => assertNoPriorBlockInRecord({ verdict: 'APPROVE', blocking_findings: [] }))
  assert.throws(() => assertNoPriorBlockInRecord({ verdict: 'BLOCK' }), /PRIOR_BLOCKING_REVIEW_REQUIRES_REPAIR/)
  assert.throws(
    () => assertNoPriorBlockInRecord({ verdict: 'APPROVE', blocking_findings: ['fatal bug'] }),
    /PRIOR_BLOCKING_REVIEW_REQUIRES_REPAIR/
  )
  assert.throws(
    () => assertNoPriorBlockInRecord({ reviews: [{ verdict: 'BLOCK' }] }),
    /PRIOR_BLOCKING_REVIEW_REQUIRES_REPAIR/
  )
})

test('independentReviewPolicy: assertNoUnresolvedPriorBlock prevents approval shopping on retained candidate block', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'babel-policy-test-'))
  const digest = 'abc12345'.repeat(8)

  try {
    // Empty state dir does not throw
    assert.doesNotThrow(() => assertNoUnresolvedPriorBlock(digest, tempDir))

    // Record an unresolved block
    recordUnresolvedBlock(digest, tempDir, {
      verdict: 'BLOCK',
      blocking_findings: ['Syntax error in parser.ts'],
    })

    // Subsequent assertion must throw
    assert.throws(() => assertNoUnresolvedPriorBlock(digest, tempDir), /PRIOR_BLOCKING_REVIEW_REQUIRES_REPAIR/)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test('independentReviewPolicy: settleIndependentReviewRound returns fulfilled block even if peer failed', () => {
  const blockingHandoff = { reviews: [{ verdict: 'BLOCK' }] }
  const settledWithBlock: PromiseSettledResult<typeof blockingHandoff>[] = [
    { status: 'fulfilled', value: blockingHandoff },
    { status: 'rejected', reason: new Error('Network timeout in child 2') },
  ]
  // Must return the fulfilled block so it is retained and published
  const result = settleIndependentReviewRound(settledWithBlock)
  assert.equal(result.length, 1)
  assert.equal(result[0]!.reviews[0]!.verdict, 'BLOCK')
})

test('independentReviewPolicy: settleIndependentReviewRound throws on child failure if no block', () => {
  const approvingHandoff = { reviews: [{ verdict: 'APPROVE' }] }
  const settledWithFailure: PromiseSettledResult<typeof approvingHandoff>[] = [
    { status: 'fulfilled', value: approvingHandoff },
    { status: 'rejected', reason: new Error('Child crashed') },
  ]
  // Must NOT publish partial approval! Throws so fresh retry is possible
  assert.throws(() => settleIndependentReviewRound(settledWithFailure), /Child crashed/)
})
