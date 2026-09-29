/**
 * Risk-lane review policy.
 *
 * Single source of truth for how much independent review evidence a candidate
 * requires at each risk lane. `mergeReadinessBroker.resolveRequiredGates`
 * derives its gate requirements from this policy so the two cannot drift.
 */
import { readFileSync } from 'node:fs';

const sharedRiskPolicy = JSON.parse(readFileSync(new URL('../../../config/review-risk-policy.json', import.meta.url), 'utf8')) as {
  criticalPrefixes: string[];
  elevatedPrefixes: string[];
  hostProtectedPrefixes: string[];
  finalCertificationCount: Record<ReviewRiskLane, 1 | 2>;
};

if (!Array.isArray(sharedRiskPolicy.hostProtectedPrefixes) || sharedRiskPolicy.hostProtectedPrefixes.length === 0) {
  throw new Error('REVIEW_HOST_PROTECTED_POLICY_REQUIRED');
}
const hostProtectedPrefixes = sharedRiskPolicy.hostProtectedPrefixes;

/** Normalize a candidate path and test it against a prefix list (case-insensitive, `/`-separated, trailing-slash tolerant). */
function matchesAnyPrefix(path: string, prefixes: string[]): boolean {
  return prefixes.some((prefix) => {
    const value = prefix.toLowerCase();
    const normalized = path.replace(/\\/g, '/').toLowerCase();
    return normalized.startsWith(value) || normalized === value.replace(/\/$/, '');
  });
}

export function classifyReviewRisk(scope: string[]): ReviewRiskLane {
  if (scope.length === 0) return 'AMBIGUOUS';
  if (scope.some((path) => matchesAnyPrefix(path, hostProtectedPrefixes) || matchesAnyPrefix(path, sharedRiskPolicy.criticalPrefixes))) return 'CRITICAL';
  if (scope.some((path) => matchesAnyPrefix(path, sharedRiskPolicy.elevatedPrefixes))) return 'ELEVATED';
  if (scope.every((path) => /\.(md|txt)$/i.test(path) || path.startsWith('docs/'))) return 'TRIVIAL';
  return 'NORMAL';
}

/**
 * Producer-side reviewer authority.
 *
 * `SESSION_ATTESTED` is the ordinary lane: a harness-native fresh child review
 * with no root-owned binary required. `HOST_PROTECTED` is required when any
 * changed path touches the reviewer/gate/authority path, where a
 * previously trusted base-rooted controller must attest the review instead.
 */
export type ReviewAuthority = 'SESSION_ATTESTED' | 'HOST_PROTECTED';

export function resolveReviewAuthority(scope: string[]): ReviewAuthority {
  const hostProtected = scope.some((path) => matchesAnyPrefix(path, hostProtectedPrefixes));
  return scope.length === 0 || hostProtected ? 'HOST_PROTECTED' : 'SESSION_ATTESTED';
}

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
  finalCertificationCount: sharedRiskPolicy.finalCertificationCount.ELEVATED,
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
        finalCertificationCount: sharedRiskPolicy.finalCertificationCount.TRIVIAL,
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
        finalCertificationCount: sharedRiskPolicy.finalCertificationCount.NORMAL,
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
        finalCertificationCount: sharedRiskPolicy.finalCertificationCount.CRITICAL,
        requireFreshContext: true,
        requireRuntimeDiversity: false,
        requireModelDiversity: false,
        requiredIndependenceClass: 'I2',
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
