import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  runIndependentReviewBroker,
  type IndependentReviewVerdict,
  type IndependentReviewCandidate,
} from './independentReviewBroker.js';

const candidate: IndependentReviewCandidate = {
  repository: 'gthgomez/Babel',
  pr_number: 138,
  task_id: 'task-138',
  run_id: 'run-138',
  contract_hash: 'a'.repeat(64),
  base_sha: 'b'.repeat(40),
  head_sha: 'c'.repeat(40),
  builder_id: 'builder:luna',
  reviewed_scope: { kind: 'repository' },
};

function verdict(overrides: Partial<IndependentReviewVerdict> = {}): IndependentReviewVerdict {
  return {
    repository: candidate.repository,
    ...(candidate.pr_number !== undefined ? { pr_number: candidate.pr_number } : {}),
    base_sha: candidate.base_sha,
    head_sha: candidate.head_sha,
    builder_identity: candidate.builder_id,
    reviewer_identity: 'reviewer:independent-1',
    reviewer_model: 'fixture',
    review_provider: 'fixture',
    review_mode: 'independent-read-only' as const,
    verdict: 'PASS' as const,
    blocking_findings: [],
    non_blocking_findings: [],
    tests_considered: ['fixture'],
    reviewed_at: new Date().toISOString(),
    provenance: {
      schema_version: 1,
      execution_id: 'fixture-execution',
      reviewer_principal: 'reviewer:independent-1',
      reviewer_model: 'fixture',
      review_provider: 'fixture',
      repository: candidate.repository,
      ...(candidate.pr_number !== undefined ? { pr_number: candidate.pr_number } : {}),
      base_sha: candidate.base_sha,
      head_sha: candidate.head_sha,
      builder_identity: candidate.builder_id,
      context_digest: 'd'.repeat(64),
      result_digest: 'e'.repeat(64),
      capability_profile: { candidate_write: false, github_mutation: false, merge: false, signing_keys: false },
      reviewed_scope: candidate.reviewed_scope,
      reviewed_at: new Date().toISOString(),
      signature: { algorithm: 'ed25519', key_id: 'fixture', value: 'fixture-signature' },
    },
    ...overrides,
  };
}

describe('independentReviewBroker', () => {
  it('does not call an absent reviewer an issuer or human-review blocker', async () => {
    const result = await runIndependentReviewBroker({ candidate });
    assert.equal(result.blocker, 'MISSING_REVIEW_ORCHESTRATOR');
    assert.equal(result.status, 'REVIEW_ORCHESTRATOR_REQUIRED');
  });

  it('returns blocking findings to the builder without certification', async () => {
    const result = await runIndependentReviewBroker({
      candidate,
      provider: { review: async () => verdict({ verdict: 'FAIL', blocking_findings: ['unsafe'] }) },
      issuer: { certify: async () => { throw new Error('must not certify FAIL'); } },
    });
    assert.equal(result.status, 'REPAIR_REQUIRED');
    assert.deepEqual(result.verdict?.blocking_findings, ['unsafe']);
  });

  it('rejects a reviewer that impersonates the builder', async () => {
    await assert.rejects(
      runIndependentReviewBroker({
        candidate,
        provider: { review: async () => verdict({ reviewer_identity: candidate.builder_id }) },
      }),
      /distinct from builder/,
    );
  });

  it('keeps a valid PASS unsigned until a trusted issuer is available', async () => {
    const result = await runIndependentReviewBroker({
      candidate,
      provider: { review: async () => verdict() },
    });
    assert.equal(result.status, 'ISSUER_CONFIGURATION_REQUIRED');
    assert.equal(result.blocker, 'MISSING_ISSUER');
    assert.equal(result.verdict?.verdict, 'PASS');
    assert.equal(result.receipt, undefined);
  });
});
