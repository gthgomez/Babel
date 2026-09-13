import { createHash } from 'node:crypto';

export type IndependenceClass = 'I0' | 'I1' | 'I2' | 'I3' | 'I4';
export type LineageComparison = 'SAME' | 'DIFFERENT' | 'UNKNOWN';

export interface IndependenceDimensions {
  fresh_context: boolean;
  fresh_process: boolean;
  read_only_capability: boolean;
  controller_state_isolated: boolean;
  builder_identity: string;
  reviewer_identity: string;
  builder_model?: string;
  reviewer_model: string;
  builder_provider?: string;
  reviewer_provider: string;
  trusted_harness: boolean;
  trusted_source_sha: string;
  installation_digest: string;
  process_id?: number;
  session_id?: string;
  sandbox_profile?: string;
  multi_agent?: boolean;
  finding_verification?: boolean;
}

export interface ReviewerIndependenceAttestation {
  schema_version: 2;
  computed_class: IndependenceClass;
  dimensions: IndependenceDimensions;
  attestation_digest: string;
  evaluated_at: string;
}

export interface EnsembleIndependenceAttestation {
  schema_version: 2;
  computed_class: IndependenceClass;
  reviewer_count: number;
  distinct_models: string[];
  distinct_providers: string[];
  verified_findings_count: number;
  attestation_digest: string;
  evaluated_at: string;
}

export function compareModelLineage(builderModel?: string, reviewerModel?: string): LineageComparison {
  if (!builderModel || !reviewerModel) return 'UNKNOWN';
  const bNorm = builderModel.toLowerCase().trim();
  const rNorm = reviewerModel.toLowerCase().trim();
  if (bNorm === rNorm) return 'SAME';
  const bFamily = bNorm.split(/[-_]/)[0];
  const rFamily = rNorm.split(/[-_]/)[0];
  if (bFamily === rFamily) return 'SAME';
  return 'DIFFERENT';
}

export function compareProviderLineage(builderProvider?: string, reviewerProvider?: string): LineageComparison {
  if (!builderProvider || !reviewerProvider) return 'UNKNOWN';
  const bNorm = builderProvider.toLowerCase().trim();
  const rNorm = reviewerProvider.toLowerCase().trim();
  if (bNorm === rNorm) return 'SAME';
  return 'DIFFERENT';
}

export function computeIndependenceClass(dimensions: IndependenceDimensions): IndependenceClass {
  // If builder and reviewer are identical or same non-isolated session/context: I0
  if (
    !dimensions.fresh_context ||
    !dimensions.read_only_capability ||
    dimensions.builder_identity.toLowerCase() === dimensions.reviewer_identity.toLowerCase()
  ) {
    return 'I0';
  }

  const modelComp = compareModelLineage(dimensions.builder_model, dimensions.reviewer_model);
  const providerComp = compareProviderLineage(dimensions.builder_provider, dimensions.reviewer_provider);

  // Unknown builder model or provider NEVER implies difference.
  // Affirmatively different requires known distinct provider or known distinct model family.
  const isAffirmativelyDifferent =
    providerComp === 'DIFFERENT' || (modelComp === 'DIFFERENT' && providerComp !== 'SAME');

  // I4: Multiple independent agents + finding verification + verified harness + distinct providers/models
  if (
    dimensions.fresh_process &&
    dimensions.controller_state_isolated &&
    dimensions.trusted_harness &&
    dimensions.multi_agent &&
    dimensions.finding_verification &&
    isAffirmativelyDifferent
  ) {
    return 'I4';
  }

  // I3: Distinct model / provider family + fresh process + verified harness provenance
  if (
    dimensions.fresh_process &&
    dimensions.controller_state_isolated &&
    dimensions.trusted_harness &&
    isAffirmativelyDifferent
  ) {
    return 'I3';
  }

  // I2: Fresh process + read-only sandbox + independent review prompt
  if (dimensions.fresh_process && dimensions.controller_state_isolated) {
    return 'I2';
  }

  // I1: Fresh context, same general model family or non-isolated process
  return 'I1';
}

export function evaluateReviewerIndependence(
  dimensions: IndependenceDimensions,
  now: string = new Date().toISOString(),
): ReviewerIndependenceAttestation {
  const computedClass = computeIndependenceClass(dimensions);
  const digest = createHash('sha256')
    .update(JSON.stringify([computedClass, dimensions, now]))
    .digest('hex');

  return {
    schema_version: 2,
    computed_class: computedClass,
    dimensions,
    attestation_digest: digest,
    evaluated_at: now,
  };
}

export function evaluateEnsembleIndependence(input: {
  reviews: ReviewerIndependenceAttestation[];
  verifiedFindingsCount?: number;
  now?: string;
}): EnsembleIndependenceAttestation {
  const now = input.now ?? new Date().toISOString();
  const reviews = input.reviews;
  if (reviews.length === 0) {
    return {
      schema_version: 2,
      computed_class: 'I0',
      reviewer_count: 0,
      distinct_models: [],
      distinct_providers: [],
      verified_findings_count: 0,
      attestation_digest: createHash('sha256').update('empty-ensemble').digest('hex'),
      evaluated_at: now,
    };
  }

  const distinctModels = [...new Set(reviews.map((r) => r.dimensions.reviewer_model))];
  const distinctProviders = [...new Set(reviews.map((r) => r.dimensions.reviewer_provider))];
  const verifiedCount = input.verifiedFindingsCount ?? 0;

  const sessionIds = reviews.map((r) => r.dimensions.session_id?.trim()).filter((s): s is string => !!s);
  const allReviewsHaveSessionId = sessionIds.length === reviews.length;
  const hasUniqueSessionIds = allReviewsHaveSessionId && new Set(sessionIds).size === reviews.length;
  const hasUniqueAttestations = new Set(reviews.map((r) => r.attestation_digest)).size === reviews.length;
  const hasDistinctExecutions = reviews.length >= 2 && hasUniqueSessionIds && hasUniqueAttestations;

  const hasAffirmativelyDifferentModels =
    distinctModels.length >= 2 &&
    reviews.every((r1, i) =>
      reviews
        .slice(i + 1)
        .every((r2) => compareModelLineage(r1.dimensions.reviewer_model, r2.dimensions.reviewer_model) === 'DIFFERENT')
    );

  const allIsolated = reviews.every(
    (r) =>
      r.dimensions.fresh_process &&
      r.dimensions.controller_state_isolated &&
      r.dimensions.trusted_harness &&
      r.dimensions.read_only_capability
  );

  let ensembleClass: IndependenceClass = 'I1';
  if (reviews.some((r) => r.computed_class === 'I0')) {
    ensembleClass = 'I0';
  } else if (hasDistinctExecutions && allIsolated && hasAffirmativelyDifferentModels) {
    // I4 is earned at ensemble level when >=2 distinct executions with affirmatively different model lineages run in isolated harness
    ensembleClass = 'I4';
  } else if (reviews.every((r) => r.computed_class === 'I3' || r.computed_class === 'I2')) {
    ensembleClass = 'I3';
  } else if (reviews.every((r) => r.computed_class !== 'I0')) {
    ensembleClass = 'I2';
  }

  const digest = createHash('sha256')
    .update(JSON.stringify([ensembleClass, distinctModels, distinctProviders, verifiedCount, sessionIds, now]))
    .digest('hex');

  return {
    schema_version: 2,
    computed_class: ensembleClass,
    reviewer_count: reviews.length,
    distinct_models: distinctModels,
    distinct_providers: distinctProviders,
    verified_findings_count: verifiedCount,
    attestation_digest: digest,
    evaluated_at: now,
  };
}
