/**
 * Risk-lane review policy.
 *
 * Single source of truth for how much independent review evidence a candidate
 * requires at each risk lane. `mergeReadinessBroker.resolveRequiredGates`
 * derives its gate requirements from this policy so the two cannot drift.
 */

export type ReviewRiskLane = 'TRIVIAL' | 'NORMAL' | 'ELEVATED' | 'CRITICAL' | 'AMBIGUOUS';

/** Canonical lane membership so consumers do not re-declare (and drift from) it. */
export const REVIEW_RISK_LANES: readonly ReviewRiskLane[] = ['TRIVIAL', 'NORMAL', 'ELEVATED', 'CRITICAL', 'AMBIGUOUS'];

export function asReviewRiskLane(value: string): ReviewRiskLane {
  return (REVIEW_RISK_LANES as readonly string[]).includes(value) ? (value as ReviewRiskLane) : 'AMBIGUOUS';
}

export interface ReviewPolicy {
  workingReviewCount: 1 | 2;
  finalCertificationCount: 1 | 2;
  requireFreshContext: boolean;
  requireRuntimeDiversity: boolean;
  requireModelDiversity: boolean;
  requiredIndependenceClass: 'I0' | 'I1' | 'I2' | 'I3' | 'I4';
  deterministicTestsRequired: boolean;
  remoteCIRequired: boolean;
  securityRequired: boolean;
}

/** ELEVATED-equivalent policy, also used for AMBIGUOUS and any unknown lane. */
const ELEVATED_POLICY: ReviewPolicy = {
  workingReviewCount: 2,
  finalCertificationCount: 2,
  requireFreshContext: true,
  requireRuntimeDiversity: false,
  requireModelDiversity: false,
  requiredIndependenceClass: 'I2',
  deterministicTestsRequired: true,
  remoteCIRequired: true,
  securityRequired: true,
};

export function resolveReviewPolicy(input: {
  riskLane: ReviewRiskLane;
  requireAuthoritative: boolean;
}): ReviewPolicy {
  // `requireAuthoritative` is part of the canonical signature so callers always
  // state whether the evidence is authoritative; the value does not change the
  // floors below.
  void input.requireAuthoritative;
  switch (input.riskLane) {
    case 'TRIVIAL':
      return {
        workingReviewCount: 1,
        finalCertificationCount: 1,
        requireFreshContext: true,
        requireRuntimeDiversity: false,
        requireModelDiversity: false,
        requiredIndependenceClass: 'I2',
        deterministicTestsRequired: false,
        remoteCIRequired: false,
        securityRequired: false,
      };
    case 'NORMAL':
      return {
        workingReviewCount: 1,
        finalCertificationCount: 1,
        requireFreshContext: true,
        requireRuntimeDiversity: false,
        requireModelDiversity: false,
        requiredIndependenceClass: 'I2',
        deterministicTestsRequired: true,
        remoteCIRequired: false,
        securityRequired: false,
      };
    case 'CRITICAL':
      return {
        workingReviewCount: 2,
        finalCertificationCount: 2,
        requireFreshContext: true,
        requireRuntimeDiversity: false,
        requireModelDiversity: false,
        requiredIndependenceClass: 'I4',
        deterministicTestsRequired: true,
        remoteCIRequired: true,
        securityRequired: true,
      };
    case 'ELEVATED':
    case 'AMBIGUOUS':
    default:
      // AMBIGUOUS/unknown preserve the historical ELEVATED-equivalent floor
      // (all gates on, no I4 ensemble requirement) rather than silently
      // tightening existing protection strength to CRITICAL.
      return { ...ELEVATED_POLICY };
  }
}
