import test from 'node:test';
import assert from 'node:assert/strict';
import type { CandidateEnvelope } from './hostReviewController.js';
import {
  evaluateMergeReadiness,
  type CodeReviewReceipt,
  type DeterministicTestReceipt,
  type RemoteCICheckObservation,
} from './mergeReadinessBroker.js';

const mockCandidate: CandidateEnvelope = {
  schema_version: 2,
  repository: 'gthgomez/DragonWake',
  pr_number: 10,
  base_sha: '0000000000000000000000000000000000000000',
  head_sha: '1111111111111111111111111111111111111111',
  task_id: 'task-10',
  task_hash: 'task-hash-10',
  builder_id: 'builder-codex',
  diff_numstat_digest: 'digest-10',
  scope: ['src/player.ts'],
  risk_tier: 'NORMAL',
  trust_mode: 'EXTERNAL_REPO_REVIEW',
  created_at: new Date().toISOString(),
  candidate_digest: 'candidate-digest-10',
};

const mockPassReview: CodeReviewReceipt = {
  schema_version: 2,
  receipt_id: 'receipt-pass-1',
  candidate_digest: 'candidate-digest-10',
  head_sha: '1111111111111111111111111111111111111111',
  verdict: 'APPROVE',
  reviewer_id: 'mimo-v2.5',
  reviewer_model: 'mimo-v2.5',
  independence: {
    schema_version: 2,
    computed_class: 'I3',
    dimensions: {
      fresh_context: true,
      fresh_process: true,
      read_only_capability: true,
      controller_state_isolated: true,
      builder_identity: 'builder-codex',
      reviewer_identity: 'mimo-v2.5',
      reviewer_model: 'mimo-v2.5',
      reviewer_provider: 'opencode-go',
      trusted_harness: true,
      trusted_source_sha: '0000000000000000000000000000000000000000',
      installation_digest: 'inst-1',
    },
    attestation_digest: 'att-1',
    evaluated_at: new Date().toISOString(),
  },
  coverage: {
    schema_version: 2,
    changed_files_total: 1,
    directly_inspected_files: ['src/player.ts'],
    covered_by_diff_files: [],
    excluded_files: [],
    unaccounted_files: [],
    claimed_files: ['src/player.ts'],
    observed_coverage_ratio: 1.0,
    claimed_coverage_ratio: 1.0,
    claimed_matches_observed: true,
    is_sufficient: true,
    coverage_verdict: 'SUFFICIENT',
    receipt_digest: 'cov-1',
    evaluated_at: new Date().toISOString(),
  },
  findings: [],
  blocking_findings: [],
  certified_at: new Date().toISOString(),
  receipt_hash: 'hash-pass-1',
};

test('mergeReadinessBroker: CodeReview=PASS + CI=FAIL -> Readiness=REPAIR (Review PASS preserved, merge blocked)', () => {
  const failedCI: RemoteCICheckObservation[] = [
    {
      name: 'linux-validation',
      head_sha: '1111111111111111111111111111111111111111',
      status: 'completed',
      conclusion: 'failure',
    },
  ];

  const readiness = evaluateMergeReadiness({
    candidate: mockCandidate,
    reviews: [mockPassReview],
    remoteCIChecks: failedCI,
  });

  // Code review status remains PASS authentically
  assert.equal(readiness.gate_checks.code_review.status, 'PASS');
  assert.equal(readiness.gate_checks.remote_ci.status, 'FAIL');
  // Readiness blocks merge
  assert.equal(readiness.verdict, 'REPAIR');
  assert.ok(readiness.unresolved_blockers.some((b) => b.includes('remote_ci_checks_failed')));
});

test('mergeReadinessBroker: CodeReview=PASS + Tests=PASS + CI=PASS -> Readiness=READY', () => {
  const tests: DeterministicTestReceipt = {
    status: 'PASS',
    head_sha: '1111111111111111111111111111111111111111',
    passed_count: 25,
    failed_count: 0,
    executed_at: new Date().toISOString(),
  };

  const ci: RemoteCICheckObservation[] = [
    {
      name: 'linux-validation',
      head_sha: '1111111111111111111111111111111111111111',
      status: 'completed',
      conclusion: 'success',
    },
  ];

  const readiness = evaluateMergeReadiness({
    candidate: mockCandidate,
    reviews: [mockPassReview],
    deterministicTests: tests,
    remoteCIChecks: ci,
  });

  assert.equal(readiness.verdict, 'READY');
  assert.equal(readiness.unresolved_blockers.length, 0);
  assert.match(readiness.receipt_hash, /^[a-f0-9]{64}$/);
});

test('mergeReadinessBroker: Stale review receipt for prior head is rejected', () => {
  const staleReview: CodeReviewReceipt = {
    ...mockPassReview,
    head_sha: 'old_sha_0000000000000000000000000000000000',
  };

  const readiness = evaluateMergeReadiness({
    candidate: mockCandidate,
    reviews: [staleReview],
  });

  assert.equal(readiness.verdict, 'INSUFFICIENT');
  assert.ok(readiness.unresolved_blockers.some((b) => b.includes('stale_review_receipt_rejected')));
});

test('mergeReadinessBroker: Required gate UNAVAILABLE yields INSUFFICIENT, never READY', () => {
  // NORMAL risk tier requires deterministicTests.
  // Passing code review only without deterministicTests must yield INSUFFICIENT.
  const readiness = evaluateMergeReadiness({
    candidate: mockCandidate, // NORMAL tier
    reviews: [mockPassReview],
  });

  assert.equal(readiness.verdict, 'INSUFFICIENT');
  assert.ok(readiness.unresolved_blockers.includes('deterministic_tests_required_but_unavailable'));
});

test('mergeReadinessBroker: CRITICAL risk tier requires 2 distinct independent reviewer models', () => {
  const criticalCandidate: CandidateEnvelope = {
    ...mockCandidate,
    risk_tier: 'CRITICAL',
  };

  // Only 1 review provided
  const r1 = evaluateMergeReadiness({
    candidate: criticalCandidate,
    reviews: [mockPassReview],
  });
  assert.equal(r1.verdict, 'INSUFFICIENT');
  assert.ok(r1.unresolved_blockers.some((b) => b.includes('insufficient_approved_reviews')));

  // 2 reviews provided, but both by the same model!
  const review2SameModel: CodeReviewReceipt = {
    ...mockPassReview,
    receipt_id: 'receipt-pass-2',
    reviewer_id: 'mimo-v2.5-second-run',
    reviewer_model: 'mimo-v2.5',
  };
  const r2 = evaluateMergeReadiness({
    candidate: criticalCandidate,
    reviews: [mockPassReview, review2SameModel],
  });
  assert.equal(r2.verdict, 'INSUFFICIENT');
  assert.ok(r2.unresolved_blockers.includes('critical_risk_tier_requires_distinct_independent_reviewer_models'));
});

