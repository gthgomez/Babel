import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeIndependenceClass,
  evaluateReviewerIndependence,
  evaluateEnsembleIndependence,
  compareModelLineage,
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
    session_id: 'session-exec-1',
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
    session_id: 'session-exec-2',
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

test('reviewIndependence: Section D invariants - missing or duplicate session IDs never earn I4', () => {
  const baseDim = {
    fresh_context: true,
    fresh_process: true,
    read_only_capability: true,
    controller_state_isolated: true,
    builder_identity: 'builder-agent',
    builder_model: 'deepseek-v3',
    builder_provider: 'deepseek',
    trusted_harness: true,
    trusted_source_sha: '0'.repeat(40),
    installation_digest: 'abcdef',
  };

  // Case 1: Two reviews, both missing session IDs -> MUST NOT earn I4
  const rNoSession1 = evaluateReviewerIndependence({
    ...baseDim,
    reviewer_identity: 'reviewer-1',
    reviewer_model: 'mimo-v2.5',
    reviewer_provider: 'opencode-go',
    // session_id omitted
  });
  const rNoSession2 = evaluateReviewerIndependence({
    ...baseDim,
    reviewer_identity: 'reviewer-2',
    reviewer_model: 'longcat-2.0',
    reviewer_provider: 'longcat-ai',
    // session_id omitted
  });
  const ensBothMissing = evaluateEnsembleIndependence({ reviews: [rNoSession1, rNoSession2] });
  assert.equal(ensBothMissing.computed_class, 'I3');

  // Case 2: One missing session ID -> MUST NOT earn I4
  const rWithSession = evaluateReviewerIndependence({
    ...baseDim,
    reviewer_identity: 'reviewer-1',
    reviewer_model: 'mimo-v2.5',
    reviewer_provider: 'opencode-go',
    session_id: 'session-123',
  });
  const ensOneMissing = evaluateEnsembleIndependence({ reviews: [rWithSession, rNoSession2] });
  assert.equal(ensOneMissing.computed_class, 'I3');

  // Case 3: Duplicate session ID -> MUST NOT earn I4
  const rDupSession = evaluateReviewerIndependence({
    ...baseDim,
    reviewer_identity: 'reviewer-2',
    reviewer_model: 'longcat-2.0',
    reviewer_provider: 'longcat-ai',
    session_id: 'session-123', // duplicate!
  });
  const ensDupSession = evaluateEnsembleIndependence({ reviews: [rWithSession, rDupSession] });
  assert.equal(ensDupSession.computed_class, 'I3');

  // Case 4: Duplicate attestation -> MUST NOT earn I4
  const ensDupAttestation = evaluateEnsembleIndependence({ reviews: [rWithSession, rWithSession] });
  assert.equal(ensDupAttestation.computed_class, 'I3');

  // Case 5: Clean zero-finding candidate with two genuinely distinct executions -> EARNS I4
  const rDistinct2 = evaluateReviewerIndependence({
    ...baseDim,
    reviewer_identity: 'reviewer-2',
    reviewer_model: 'longcat-2.0',
    reviewer_provider: 'longcat-ai',
    session_id: 'session-456',
  });
  const ensCleanDistinct = evaluateEnsembleIndependence({
    reviews: [rWithSession, rDistinct2],
    verifiedFindingsCount: 0,
  });
  assert.equal(ensCleanDistinct.computed_class, 'I4');
});

test('reviewIndependence: compareModelLineage identifies same-family models correctly', () => {
  assert.equal(compareModelLineage('claude-3-5-sonnet', 'claude-3-7-sonnet'), 'SAME');
  assert.equal(compareModelLineage('gpt-4o', 'gpt-4o-mini'), 'SAME');
  assert.equal(compareModelLineage('gemini-1.5-pro', 'gemini-2.0-flash'), 'SAME');
  assert.equal(compareModelLineage('claude-3-5-sonnet', 'gpt-4o'), 'DIFFERENT');
  assert.equal(compareModelLineage('deepseek-v3', 'mimo-v2.5'), 'DIFFERENT');
  assert.equal(compareModelLineage(undefined, 'gpt-4o'), 'UNKNOWN');
});

test('reviewIndependence: same-family models or duplicate sessions fail to earn I4 in ensemble', () => {
  const baseDim = {
    fresh_context: true,
    fresh_process: true,
    read_only_capability: true,
    controller_state_isolated: true,
    builder_identity: 'builder-agent',
    builder_model: 'deepseek-v3',
    builder_provider: 'deepseek',
    trusted_harness: true,
    trusted_source_sha: '0'.repeat(40),
    installation_digest: 'abcdef',
  };

  const rClaude1 = evaluateReviewerIndependence({
    ...baseDim,
    reviewer_identity: 'reviewer-1',
    reviewer_model: 'claude-3-5-sonnet',
    reviewer_provider: 'anthropic',
    session_id: 'session-1',
  });

  const rClaude2 = evaluateReviewerIndependence({
    ...baseDim,
    reviewer_identity: 'reviewer-2',
    reviewer_model: 'claude-3-7-sonnet', // same family!
    reviewer_provider: 'anthropic',
    session_id: 'session-2',
  });

  // Individual reviews are I3
  assert.equal(rClaude1.computed_class, 'I3');
  assert.equal(rClaude2.computed_class, 'I3');

  // Ensemble of same-family models must NOT earn I4!
  const ensembleSameFamily = evaluateEnsembleIndependence({
    reviews: [rClaude1, rClaude2],
  });
  assert.equal(ensembleSameFamily.computed_class, 'I3');

  // Distinct models but duplicate session ID
  const rMimo = evaluateReviewerIndependence({
    ...baseDim,
    reviewer_identity: 'reviewer-3',
    reviewer_model: 'mimo-v2.5',
    reviewer_provider: 'opencode-go',
    session_id: 'session-1', // duplicate session ID with rClaude1!
  });

  const ensembleDuplicateSession = evaluateEnsembleIndependence({
    reviews: [rClaude1, rMimo],
  });
  assert.equal(ensembleDuplicateSession.computed_class, 'I3');
});


