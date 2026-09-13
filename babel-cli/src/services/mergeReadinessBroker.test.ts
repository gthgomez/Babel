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
      session_id: 'session-pass-1',
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
    independence: {
      ...mockPassReview.independence,
      computed_class: 'I3',
      dimensions: {
        ...mockPassReview.independence.dimensions,
        reviewer_identity: 'mimo-v2.5-second-run',
        reviewer_model: 'mimo-v2.5',
      },
      attestation_digest: 'att-pass-2',
    },
  };
  const r2 = evaluateMergeReadiness({
    candidate: criticalCandidate,
    reviews: [mockPassReview, review2SameModel],
  });
  assert.equal(r2.verdict, 'INSUFFICIENT');
  assert.ok(r2.unresolved_blockers.includes('critical_risk_tier_requires_distinct_independent_reviewer_models'));

  // 2 reviews provided with distinct models: must pass model distinctness check
  const review2DistinctModel: CodeReviewReceipt = {
    ...mockPassReview,
    receipt_id: 'receipt-pass-3',
    reviewer_id: 'longcat-second-run',
    reviewer_model: 'longcat-2.0',
    independence: {
      ...mockPassReview.independence,
      computed_class: 'I3',
      dimensions: {
        ...mockPassReview.independence.dimensions,
        reviewer_identity: 'longcat-second-run',
        reviewer_model: 'longcat-2.0',
        reviewer_provider: 'longcat-ai',
        session_id: 'session-pass-3',
      },
      attestation_digest: 'att-pass-3',
    },
  };
  const r3 = evaluateMergeReadiness({
    candidate: criticalCandidate,
    reviews: [mockPassReview, review2DistinctModel],
  });
  assert.equal(r3.verdict, 'INSUFFICIENT'); // blocked only by missing tests/CI/security, not model distinctness
  assert.ok(!r3.unresolved_blockers.includes('critical_risk_tier_requires_distinct_independent_reviewer_models'));
});

test('mergeReadinessBroker: rejects review receipt candidate digest mismatch', () => {
  const mismatchedReview: CodeReviewReceipt = {
    ...mockPassReview,
    candidate_digest: 'tampered-candidate-digest-999',
  };

  const readiness = evaluateMergeReadiness({
    candidate: mockCandidate,
    reviews: [mismatchedReview],
  });

  assert.equal(readiness.verdict, 'INSUFFICIENT');
  assert.ok(readiness.unresolved_blockers.includes('review_receipt_candidate_digest_mismatch'));
});

test('mergeReadinessBroker: detects conflicting review evidence for same receipt_id', () => {
  const receipt1: CodeReviewReceipt = {
    ...mockPassReview,
    receipt_id: 'receipt-conflict-1',
    verdict: 'APPROVE',
  };

  const receipt2Conflicting: CodeReviewReceipt = {
    ...mockPassReview,
    receipt_id: 'receipt-conflict-1',
    verdict: 'BLOCK',
    blocking_findings: [
      {
        schema_version: 2,
        finding_instance_id: 'f1',
        finding_fingerprint: 'fp1',
        claim: 'Critical issue found',
        category: 'correctness',
        severity: 'P1',
        confidence: 'high',
        location: { path: 'src/player.ts', line: 10 },
        reviewer_id: 'reviewer',
        recommended_blocking: true,
        policy_blocking: true,
        verification_status: 'UNVERIFIED',
        created_at: new Date().toISOString(),
      },
    ],
  };

  const readiness = evaluateMergeReadiness({
    candidate: mockCandidate,
    reviews: [receipt1, receipt2Conflicting],
  });

  assert.equal(readiness.verdict, 'REPAIR');
  assert.ok(readiness.unresolved_blockers.some((b) => b.startsWith('conflicting_review_evidence_detected:receipt-conflict-1')));
});

test('mergeReadinessBroker: duplicate session IDs or duplicate attestations fail ensemble I4 requirement', () => {
  const criticalCandidate: CandidateEnvelope = {
    ...mockCandidate,
    risk_tier: 'CRITICAL',
  };

  // 2 reviews with different models but identical session_id (same execution re-attributed)
  const rev1: CodeReviewReceipt = {
    ...mockPassReview,
    receipt_id: 'receipt-rev-1',
    reviewer_model: 'mimo-v2.5',
    independence: {
      ...mockPassReview.independence,
      computed_class: 'I3',
      dimensions: {
        ...mockPassReview.independence.dimensions,
        reviewer_model: 'mimo-v2.5',
        session_id: 'shared-session-123',
      },
      attestation_digest: 'att-rev-1',
    },
  };

  const rev2SharedSession: CodeReviewReceipt = {
    ...mockPassReview,
    receipt_id: 'receipt-rev-2',
    reviewer_model: 'longcat-2.0',
    independence: {
      ...mockPassReview.independence,
      computed_class: 'I3',
      dimensions: {
        ...mockPassReview.independence.dimensions,
        reviewer_model: 'longcat-2.0',
        session_id: 'shared-session-123', // duplicate session ID!
      },
      attestation_digest: 'att-rev-2',
    },
  };

  const readiness = evaluateMergeReadiness({
    candidate: criticalCandidate,
    reviews: [rev1, rev2SharedSession],
  });

  assert.equal(readiness.verdict, 'INSUFFICIENT');
  assert.ok(readiness.unresolved_blockers.includes('critical_risk_tier_requires_ensemble_i4_independence'));
});

test('mergeReadinessBroker: local unauthenticated review evidence cannot manufacture PASS readiness', () => {
  const unauthReview: CodeReviewReceipt = {
    ...mockPassReview,
    provenance: 'LOCAL_UNAUTHENTICATED',
  };

  const readiness = evaluateMergeReadiness({
    candidate: mockCandidate,
    reviews: [unauthReview],
  });

  // Local unauthenticated review must not grant approval
  assert.equal(readiness.gate_checks.code_review.approved_reviews_count, 0);
  assert.equal(readiness.gate_checks.code_review.status, 'INSUFFICIENT');
  assert.equal(readiness.verdict, 'INSUFFICIENT');
  assert.ok(
    readiness.unresolved_blockers.includes(
      'unauthenticated_local_review_evidence_rejected_for_authoritative_gate'
    )
  );
});

test('mergeReadinessBroker: conflicting review receipts sharing receipt_id fail closed regardless of arrival order', () => {
  const receiptA: CodeReviewReceipt = {
    ...mockPassReview,
    receipt_id: 'shared-receipt-1',
    verdict: 'APPROVE',
  };

  const receiptBConflict: CodeReviewReceipt = {
    ...mockPassReview,
    receipt_id: 'shared-receipt-1',
    verdict: 'BLOCK',
  };

  // Order [A, B]
  const readinessAB = evaluateMergeReadiness({
    candidate: mockCandidate,
    reviews: [receiptA, receiptBConflict],
  });
  assert.equal(readinessAB.gate_checks.code_review.status, 'FAIL');
  assert.ok(
    readinessAB.unresolved_blockers.includes('conflicting_review_evidence_detected:shared-receipt-1')
  );

  // Order [B, A] (order reversal)
  const readinessBA = evaluateMergeReadiness({
    candidate: mockCandidate,
    reviews: [receiptBConflict, receiptA],
  });
  assert.equal(readinessBA.gate_checks.code_review.status, 'FAIL');
  assert.ok(
    readinessBA.unresolved_blockers.includes('conflicting_review_evidence_detected:shared-receipt-1')
  );
});

test('mergeReadinessBroker: identical review receipts sharing receipt_id collapse identically regardless of arrival order', () => {
  const receipt1: CodeReviewReceipt = {
    ...mockPassReview,
    receipt_id: 'identical-receipt-1',
  };

  const receipt2Duplicate: CodeReviewReceipt = {
    ...mockPassReview,
    receipt_id: 'identical-receipt-1',
  };

  // Forward order
  const readiness1 = evaluateMergeReadiness({
    candidate: mockCandidate,
    reviews: [receipt1, receipt2Duplicate],
  });
  assert.equal(readiness1.gate_checks.code_review.approved_reviews_count, 1);
  assert.equal(readiness1.gate_checks.code_review.receipt_ids.length, 1);

  // Reverse order
  const readiness2 = evaluateMergeReadiness({
    candidate: mockCandidate,
    reviews: [receipt2Duplicate, receipt1],
  });
  assert.equal(readiness2.gate_checks.code_review.approved_reviews_count, 1);
  assert.equal(readiness2.gate_checks.code_review.receipt_ids.length, 1);
});



