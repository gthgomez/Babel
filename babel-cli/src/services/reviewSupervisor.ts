import type {
  IndependentReviewerClassV1,
  ReviewChallengeRecordV1,
  ReviewChallengeV1,
} from '../evidence/independentReview.js';

export interface ReviewSupervisor {
  issue(input: Omit<ReviewChallengeV1, 'challenge_id'> & {
    repository: string;
    pr_number?: number;
    reviewer_class: IndependentReviewerClassV1;
  }): ReviewChallengeV1;
  get(challengeId: string): ReviewChallengeRecordV1 | undefined;
  revoke(challengeId: string): void;
}

export interface ReviewSupervisorBackend extends ReviewSupervisor {}

/**
 * Keeps challenge lifecycle authority separate from substantive AI review and
 * from the builder. The backend owns supervisor signing and ledger custody.
 */
export function createReviewSupervisor(backend: ReviewSupervisorBackend): ReviewSupervisor {
  return Object.freeze({
    issue: (input: Parameters<ReviewSupervisor['issue']>[0]) => backend.issue(input),
    get: (challengeId: string) => backend.get(challengeId),
    revoke: (challengeId: string) => backend.revoke(challengeId),
  });
}
