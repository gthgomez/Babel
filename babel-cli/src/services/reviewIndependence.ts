import { createHash } from 'node:crypto';

export type IndependenceClass = 'I0' | 'I1' | 'I2' | 'I3' | 'I4';

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

export function computeIndependenceClass(dimensions: IndependenceDimensions): IndependenceClass {
  // If builder and reviewer are identical or same non-isolated session/context: I0
  if (
    !dimensions.fresh_context ||
    !dimensions.read_only_capability ||
    dimensions.builder_identity.toLowerCase() === dimensions.reviewer_identity.toLowerCase()
  ) {
    return 'I0';
  }

  const isSameFamily =
    dimensions.builder_model &&
    dimensions.reviewer_model &&
    (dimensions.builder_model === dimensions.reviewer_model ||
      dimensions.builder_model.split(/[-_]/)[0] === dimensions.reviewer_model.split(/[-_]/)[0]);

  const isDifferentProvider =
    dimensions.builder_provider &&
    dimensions.reviewer_provider &&
    dimensions.builder_provider.toLowerCase() !== dimensions.reviewer_provider.toLowerCase();

  // I4: Multiple independent agents + finding verification + strong execution provenance
  if (
    dimensions.fresh_process &&
    dimensions.controller_state_isolated &&
    dimensions.trusted_harness &&
    dimensions.multi_agent &&
    dimensions.finding_verification
  ) {
    return 'I4';
  }

  // I3: Distinct model / provider family + fresh process + verified harness provenance
  if (
    dimensions.fresh_process &&
    dimensions.controller_state_isolated &&
    dimensions.trusted_harness &&
    (isDifferentProvider || !isSameFamily)
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
