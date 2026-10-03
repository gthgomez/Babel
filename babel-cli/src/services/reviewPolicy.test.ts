import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  classifyReviewRisk,
  resolveReviewAuthority,
  resolveReviewPolicy,
  type ReviewPolicy,
  type ReviewRiskLane,
} from './reviewPolicy.js';

const { hostProtectedPrefixes } = JSON.parse(
  readFileSync(new URL('../../../config/review-risk-policy.json', import.meta.url), 'utf8'),
) as { hostProtectedPrefixes: string[] };

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
    requiredIndependenceClass: 'I2',
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

test('review control paths are critical under the shared risk table', () => {
  assert.equal(classifyReviewRisk(['tools/babel-pr-orchestrate.mts']), 'CRITICAL');
  assert.equal(classifyReviewRisk(['scripts/agent-pr-merge.ps1']), 'CRITICAL');
  assert.equal(classifyReviewRisk(['babel-cli/src/services/reviewIndependence.ts']), 'CRITICAL');
  assert.equal(classifyReviewRisk(['src/ordinary.ts']), 'NORMAL');
  assert.equal(classifyReviewRisk(['docs/guide.md']), 'TRIVIAL');
  assert.equal(classifyReviewRisk([]), 'AMBIGUOUS');
});

test('candidate identity, snapshot, and durable review state remain host-protected', () => {
  for (const path of [
    'babel-cli/src/services/candidateCollector.ts',
    'babel-cli/src/services/babelReviewSnapshot.ts',
    'babel-cli/src/services/babelReviewQueue.ts',
    'babel-cli/src/services/babelChatReview.ts',
    'babel-cli/src/services/babelReviewObserver.ts',
  ]) {
    assert.equal(classifyReviewRisk([path]), 'CRITICAL', path);
    assert.equal(resolveReviewAuthority([path]), 'HOST_PROTECTED', path);
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

test('AMBIGUOUS resolves to the ELEVATED policy', () => {
  assert.deepEqual(
    resolveReviewPolicy({ riskLane: 'AMBIGUOUS', requireAuthoritative: true }),
    resolveReviewPolicy({ riskLane: 'ELEVATED', requireAuthoritative: true }),
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

test('resolveReviewAuthority: reviewer/gate paths require HOST_PROTECTED', () => {
  assert.equal(resolveReviewAuthority(['docs/readme.md']), 'SESSION_ATTESTED');
  assert.equal(resolveReviewAuthority(['scripts/agent-pr-gate.ps1']), 'HOST_PROTECTED');
  assert.equal(resolveReviewAuthority(['scripts/trusted-merge-gate.ps1']), 'HOST_PROTECTED');
  assert.equal(resolveReviewAuthority(['babel-cli/src/services/codexHarnessReview.ts']), 'HOST_PROTECTED');
  assert.equal(resolveReviewAuthority(['babel-cli/src/services/harnessReviewProtocol.ts']), 'HOST_PROTECTED');
  assert.equal(resolveReviewAuthority(['babel-cli/src/config/autonomyPolicy.ts']), 'HOST_PROTECTED');
  assert.equal(resolveReviewAuthority(['config/review-risk-policy.json']), 'HOST_PROTECTED');
  assert.equal(resolveReviewAuthority(['babel-cli/src/services/reviewIndependence.ts']), 'HOST_PROTECTED');
  assert.equal(resolveReviewAuthority(['scripts/agent-git-common.psm1']), 'HOST_PROTECTED');
  assert.equal(resolveReviewAuthority(['AGENTS.md']), 'HOST_PROTECTED');
  assert.equal(classifyReviewRisk(['AGENTS.md']), 'CRITICAL');
  assert.equal(resolveReviewAuthority(['babel-cli/src/services/chatEngine.ts']), 'SESSION_ATTESTED');
  assert.equal(resolveReviewAuthority([]), 'HOST_PROTECTED');
});

test('resolveReviewAuthority: every configured hostProtectedPrefix is protected', () => {
  assert.ok(hostProtectedPrefixes.length > 0, 'the shared policy must declare hostProtectedPrefixes');
  for (const prefix of hostProtectedPrefixes) {
    const representative = prefix.endsWith('/') ? `${prefix}representative.ts` : prefix;
    assert.equal(resolveReviewAuthority([representative]), 'HOST_PROTECTED', `prefix ${prefix}`);
  }
});

test('every host-protected control-plane path is classified CRITICAL', () => {
  for (const prefix of hostProtectedPrefixes) {
    const representative = prefix.endsWith('/') ? `${prefix}representative.ts` : prefix;
    assert.equal(classifyReviewRisk([representative]), 'CRITICAL', `prefix ${prefix}`);
  }
});

test('resolveReviewAuthority: normalizes backslashes, case, and trailing slashes', () => {
  assert.equal(resolveReviewAuthority(['babel-cli\\src\\services\\codexHarnessReview.ts']), 'HOST_PROTECTED');
  assert.equal(resolveReviewAuthority(['BABEL-CLI/SRC/SERVICES/HARNESSREVIEWPROTOCOL.TS']), 'HOST_PROTECTED');
  assert.equal(resolveReviewAuthority(['babel-cli/src/services/reviewPolicy/']), 'HOST_PROTECTED');
  assert.equal(resolveReviewAuthority(['BABEL-CLI\\SRC\\SERVICES\\CHATENGINE.TS']), 'SESSION_ATTESTED');
});
