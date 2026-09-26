import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveReviewPolicy,
  type ReviewPolicy,
  type ReviewRiskLane,
} from './reviewPolicy.js';

const lanes: ReviewRiskLane[] = ['TRIVIAL', 'NORMAL', 'ELEVATED', 'CRITICAL', 'AMBIGUOUS'];

const expectedPolicy: Record<ReviewRiskLane, ReviewPolicy> = {
  TRIVIAL: {
    workingReviewCount: 1,
    finalCertificationCount: 1,
    requireFreshContext: true,
    requireRuntimeDiversity: false,
    requireModelDiversity: false,
    requiredIndependenceClass: 'I2',
    deterministicTestsRequired: false,
    remoteCIRequired: false,
    securityRequired: false,
  },
  NORMAL: {
    workingReviewCount: 1,
    finalCertificationCount: 1,
    requireFreshContext: true,
    requireRuntimeDiversity: false,
    requireModelDiversity: false,
    requiredIndependenceClass: 'I2',
    deterministicTestsRequired: true,
    remoteCIRequired: false,
    securityRequired: false,
  },
  ELEVATED: {
    workingReviewCount: 2,
    finalCertificationCount: 2,
    requireFreshContext: true,
    requireRuntimeDiversity: false,
    requireModelDiversity: false,
    requiredIndependenceClass: 'I2',
    deterministicTestsRequired: true,
    remoteCIRequired: true,
    securityRequired: true,
  },
  CRITICAL: {
    workingReviewCount: 2,
    finalCertificationCount: 2,
    requireFreshContext: true,
    requireRuntimeDiversity: false,
    requireModelDiversity: false,
    requiredIndependenceClass: 'I4',
    deterministicTestsRequired: true,
    remoteCIRequired: true,
    securityRequired: true,
  },
  AMBIGUOUS: {
    workingReviewCount: 2,
    finalCertificationCount: 2,
    requireFreshContext: true,
    requireRuntimeDiversity: false,
    requireModelDiversity: false,
    // AMBIGUOUS preserves the historical default floor (ELEVATED-equivalent),
    // so existing protection strength is not silently tightened.
    requiredIndependenceClass: 'I2',
    deterministicTestsRequired: true,
    remoteCIRequired: true,
    securityRequired: true,
  },
};

test('resolveReviewPolicy returns the full policy for every lane', () => {
  for (const lane of lanes) {
    const policy = resolveReviewPolicy({ riskLane: lane, requireAuthoritative: true });
    assert.deepEqual(policy, expectedPolicy[lane], `lane ${lane}`);
  }
});

test('resolveReviewPolicy defaults to the AMBIGUOUS (ELEVATED-equivalent) policy for any unknown lane', () => {
  const unknown = 'NOT_A_LANE' as ReviewRiskLane;
  assert.deepEqual(
    resolveReviewPolicy({ riskLane: unknown, requireAuthoritative: true }),
    expectedPolicy.AMBIGUOUS,
  );
  assert.deepEqual(
    resolveReviewPolicy({ riskLane: unknown, requireAuthoritative: false }),
    expectedPolicy.AMBIGUOUS,
  );
});

test('AMBIGUOUS resolves to the ELEVATED policy, not CRITICAL (strength preserved)', () => {
  assert.deepEqual(
    resolveReviewPolicy({ riskLane: 'AMBIGUOUS', requireAuthoritative: true }),
    resolveReviewPolicy({ riskLane: 'ELEVATED', requireAuthoritative: true }),
  );
  assert.notDeepEqual(
    resolveReviewPolicy({ riskLane: 'AMBIGUOUS', requireAuthoritative: true }),
    resolveReviewPolicy({ riskLane: 'CRITICAL', requireAuthoritative: true }),
  );
});

test('requireFreshContext is always true and counts never drop below one', () => {
  for (const lane of lanes) {
    const policy = resolveReviewPolicy({ riskLane: lane, requireAuthoritative: true });
    assert.equal(policy.requireFreshContext, true, `lane ${lane} requireFreshContext`);
    assert.ok(policy.workingReviewCount >= 1, `lane ${lane} workingReviewCount`);
    assert.ok(policy.finalCertificationCount >= 1, `lane ${lane} finalCertificationCount`);
  }
});
