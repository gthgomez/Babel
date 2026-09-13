import { createHash } from 'node:crypto';
import type { CandidateEnvelope, ReviewEvidenceProvenance } from './hostReviewController.js';
import type { ReviewCoverageReceipt } from './reviewCoverage.js';
import {
  evaluateEnsembleIndependence,
  type ReviewerIndependenceAttestation,
} from './reviewIndependence.js';
import type { StructuredFinding } from './structuredFinding.js';

export type { ReviewEvidenceProvenance };

export interface CodeReviewReceipt {
  schema_version: 2;
  receipt_id: string;
  candidate_digest: string;
  head_sha: string;
  verdict: 'APPROVE' | 'BLOCK' | 'REPAIR_REQUIRED' | 'INSUFFICIENT_REVIEW_COVERAGE';
  reviewer_id: string;
  reviewer_model: string;
  independence: ReviewerIndependenceAttestation;
  coverage: ReviewCoverageReceipt;
  findings: StructuredFinding[];
  blocking_findings: StructuredFinding[];
  certified_at: string;
  receipt_hash: string;
  provenance?: ReviewEvidenceProvenance;
}

export interface RemoteCICheckObservation {
  name: string;
  head_sha: string;
  status: 'completed' | 'in_progress' | 'queued';
  conclusion: 'success' | 'failure' | 'neutral' | 'cancelled' | 'timed_out' | 'action_required' | null;
  workflow_id?: string;
  check_run_id?: string;
}

export interface DeterministicTestReceipt {
  status: 'PASS' | 'FAIL';
  head_sha: string;
  passed_count: number;
  failed_count: number;
  suite_name?: string;
  executed_at: string;
}

export interface SecurityReceipt {
  status: 'PASS' | 'FAIL';
  head_sha: string;
  gitleaks_passed: boolean;
  clean_source: boolean;
  scanned_at: string;
}

export type ReadinessVerdict = 'READY' | 'REPAIR' | 'INSUFFICIENT' | 'ESCALATE';

export type HumanEscalationReason =
  | 'OBJECTIVE_AMBIGUOUS'
  | 'POLICY_DECISION_REQUIRED'
  | 'IRREVERSIBLE_AUTHORITY_REQUIRED'
  | 'REVIEW_DISAGREEMENT_UNRESOLVED'
  | 'EVIDENCE_INSUFFICIENT_AFTER_BOUNDED_RETRY'
  | 'NEW_RISK_CLASS';

export interface MergeReadinessReceipt {
  schema_version: 2;
  readiness_id: string;
  candidate_digest: string;
  head_sha: string;
  verdict: ReadinessVerdict;
  gate_checks: {
    code_review: {
      status: 'PASS' | 'FAIL' | 'INSUFFICIENT';
      approved_reviews_count: number;
      blocking_findings_count: number;
      receipt_ids: string[];
    };
    deterministic_tests: {
      status: 'PASS' | 'FAIL' | 'UNAVAILABLE';
      details?: string | undefined;
    };
    remote_ci: {
      status: 'PASS' | 'FAIL' | 'PENDING' | 'UNAVAILABLE';
      total_checks: number;
      successful_checks: number;
      failed_checks: string[];
    };
    security_scan: {
      status: 'PASS' | 'FAIL' | 'UNAVAILABLE';
      details?: string | undefined;
    };
  };
  unresolved_blockers: string[];
  escalation_reason: HumanEscalationReason | null;
  receipt_hash: string;
  evaluated_at: string;
}

export interface RequiredGatesPolicy {
  codeReview: { minApprovals: number; requireI4?: boolean };
  deterministicTests: boolean;
  securityScan: boolean;
  remoteCI: boolean;
}

export function resolveRequiredGates(riskTier: string): RequiredGatesPolicy {
  switch (riskTier) {
    case 'TRIVIAL':
      return { codeReview: { minApprovals: 1 }, deterministicTests: false, securityScan: false, remoteCI: false };
    case 'NORMAL':
      return { codeReview: { minApprovals: 1 }, deterministicTests: true, securityScan: false, remoteCI: false };
    case 'ELEVATED':
      return { codeReview: { minApprovals: 2 }, deterministicTests: true, securityScan: true, remoteCI: true };
    case 'CRITICAL':
      return { codeReview: { minApprovals: 2, requireI4: true }, deterministicTests: true, securityScan: true, remoteCI: true };
    default:
      return { codeReview: { minApprovals: 2 }, deterministicTests: true, securityScan: true, remoteCI: true };
  }
}

export function computeCanonicalReceiptDigest(receipt: CodeReviewReceipt): string {
  const normFindings = [...(receipt.findings ?? [])]
    .map((f) => `${f.severity}:${f.location?.path ?? ''}:${f.location?.line ?? ''}:${f.claim}`)
    .sort();
  const normBlockingFindings = [...(receipt.blocking_findings ?? [])]
    .map((f) => `${f.severity}:${f.location?.path ?? ''}:${f.location?.line ?? ''}:${f.claim}`)
    .sort();
  const payload = [
    receipt.receipt_id,
    receipt.candidate_digest,
    receipt.head_sha,
    receipt.verdict,
    receipt.reviewer_id,
    receipt.reviewer_model,
    receipt.independence?.attestation_digest ?? null,
    receipt.coverage?.is_sufficient ?? null,
    normFindings,
    normBlockingFindings,
    receipt.provenance ?? 'LOCAL_UNAUTHENTICATED',
  ];
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

export function evaluateMergeReadiness(input: {
  candidate: CandidateEnvelope;
  reviews: CodeReviewReceipt[];
  deterministicTests?: DeterministicTestReceipt;
  remoteCIChecks?: RemoteCICheckObservation[];
  securityReceipt?: SecurityReceipt;
  now?: string;
}): MergeReadinessReceipt {
  const headSha = input.candidate.head_sha;
  const blockers: string[] = [];
  let escalationReason: HumanEscalationReason | null = null;

  // 1. Evaluate Code Reviews
  // Enforce candidate digest binding
  for (const r of input.reviews) {
    if (r.candidate_digest !== input.candidate.candidate_digest) {
      blockers.push('review_receipt_candidate_digest_mismatch');
    }
  }

  // Enforce trusted provenance: reject unauthenticated local review evidence for authoritative gates
  for (const r of input.reviews) {
    if (r.provenance === 'LOCAL_UNAUTHENTICATED') {
      blockers.push('unauthenticated_local_review_evidence_rejected_for_authoritative_gate');
    }
  }

  // Detect conflicting review evidence before deduplicating
  const seenReceipts = new Map<string, { receipt: CodeReviewReceipt; digest: string }>();
  let hasConflictingEvidence = false;
  for (const r of input.reviews) {
    const rDigest = computeCanonicalReceiptDigest(r);
    const existing = seenReceipts.get(r.receipt_id);
    if (existing) {
      if (existing.digest !== rDigest) {
        hasConflictingEvidence = true;
        blockers.push(`conflicting_review_evidence_detected:${r.receipt_id}`);
      }
    } else {
      seenReceipts.set(r.receipt_id, { receipt: r, digest: rDigest });
    }
  }

  // Deduplicate identical receipts by receipt_id
  const uniqueReviews = Array.from(seenReceipts.values()).map((v) => v.receipt);

  const headReviews = uniqueReviews.filter((r) => r.head_sha === headSha);
  if (headReviews.length < uniqueReviews.length) {
    blockers.push('stale_review_receipt_rejected_for_prior_head');
  }

  const approvedReviews = headReviews.filter(
    (r) =>
      r.verdict === 'APPROVE' &&
      r.coverage.is_sufficient &&
      r.blocking_findings.length === 0 &&
      r.provenance !== 'LOCAL_UNAUTHENTICATED'
  );

  const requiredGates = resolveRequiredGates(input.candidate.risk_tier);
  const minRequiredReviews = requiredGates.codeReview.minApprovals;

  let codeReviewStatus: 'PASS' | 'FAIL' | 'INSUFFICIENT' = 'PASS';
  const allBlockingFindings = headReviews.flatMap((r) => r.blocking_findings);

  if (hasConflictingEvidence) {
    codeReviewStatus = 'FAIL';
  } else if (allBlockingFindings.length > 0) {
    codeReviewStatus = 'FAIL';
    blockers.push(`blocking_findings_present:${allBlockingFindings.length}`);
  } else if (headReviews.some((r) => !r.coverage.is_sufficient)) {
    codeReviewStatus = 'INSUFFICIENT';
    blockers.push('insufficient_review_coverage');
  } else if (approvedReviews.length < minRequiredReviews) {
    codeReviewStatus = 'INSUFFICIENT';
    blockers.push(`insufficient_approved_reviews:have_${approvedReviews.length}_need_${minRequiredReviews}`);
  } else if (requiredGates.codeReview.requireI4) {
    const ensemble = evaluateEnsembleIndependence({
      reviews: approvedReviews.map((r) => r.independence),
    });
    if (ensemble.computed_class !== 'I4') {
      codeReviewStatus = 'INSUFFICIENT';
      blockers.push('critical_risk_tier_requires_ensemble_i4_independence');
      blockers.push('critical_risk_tier_requires_distinct_independent_reviewer_models');
    }
  }

  // 2. Evaluate Deterministic Tests
  let testStatus: 'PASS' | 'FAIL' | 'UNAVAILABLE' = 'UNAVAILABLE';
  if (input.deterministicTests) {
    if (input.deterministicTests.head_sha !== headSha) {
      testStatus = 'FAIL';
      blockers.push('deterministic_tests_stale_for_head');
    } else if (input.deterministicTests.status === 'PASS' && input.deterministicTests.failed_count === 0) {
      testStatus = 'PASS';
    } else {
      testStatus = 'FAIL';
      blockers.push(`deterministic_tests_failed:${input.deterministicTests.failed_count}`);
    }
  } else if (requiredGates.deterministicTests) {
    blockers.push('deterministic_tests_required_but_unavailable');
  }

  // 3. Evaluate Remote CI
  let ciStatus: 'PASS' | 'FAIL' | 'PENDING' | 'UNAVAILABLE' = 'UNAVAILABLE';
  const failedChecks: string[] = [];
  let successCount = 0;

  if (input.remoteCIChecks && input.remoteCIChecks.length > 0) {
    const headChecks = input.remoteCIChecks.filter((c) => c.head_sha === headSha);
    if (headChecks.length === 0 && requiredGates.remoteCI) {
      blockers.push('remote_ci_checks_required_but_unavailable');
    } else {
      for (const check of headChecks) {
        if (check.status !== 'completed') {
          // Pending
        } else if (check.conclusion === 'success') {
          successCount++;
        } else if (check.conclusion === 'failure' || check.conclusion === 'timed_out') {
          failedChecks.push(check.name);
        }
      }

      if (failedChecks.length > 0) {
        ciStatus = 'FAIL';
        blockers.push(`remote_ci_checks_failed:${failedChecks.join(',')}`);
      } else if (headChecks.some((c) => c.status !== 'completed')) {
        ciStatus = 'PENDING';
        blockers.push('remote_ci_checks_pending');
      } else if (successCount > 0) {
        ciStatus = 'PASS';
      }
    }
  } else if (requiredGates.remoteCI) {
    blockers.push('remote_ci_checks_required_but_unavailable');
  }

  // 4. Evaluate Security Scan
  let secStatus: 'PASS' | 'FAIL' | 'UNAVAILABLE' = 'UNAVAILABLE';
  if (input.securityReceipt) {
    if (input.securityReceipt.head_sha !== headSha) {
      secStatus = 'FAIL';
      blockers.push('security_scan_stale_for_head');
    } else if (input.securityReceipt.status === 'PASS' && input.securityReceipt.gitleaks_passed) {
      secStatus = 'PASS';
    } else {
      secStatus = 'FAIL';
      blockers.push('security_scan_failed');
    }
  } else if (requiredGates.securityScan) {
    blockers.push('security_scan_required_but_unavailable');
  }

  // 5. Synthesize Readiness Verdict
  let verdict: ReadinessVerdict = 'READY';
  if (allBlockingFindings.length > 0 || ciStatus === 'FAIL' || testStatus === 'FAIL' || secStatus === 'FAIL' || codeReviewStatus === 'FAIL') {
    verdict = 'REPAIR';
  } else if (
    codeReviewStatus === 'INSUFFICIENT' ||
    ciStatus === 'PENDING' ||
    (requiredGates.deterministicTests && testStatus === 'UNAVAILABLE') ||
    (requiredGates.securityScan && secStatus === 'UNAVAILABLE') ||
    (requiredGates.remoteCI && ciStatus === 'UNAVAILABLE')
  ) {
    verdict = 'INSUFFICIENT';
  } else if (blockers.length > 0) {
    verdict = 'INSUFFICIENT';
  }

  const now = input.now ?? new Date().toISOString();
  const receiptPayload = [
    input.candidate.candidate_digest,
    headSha,
    verdict,
    blockers,
    codeReviewStatus,
    testStatus,
    ciStatus,
    secStatus,
    now,
  ];
  const receiptHash = createHash('sha256').update(JSON.stringify(receiptPayload)).digest('hex');
  const readinessId = createHash('sha256').update(`readiness:${receiptHash}`).digest('hex').slice(0, 32);

  return {
    schema_version: 2,
    readiness_id: readinessId,
    candidate_digest: input.candidate.candidate_digest,
    head_sha: headSha,
    verdict,
    gate_checks: {
      code_review: {
        status: codeReviewStatus,
        approved_reviews_count: approvedReviews.length,
        blocking_findings_count: allBlockingFindings.length,
        receipt_ids: headReviews.map((r) => r.receipt_id),
      },
      deterministic_tests: {
        status: testStatus,
        details: input.deterministicTests ? `passed: ${input.deterministicTests.passed_count}` : undefined,
      },
      remote_ci: {
        status: ciStatus,
        total_checks: input.remoteCIChecks?.length ?? 0,
        successful_checks: successCount,
        failed_checks: failedChecks,
      },
      security_scan: {
        status: secStatus,
        details: input.securityReceipt ? `gitleaks: ${input.securityReceipt.gitleaks_passed}` : undefined,
      },
    },
    unresolved_blockers: blockers,
    escalation_reason: escalationReason,
    receipt_hash: receiptHash,
    evaluated_at: now,
  };
}
