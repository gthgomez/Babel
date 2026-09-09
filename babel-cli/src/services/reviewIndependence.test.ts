import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeIndependenceClass,
  evaluateReviewerIndependence,
  evaluateEnsembleIndependence,
  type IndependenceDimensions,
} from './reviewIndependence.js';

test('reviewIndependence: non-isolated context or matching builder/reviewer yields I0', () => {
  const base: IndependenceDimensions = {
    fresh_context: false,
    fresh_process: false,
    read_only_capability: true,
    controller_state_isolated: false,
    builder_identity: 'agent-impl',
    reviewer_identity: 'agent-impl',
    reviewer_model: 'mimo-v2.5',
    reviewer_provider: 'opencode-go',
    trusted_harness: true,
    trusted_source_sha: '0000000000000000000000000000000000000000',
    installation_digest: 'abcdef',
  };

  assert.equal(computeIndependenceClass(base), 'I0');

  // Even if fresh_context is true, identical identities yield I0
  assert.equal(
    computeIndependenceClass({
      ...base,
      fresh_context: true,
      read_only_capability: true,
      builder_identity: 'codex',
      reviewer_identity: 'codex',
    }),
    'I0'
  );
});

test('reviewIndependence: fresh context same process yields I1', () => {
  const dims: IndependenceDimensions = {
    fresh_context: true,
    fresh_process: false,
    read_only_capability: true,
    controller_state_isolated: false,
    builder_identity: 'builder-codex',
    reviewer_identity: 'reviewer-deepseek',
    reviewer_model: 'deepseek-v3',
    reviewer_provider: 'deepseek',
    trusted_harness: false,
    trusted_source_sha: '0000000000000000000000000000000000000000',
    installation_digest: 'abcdef',
  };

  assert.equal(computeIndependenceClass(dims), 'I1');
});

test('reviewIndependence: fresh process + read-only sandbox yields I2 or I3', () => {
  const dimsI2: IndependenceDimensions = {
    fresh_context: true,
    fresh_process: true,
    read_only_capability: true,
    controller_state_isolated: true,
    builder_identity: 'builder-agent',
    reviewer_identity: 'reviewer-agent',
    builder_model: 'deepseek-chat',
    reviewer_model: 'deepseek-coder',
    builder_provider: 'deepseek',
    reviewer_provider: 'deepseek',
    trusted_harness: false,
    trusted_source_sha: '0000000000000000000000000000000000000000',
    installation_digest: 'abcdef',
  };

  assert.equal(computeIndependenceClass(dimsI2), 'I2');

  const dimsI3: IndependenceDimensions = {
    ...dimsI2,
    builder_model: 'codex',
    reviewer_model: 'mimo-v2.5',
    builder_provider: 'openai',
    reviewer_provider: 'opencode-go',
    trusted_harness: true,
  };

  assert.equal(computeIndependenceClass(dimsI3), 'I3');
});

test('reviewIndependence: multi-agent + verified findings yields I4', () => {
  const dimsI4: IndependenceDimensions = {
    fresh_context: true,
    fresh_process: true,
    read_only_capability: true,
    controller_state_isolated: true,
    builder_identity: 'builder-agent',
    reviewer_identity: 'reviewer-agent',
    builder_model: 'codex',
    reviewer_model: 'mimo-v2.5',
    builder_provider: 'openai',
    reviewer_provider: 'opencode-go',
    trusted_harness: true,
    trusted_source_sha: '0000000000000000000000000000000000000000',
    installation_digest: 'abcdef',
    multi_agent: true,
    finding_verification: true,
  };

  assert.equal(computeIndependenceClass(dimsI4), 'I4');

  const attestation = evaluateReviewerIndependence(dimsI4);
  assert.equal(attestation.computed_class, 'I4');
  assert.match(attestation.attestation_digest, /^[a-f0-9]{64}$/);
});

test('reviewIndependence: unknown builder model lowers independence to I2', () => {
  const dimsUnknownBuilder: IndependenceDimensions = {
    fresh_context: true,
    fresh_process: true,
    read_only_capability: true,
    controller_state_isolated: true,
    builder_identity: 'builder-agent',
    reviewer_identity: 'reviewer-agent',
    // builder_model and builder_provider are undefined/unknown
    reviewer_model: 'mimo-v2.5',
    reviewer_provider: 'opencode-go',
    trusted_harness: true,
    trusted_source_sha: '0000000000000000000000000000000000000000',
    installation_digest: 'abcdef',
  };

  // Must NOT earn I3! Unknown builder yields I2.
  assert.equal(computeIndependenceClass(dimsUnknownBuilder), 'I2');
});

test('reviewIndependence: evaluateEnsembleIndependence computes round-level I4 across distinct models', () => {
  const r1 = evaluateReviewerIndependence({
    fresh_context: true,
    fresh_process: true,
    read_only_capability: true,
    controller_state_isolated: true,
    builder_identity: 'builder-agent',
    reviewer_identity: 'reviewer-1',
    builder_model: 'deepseek-v3',
    reviewer_model: 'mimo-v2.5',
    builder_provider: 'deepseek',
    reviewer_provider: 'opencode-go',
    trusted_harness: true,
    trusted_source_sha: '0000000000000000000000000000000000000000',
    installation_digest: 'abcdef',
  });

  const r2 = evaluateReviewerIndependence({
    fresh_context: true,
    fresh_process: true,
    read_only_capability: true,
    controller_state_isolated: true,
    builder_identity: 'builder-agent',
    reviewer_identity: 'reviewer-2',
    builder_model: 'deepseek-v3',
    reviewer_model: 'longcat-2.0',
    builder_provider: 'deepseek',
    reviewer_provider: 'longcat-ai',
    trusted_harness: true,
    trusted_source_sha: '0000000000000000000000000000000000000000',
    installation_digest: 'abcdef',
  });

  const ensemble = evaluateEnsembleIndependence({
    reviews: [r1, r2],
    verifiedFindingsCount: 2,
  });

  assert.equal(ensemble.computed_class, 'I4');
  assert.equal(ensemble.reviewer_count, 2);
  assert.deepEqual(ensemble.distinct_models, ['mimo-v2.5', 'longcat-2.0']);
  assert.match(ensemble.attestation_digest, /^[a-f0-9]{64}$/);
});

