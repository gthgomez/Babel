import { createHash, sign, verify, type KeyObject } from 'node:crypto';

import { canonicalJson } from '../acceptance/canonical.js';

export interface ReviewExecutionAttestation {
  schema_version: 1;
  execution_id: string;
  reviewer_principal: string;
  reviewer_model: string;
  review_provider: string;
  repository: string;
  pr_number?: number;
  base_sha: string;
  head_sha: string;
  builder_identity: string;
  context_digest: string;
  result_digest: string;
  capability_profile: {
    candidate_write: false;
    github_mutation: false;
    merge: false;
    signing_keys: false;
  };
  reviewed_scope: { kind: 'files'; paths: string[] } | { kind: 'repository' };
  reviewed_at: string;
  signature: { algorithm: 'ed25519'; key_id: string; value: string };
}

function unsignedAttestation(attestation: ReviewExecutionAttestation): Omit<ReviewExecutionAttestation, 'signature'> {
  const { signature: _signature, ...unsigned } = attestation;
  return unsigned;
}

export function reviewAttestationBytes(attestation: ReviewExecutionAttestation): Buffer {
  return Buffer.from(canonicalJson(unsignedAttestation(attestation)), 'utf8');
}

export function reviewAttestationDigest(attestation: ReviewExecutionAttestation): string {
  return createHash('sha256').update(reviewAttestationBytes(attestation)).digest('hex');
}

export function reviewResultDigest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function signReviewAttestation(
  attestation: Omit<ReviewExecutionAttestation, 'signature'>,
  keyId: string,
  privateKey: KeyObject | string,
): ReviewExecutionAttestation {
  const signed: ReviewExecutionAttestation = {
    ...attestation,
    signature: { algorithm: 'ed25519', key_id: keyId, value: '' },
  };
  signed.signature.value = sign(null, reviewAttestationBytes(signed), privateKey).toString('base64url');
  return Object.freeze(signed);
}

export function validateReviewExecutionAttestation(
  attestation: unknown,
  expected: {
    repository: string;
    pr_number?: number;
    base_sha: string;
    head_sha: string;
    builder_identity: string;
    result_digest: string;
    reviewerKey?: KeyObject | string;
    now?: number;
    maxAgeMs?: number;
  },
): string[] {
  const errors: string[] = [];
  if (!attestation || typeof attestation !== 'object' || Array.isArray(attestation)) return ['attestation_shape'];
  const candidate = attestation as Partial<ReviewExecutionAttestation>;
  for (const key of ['execution_id', 'reviewer_principal', 'reviewer_model', 'review_provider', 'repository', 'base_sha', 'head_sha', 'builder_identity', 'context_digest', 'result_digest', 'reviewed_at'] as const) {
    if (typeof candidate[key] !== 'string' || candidate[key] === '') errors.push(key);
  }
  if (candidate.schema_version !== 1) errors.push('schema_version');
  if (candidate.repository !== expected.repository) errors.push('repository');
  if (expected.pr_number !== undefined && candidate.pr_number !== expected.pr_number) errors.push('pr_number');
  if (candidate.base_sha !== expected.base_sha) errors.push('base_sha');
  if (candidate.head_sha !== expected.head_sha) errors.push('head_sha');
  if (candidate.builder_identity !== expected.builder_identity) errors.push('builder_identity');
  if (candidate.result_digest !== expected.result_digest) errors.push('result_digest');
  if (candidate.reviewer_principal === expected.builder_identity) errors.push('reviewer_not_independent');
  const capabilities = candidate.capability_profile;
  if (!capabilities || capabilities.candidate_write !== false || capabilities.github_mutation !== false || capabilities.merge !== false || capabilities.signing_keys !== false) errors.push('capability_profile');
  if (!candidate.reviewed_scope) errors.push('reviewed_scope');
  const reviewedAt = Date.parse(candidate.reviewed_at ?? '');
  const now = expected.now ?? Date.now();
  if (!Number.isFinite(reviewedAt) || reviewedAt > now + 5 * 60 * 1000 || reviewedAt < now - (expected.maxAgeMs ?? 24 * 60 * 60 * 1000)) errors.push('reviewed_at');
  const signature = candidate.signature;
  if (!signature || signature.algorithm !== 'ed25519' || !signature.key_id || !signature.value) errors.push('signature');
  if (expected.reviewerKey && signature?.value && !verify(null, reviewAttestationBytes(candidate as ReviewExecutionAttestation), expected.reviewerKey, Buffer.from(signature.value, 'base64url'))) errors.push('signature_invalid');
  return [...new Set(errors)];
}
