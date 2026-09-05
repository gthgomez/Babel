import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  createIndependentReviewAuthorityV1,
  validateAuthenticatedIndependentReviewReceiptV1,
} from '../evidence/independentReview.js';
import { runIndependentReviewBroker, type IndependentReviewCandidate, type IndependentReviewVerdict } from './independentReviewBroker.js';
import { reviewResultDigest, signReviewAttestation, type ReviewExecutionAttestation } from './reviewProvenance.js';
import { createTrustedReviewIssuer } from './trustedReviewIssuer.js';

const candidate: IndependentReviewCandidate & { pr_number: number } = {
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

const testLedgerPaths: string[] = [];

function testLedgerPath(name: string): string {
  const ledgerPath = join(process.cwd(), `.babel-review-authority-${name}.json`);
  testLedgerPaths.push(ledgerPath);
  return ledgerPath;
}

afterEach(() => {
  for (const ledgerPath of testLedgerPaths.splice(0)) {
    try {
      unlinkSync(ledgerPath);
    } catch {
      // The test may fail before the authority creates its ledger.
    }
  }
});

function buildVerdict(): IndependentReviewVerdict {
  return {
    repository: candidate.repository,
    pr_number: candidate.pr_number,
    base_sha: candidate.base_sha,
    head_sha: candidate.head_sha,
    builder_identity: candidate.builder_id,
    reviewer_identity: 'reviewer:independent-1',
    reviewer_model: 'fixture-reviewer',
    review_provider: 'fixture-provider',
    review_mode: 'independent-read-only',
    verdict: 'PASS',
    blocking_findings: [],
    non_blocking_findings: [],
    tests_considered: ['trusted-reviewer-fixture'],
    reviewed_at: new Date().toISOString(),
  };
}

describe('trustedReviewIssuer', () => {
  it('issues and verifies a receipt through distinct reviewer and supervisor authorities', async () => {
    const reviewer = generateKeyPairSync('ed25519');
    const supervisor = generateKeyPairSync('ed25519');
    const ledgerPath = testLedgerPath('positive');
    const authority = createIndependentReviewAuthorityV1({
      reviewer_key_id: 'trusted-reviewer-ed25519-v2',
      reviewer_private_key: reviewer.privateKey,
      supervisor_key_id: 'trusted-supervisor-ed25519-v1',
      supervisor_private_key: supervisor.privateKey,
      ledger_path: ledgerPath,
    });
    const issuer = createTrustedReviewIssuer({
      authority,
      reviewerKeyId: 'trusted-reviewer-ed25519-v2',
      reviewerPublicKey: reviewer.publicKey,
    });
    const verdict = buildVerdict();
    const unsignedAttestation: Omit<ReviewExecutionAttestation, 'signature'> = {
      schema_version: 1,
      execution_id: 'execution-138',
      reviewer_principal: verdict.reviewer_identity,
      reviewer_model: verdict.reviewer_model,
      review_provider: verdict.review_provider,
      repository: candidate.repository,
      pr_number: candidate.pr_number,
      base_sha: candidate.base_sha,
      head_sha: candidate.head_sha,
      builder_identity: candidate.builder_id,
      context_digest: 'd'.repeat(64),
      result_digest: reviewResultDigest(verdict),
      capability_profile: { candidate_write: false, github_mutation: false, merge: false, signing_keys: false },
      reviewed_scope: candidate.reviewed_scope,
      reviewed_at: verdict.reviewed_at,
    };
    verdict.provenance = signReviewAttestation(unsignedAttestation, 'trusted-reviewer-ed25519-v2', reviewer.privateKey);
    const result = await runIndependentReviewBroker({
      candidate,
      provider: { review: async () => verdict },
      issuer,
      verifier: {
        verify: async ({ receipt }) => {
          const errors = validateAuthenticatedIndependentReviewReceiptV1(
            receipt,
            new Map([['trusted-reviewer-ed25519-v2', reviewer.publicKey]]),
            new Map([['trusted-supervisor-ed25519-v1', supervisor.publicKey]]),
            ledgerPath,
            {
              repository: candidate.repository,
              pr_number: candidate.pr_number,
              task_id: candidate.task_id,
              run_id: candidate.run_id,
              contract_hash: candidate.contract_hash,
              base_sha: candidate.base_sha,
              head_sha: candidate.head_sha,
              builder_id: candidate.builder_id,
            },
          );
          return { passed: errors.length === 0, errors };
        },
      },
    });
    assert.equal(result.status, 'CERTIFIED');
    assert.ok(result.receipt);
  });

  it('rejects a tampered execution attestation before signing', async () => {
    const reviewer = generateKeyPairSync('ed25519');
    const supervisor = generateKeyPairSync('ed25519');
    const authority = createIndependentReviewAuthorityV1({
      reviewer_key_id: 'trusted-reviewer-ed25519-v2', reviewer_private_key: reviewer.privateKey,
      supervisor_key_id: 'trusted-supervisor-ed25519-v1', supervisor_private_key: supervisor.privateKey,
      ledger_path: testLedgerPath('tampered'),
    });
    const issuer = createTrustedReviewIssuer({ authority, reviewerKeyId: 'trusted-reviewer-ed25519-v2', reviewerPublicKey: reviewer.publicKey });
    const verdict = buildVerdict();
    verdict.provenance = signReviewAttestation({
      schema_version: 1, execution_id: 'execution-tampered', reviewer_principal: verdict.reviewer_identity,
      reviewer_model: verdict.reviewer_model, review_provider: verdict.review_provider, repository: candidate.repository,
      pr_number: candidate.pr_number, base_sha: candidate.base_sha, head_sha: candidate.head_sha,
      builder_identity: candidate.builder_id, context_digest: 'd'.repeat(64), result_digest: 'wrong',
      capability_profile: { candidate_write: false, github_mutation: false, merge: false, signing_keys: false },
      reviewed_scope: candidate.reviewed_scope, reviewed_at: verdict.reviewed_at,
    }, 'trusted-reviewer-ed25519-v2', reviewer.privateKey);
    await assert.rejects(
      issuer.certify({ candidate, verdict, provenance: verdict.provenance, reviewer_class: 'independent_readonly', review_mode: 'exact_head' }),
      /attestation rejected: result_digest/,
    );
  });
});
