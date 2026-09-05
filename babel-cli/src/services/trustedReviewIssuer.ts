import { createHash, type KeyObject } from 'node:crypto';

import {
  type IndependentReviewReceiptV2,
  type IndependentReviewerClassV1,
  type IndependentReviewModeV1,
  type ReviewChallengeV1,
} from '../evidence/independentReview.js';
import {
  validateReviewExecutionAttestation,
  reviewResultDigest,
  type ReviewExecutionAttestation,
} from './reviewProvenance.js';
import type {
  IndependentReviewCandidate,
  IndependentReviewVerdict,
  TrustedReviewIssuer,
} from './independentReviewBroker.js';

export interface TrustedReviewAuthority {
  issueChallenge(input: Omit<ReviewChallengeV1, 'challenge_id'> & {
    repository: string;
    pr_number?: number;
    reviewer_class: IndependentReviewerClassV1;
  }): ReviewChallengeV1;
  issueReceipt(input: {
    challenge: ReviewChallengeV1;
    reviewer_id: string;
    reviewer_class: IndependentReviewerClassV1;
    review_mode: IndependentReviewModeV1;
    reviewed_at?: string;
    reviewed_scope: IndependentReviewReceiptV2['reviewed_scope'];
    verdict: 'APPROVE' | 'BLOCK' | 'UNKNOWN';
    blocking_findings?: string[];
    repository: string;
    pr_number?: number;
  }): IndependentReviewReceiptV2;
}

export interface TrustedReviewIssuerOptions {
  authority: TrustedReviewAuthority;
  reviewerKeyId: string;
  reviewerPublicKey: KeyObject | string;
  now?: () => number;
  maxAgeMs?: number;
}

function digestableVerdict(verdict: IndependentReviewVerdict): Omit<IndependentReviewVerdict, 'provenance'> {
  const { provenance: _provenance, ...withoutProvenance } = verdict;
  return withoutProvenance;
}

function assertIssuerInput(
  candidate: IndependentReviewCandidate,
  verdict: IndependentReviewVerdict,
  provenance: ReviewExecutionAttestation,
  reviewerKeyId: string,
  reviewerKey?: KeyObject | string,
  now?: number,
  maxAgeMs?: number,
): void {
  const errors = validateReviewExecutionAttestation(provenance, {
    repository: candidate.repository,
    ...(candidate.pr_number !== undefined ? { pr_number: candidate.pr_number } : {}),
    base_sha: candidate.base_sha,
    head_sha: candidate.head_sha,
    builder_identity: candidate.builder_id,
    result_digest: reviewResultDigest(digestableVerdict(verdict)),
    ...(reviewerKey ? { reviewerKey } : {}),
    ...(now !== undefined ? { now } : {}),
    ...(maxAgeMs !== undefined ? { maxAgeMs } : {}),
  });
  if (errors.length > 0) throw new Error(`Review execution attestation rejected: ${errors.join(', ')}`);
  if (provenance.signature.key_id !== reviewerKeyId) throw new Error('Review execution reviewer key mismatch.');
  if (provenance.reviewer_principal !== verdict.reviewer_identity) throw new Error('Review execution reviewer principal mismatch.');
  if (provenance.reviewer_model !== verdict.reviewer_model || provenance.review_provider !== verdict.review_provider) throw new Error('Review execution provider metadata mismatch.');
  if (verdict.verdict !== 'PASS' || verdict.blocking_findings.length > 0) throw new Error('Only a non-blocking PASS can be certified.');
}

/**
 * Adapter for a separately operated authority lane. Private keys are held by
 * the authority implementation and are never accepted by the builder API.
 */
export function createTrustedReviewIssuer(options: TrustedReviewIssuerOptions): TrustedReviewIssuer {
  return {
    certify: async ({ candidate, verdict, provenance, reviewer_class, review_mode }) => {
      const now = options.now?.() ?? Date.now();
      assertIssuerInput(candidate, verdict, provenance, options.reviewerKeyId, options.reviewerPublicKey, now, options.maxAgeMs);
      const issuedAt = new Date(now).toISOString();
      const expiresAt = new Date(now + (options.maxAgeMs ?? 15 * 60 * 1000)).toISOString();
      const challenge = options.authority.issueChallenge({
        task_id: candidate.task_id,
        run_id: candidate.run_id,
        contract_hash: candidate.contract_hash,
        base_sha: candidate.base_sha,
        head_sha: candidate.head_sha,
        builder_id: candidate.builder_id,
        issued_at: issuedAt,
        expires_at: expiresAt,
        repository: candidate.repository,
        ...(candidate.pr_number !== undefined ? { pr_number: candidate.pr_number } : {}),
        reviewer_class,
      });
      return options.authority.issueReceipt({
        challenge,
        reviewer_id: verdict.reviewer_identity,
        reviewer_class,
        review_mode,
        reviewed_at: verdict.reviewed_at,
        reviewed_scope: candidate.reviewed_scope,
        verdict: 'APPROVE',
        blocking_findings: [],
        repository: candidate.repository,
        ...(candidate.pr_number !== undefined ? { pr_number: candidate.pr_number } : {}),
      });
    },
  };
}

// createFileBackedTrustedReviewAuthority has moved to
// `./reviewTrustedAuthority.js` — a trusted-service-only module. Authority
// construction must never be importable from builder-facing code; see
// `reviewCustody.test.ts` for the architectural enforcement.

export function trustedReviewContractDigest(): string {
  return createHash('sha256').update('babel-independent-review-v1').digest('hex');
}
