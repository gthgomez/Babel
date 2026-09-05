import type {
  IndependentReviewReceiptV2,
  IndependentReviewerClassV1,
  IndependentReviewModeV1,
} from '../evidence/independentReview.js';
import type { ReviewExecutionAttestation } from './reviewProvenance.js';

export type IndependentReviewTerminalStatus =
  | 'REVIEWER_CONFIGURATION_REQUIRED'
  | 'REVIEW_ORCHESTRATOR_REQUIRED'
  | 'ISSUER_CONFIGURATION_REQUIRED'
  | 'SUPERVISOR_CONFIGURATION_REQUIRED'
  | 'REPAIR_REQUIRED'
  | 'CERTIFICATION_RETRY_REQUIRED'
  | 'READY_FOR_TRUST_VERIFICATION'
  | 'CERTIFIED'
  | 'STOPPED_EXTERNAL_CAPABILITY'
  | 'STOPPED_AMBIGUOUS_OBJECTIVE';

export type IndependentReviewBlocker =
  | 'MISSING_REVIEWER'
  | 'MISSING_REVIEW_ORCHESTRATOR'
  | 'MISSING_REVIEW_ATTESTATION'
  | 'MISSING_ISSUER'
  | 'MISSING_SUPERVISOR'
  | 'MISSING_SIGNING_AUTHORITY'
  | 'VERIFICATION_FAILURE';

export interface IndependentReviewCandidate {
  repository: string;
  pr_number?: number;
  task_id: string;
  run_id: string;
  contract_hash: string;
  base_sha: string;
  head_sha: string;
  builder_id: string;
  reviewed_scope: IndependentReviewReceiptV2['reviewed_scope'];
}

export interface IndependentReviewVerdict {
  repository: string;
  pr_number?: number;
  base_sha: string;
  head_sha: string;
  builder_identity: string;
  reviewer_identity: string;
  reviewer_model: string;
  review_provider: string;
  review_mode: 'independent-read-only';
  verdict: 'PASS' | 'FAIL';
  blocking_findings: string[];
  non_blocking_findings: string[];
  tests_considered: string[];
  reviewed_at: string;
  provenance?: ReviewExecutionAttestation;
}

export interface IndependentReviewInvocation {
  candidate: IndependentReviewCandidate;
  reviewer_class: IndependentReviewerClassV1;
  review_mode: IndependentReviewModeV1;
  readonly: true;
  github_mutation_allowed: false;
  candidate_write_allowed: false;
}

export interface IndependentReviewProvider {
  review(input: IndependentReviewInvocation): Promise<IndependentReviewVerdict>;
}

export interface TrustedReviewIssuer {
  certify(input: {
    candidate: IndependentReviewCandidate;
    verdict: IndependentReviewVerdict;
    provenance: ReviewExecutionAttestation;
    reviewer_class: IndependentReviewerClassV1;
    review_mode: IndependentReviewModeV1;
  }): Promise<IndependentReviewReceiptV2>;
}

export interface TrustedReviewVerifier {
  verify(input: {
    candidate: IndependentReviewCandidate;
    receipt: IndependentReviewReceiptV2;
  }): Promise<{ passed: boolean; errors?: string[] }>;
}

export interface IndependentReviewBrokerResult {
  status: IndependentReviewTerminalStatus;
  candidate: IndependentReviewCandidate;
  verdict?: IndependentReviewVerdict;
  receipt?: IndependentReviewReceiptV2;
  blocker?: IndependentReviewBlocker;
  verification_errors?: string[];
  next: string[];
}

function assertCandidate(candidate: IndependentReviewCandidate): void {
  for (const name of ['repository', 'task_id', 'run_id', 'contract_hash', 'base_sha', 'head_sha', 'builder_id'] as const) {
    const value = candidate[name];
    if (typeof value !== 'string' || value.trim() === '') throw new Error(`Independent review candidate requires ${name}.`);
  }
  if (!/^[0-9a-f]{40}$/i.test(candidate.base_sha)) throw new Error('Independent review candidate base_sha must be a full SHA.');
  if (!/^[0-9a-f]{40}$/i.test(candidate.head_sha)) throw new Error('Independent review candidate head_sha must be a full SHA.');
  if (candidate.pr_number !== undefined && (!Number.isInteger(candidate.pr_number) || candidate.pr_number < 1)) throw new Error('Independent review candidate pr_number must be positive.');
}

function assertVerdict(candidate: IndependentReviewCandidate, verdict: IndependentReviewVerdict): void {
  if (verdict.repository !== candidate.repository || verdict.pr_number !== candidate.pr_number) throw new Error('Independent review verdict repository or PR binding mismatch.');
  if (verdict.base_sha !== candidate.base_sha || verdict.head_sha !== candidate.head_sha) throw new Error('Independent review verdict exact SHA binding mismatch.');
  if (verdict.builder_identity !== candidate.builder_id) throw new Error('Independent review verdict builder binding mismatch.');
  if (verdict.reviewer_identity === candidate.builder_id) throw new Error('Independent review reviewer must be distinct from builder.');
  if (verdict.verdict === 'PASS' && verdict.blocking_findings.length > 0) throw new Error('Independent review PASS cannot contain blocking findings.');
  if (verdict.verdict !== 'PASS' && verdict.verdict !== 'FAIL') throw new Error('Independent review verdict must be PASS or FAIL.');
}

/** Commission read-only analysis, then separately certify and verify it. */
export async function runIndependentReviewBroker(input: {
  candidate: IndependentReviewCandidate;
  provider?: IndependentReviewProvider;
  issuer?: TrustedReviewIssuer;
  verifier?: TrustedReviewVerifier;
  reviewer_class?: IndependentReviewerClassV1;
  review_mode?: IndependentReviewModeV1;
}): Promise<IndependentReviewBrokerResult> {
  assertCandidate(input.candidate);
  if (!input.provider) return { status: 'REVIEW_ORCHESTRATOR_REQUIRED', candidate: input.candidate, blocker: 'MISSING_REVIEW_ORCHESTRATOR', next: ['Configure an isolated read-only reviewer and retry certification.'] };
  const reviewerClass = input.reviewer_class ?? 'independent_readonly';
  const reviewMode = input.review_mode ?? 'exact_head';
  const verdict = await input.provider.review({ candidate: input.candidate, reviewer_class: reviewerClass, review_mode: reviewMode, readonly: true, github_mutation_allowed: false, candidate_write_allowed: false });
  assertVerdict(input.candidate, verdict);
  if (verdict.verdict === 'FAIL') return { status: 'REPAIR_REQUIRED', candidate: input.candidate, verdict, next: ['Repair blocking findings and review the exact resulting head again.'] };
  if (!verdict.provenance) return { status: 'ISSUER_CONFIGURATION_REQUIRED', candidate: input.candidate, verdict, blocker: 'MISSING_REVIEW_ATTESTATION', next: ['Configure the reviewer provenance signer before requesting trusted certification.'] };
  if (!input.issuer) return { status: 'ISSUER_CONFIGURATION_REQUIRED', candidate: input.candidate, verdict, blocker: 'MISSING_ISSUER', next: ['Configure the trusted reviewer issuer and supervisor lane.'] };
  const receipt = await input.issuer.certify({ candidate: input.candidate, verdict, provenance: verdict.provenance, reviewer_class: reviewerClass, review_mode: reviewMode });
  if (receipt.repository !== input.candidate.repository || receipt.pr_number !== input.candidate.pr_number || receipt.base_sha !== input.candidate.base_sha || receipt.head_sha !== input.candidate.head_sha || receipt.builder_id !== input.candidate.builder_id || receipt.reviewer_id === input.candidate.builder_id || receipt.verdict !== 'APPROVE') return { status: 'CERTIFICATION_RETRY_REQUIRED', candidate: input.candidate, verdict, receipt, blocker: 'VERIFICATION_FAILURE', next: ['Reject the receipt and retry through the trusted issuer.'] };
  if (!input.verifier) return { status: 'READY_FOR_TRUST_VERIFICATION', candidate: input.candidate, verdict, receipt, next: ['Run the base-rooted trusted-control-plane verifier.'] };
  const verification = await input.verifier.verify({ candidate: input.candidate, receipt });
  if (!verification.passed) return { status: 'CERTIFICATION_RETRY_REQUIRED', candidate: input.candidate, verdict, receipt, blocker: 'VERIFICATION_FAILURE', verification_errors: verification.errors ?? [], next: ['Repair the verification failure and certify the exact current head again.'] };
  return { status: 'CERTIFIED', candidate: input.candidate, verdict, receipt, next: ['Continue to the protected merge gate.'] };
}
