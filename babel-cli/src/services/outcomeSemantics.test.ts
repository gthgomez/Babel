import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveOutcome, type OutcomeDimensions } from './outcomeSemantics.js';
import {
  classifyCodingTaskGateDetailed,
  isCodingTaskSuccess,
} from './codingTaskSuccess.js';
import { buildVerifierReceiptV2 } from '../agent/verifierKernel.js';
import type { TerminalOutcome } from '../schemas/agentContracts.js';

/** Canonical H5 receipt for a green authoritative full-suite run (P0-F O05/O06 fixture). */
function greenCanonicalReceipt(revisionHash = 'abc123') {
  return buildVerifierReceiptV2({
    receipt_id: 'gate-r1',
    verifier_id: 'npm-test',
    argv: ['npm', 'test'],
    cwd: '.',
    env_profile_hash: 'test-env',
    started_at: '2026-08-15T00:00:00.000Z',
    ended_at: '2026-08-15T00:00:01.000Z',
    exit_code: 0,
    stdout: 'ok',
    stderr: '',
    workspace_revision: { compositeTreeHash: revisionHash },
    scope: 'full_suite',
    command: 'npm test',
    authoritative: true,
    freshness: 'fresh',
  });
}

function dims(overrides: Partial<OutcomeDimensions>): OutcomeDimensions {
  return {
    workerClaimedSuccess: false,
    mutationProduced: false,
    verificationRequired: false,
    verificationAttempted: false,
    verificationAuthoritative: false,
    verificationFresh: false,
    visibleChecksPass: false,
    contractChecksPass: null,
    independentReviewPass: null,
    terminalOutcome: null,
    ...overrides,
  };
}

test('outcome: verified successful task → VERIFIED_COMPLETE, no false completion', () => {
  const r = resolveOutcome(
    dims({
      workerClaimedSuccess: true,
      mutationProduced: true,
      verificationRequired: true,
      verificationAttempted: true,
      verificationAuthoritative: true,
      verificationFresh: true,
      visibleChecksPass: true,
      contractChecksPass: true,
      terminalOutcome: 'VERIFIED_COMPLETE',
    }),
  );
  assert.equal(r.label, 'VERIFIED_COMPLETE');
  assert.equal(r.verifiedSuccess, true);
  assert.equal(r.falseCompletion, false);
});

test('outcome: legitimate unverified patch is NOT a false completion', () => {
  // §10: verification_required=false, patch produced, honestly reported.
  const r = resolveOutcome(
    dims({
      workerClaimedSuccess: true,
      mutationProduced: true,
      terminalOutcome: 'UNVERIFIED_PATCH',
    }),
  );
  assert.equal(r.label, 'UNVERIFIED_PATCH');
  assert.equal(r.verifiedSuccess, false);
  assert.equal(r.falseCompletion, false);
});

test('outcome: worker claims done, verifier fails → FALSE_COMPLETION', () => {
  const r = resolveOutcome(
    dims({
      workerClaimedSuccess: true,
      mutationProduced: true,
      verificationRequired: true,
      verificationAttempted: true,
      verificationAuthoritative: true,
      verificationFresh: true,
      visibleChecksPass: false,
    }),
  );
  assert.equal(r.label, 'FALSE_COMPLETION');
  assert.equal(r.falseCompletion, true);
});

test('outcome: canonical T03 — visible pass, contract fail → FALSE_COMPLETION', () => {
  const r = resolveOutcome(
    dims({
      workerClaimedSuccess: true,
      mutationProduced: true,
      verificationRequired: true,
      verificationAttempted: true,
      verificationAuthoritative: true,
      verificationFresh: true,
      visibleChecksPass: true,
      contractChecksPass: false,
    }),
  );
  assert.equal(r.label, 'FALSE_COMPLETION');
  assert.equal(r.falseCompletion, true);
});

test('outcome: verifier stale for changed workspace revision → FALSE_COMPLETION', () => {
  const r = resolveOutcome(
    dims({
      workerClaimedSuccess: true,
      mutationProduced: true,
      verificationRequired: true,
      verificationAttempted: true,
      verificationAuthoritative: true,
      verificationFresh: false,
      visibleChecksPass: true,
    }),
  );
  assert.equal(r.label, 'FALSE_COMPLETION');
  assert.equal(r.falseCompletion, true);
});

test('outcome: no mutation + claimed success → FALSE_COMPLETION (empty patch)', () => {
  const r = resolveOutcome(
    dims({
      workerClaimedSuccess: true,
      mutationProduced: false,
    }),
  );
  assert.equal(r.label, 'FALSE_COMPLETION');
  assert.equal(r.falseCompletion, true);
});

test('outcome: blocked environment is BLOCKED, not false completion', () => {
  for (const t of ['BLOCKED_POLICY', 'BLOCKED_EXTERNAL', 'NEEDS_HUMAN_DECISION'] as TerminalOutcome[]) {
    const r = resolveOutcome(dims({ terminalOutcome: t, workerClaimedSuccess: true }));
    assert.equal(r.label, 'BLOCKED');
    assert.equal(r.falseCompletion, false);
  }
});

test('outcome: provider / environment / harness failures are FAILED, not false completion', () => {
  for (const t of ['INFRA_FAILURE', 'AGENT_FAILURE', 'BUDGET_EXHAUSTED', 'CANCELLED'] as TerminalOutcome[]) {
    const r = resolveOutcome(dims({ terminalOutcome: t, workerClaimedSuccess: true }));
    assert.equal(r.label, 'FAILED');
    assert.equal(r.falseCompletion, false);
  }
});

test('outcome: verification missing under a required-verification claim → FALSE_COMPLETION', () => {
  const r = resolveOutcome(
    dims({
      workerClaimedSuccess: true,
      mutationProduced: true,
      verificationRequired: true,
      verificationAttempted: false,
    }),
  );
  assert.equal(r.label, 'FALSE_COMPLETION');
  assert.equal(r.falseCompletion, true);
});

test('outcome: non-authoritative verifier (agent-owned probe) → FALSE_COMPLETION', () => {
  const r = resolveOutcome(
    dims({
      workerClaimedSuccess: true,
      mutationProduced: true,
      verificationRequired: true,
      verificationAttempted: true,
      verificationAuthoritative: false,
      verificationFresh: true,
      visibleChecksPass: true,
    }),
  );
  assert.equal(r.label, 'FALSE_COMPLETION');
});

// ─── Integration with the coding-task gate (§11 invariant) ──────────────────

const G = {
  // P0-F: verified success now requires the canonical receipt + workspace
  // revision + completion-gate result — a bare verifierOk cannot certify.
  verifiedComplete: {
    terminalOutcome: 'VERIFIED_COMPLETE' as TerminalOutcome,
    statusText: 'COMPLETE',
    hasSuccessfulMutation: true,
    verifierOk: true,
    requireVerifier: true,
    verifierReceipt: greenCanonicalReceipt(),
    workspaceRevisionHash: 'abc123',
    contractChecksPass: true,
  },
  legitUnverified: {
    terminalOutcome: 'UNVERIFIED_PATCH' as TerminalOutcome,
    statusText: 'COMPLETE',
    hasSuccessfulMutation: true,
    requireVerifier: false,
  },
  claimButVerifierFails: {
    terminalOutcome: 'UNVERIFIED_PATCH' as TerminalOutcome,
    statusText: 'COMPLETE',
    hasSuccessfulMutation: true,
    verifierOk: false,
    requireVerifier: true,
  },
  noMutationClaim: {
    terminalOutcome: 'UNVERIFIED_PATCH' as TerminalOutcome,
    statusText: 'COMPLETE',
    hasSuccessfulMutation: false,
  },
  blocked: {
    terminalOutcome: 'BLOCKED_POLICY' as TerminalOutcome,
    statusText: 'BLOCKED',
    hasSuccessfulMutation: false,
    declaredBlocked: true,
  },
  infra: {
    terminalOutcome: 'INFRA_FAILURE' as TerminalOutcome,
    statusText: 'INFRA_FAILURE',
    hasSuccessfulMutation: false,
  },
};

test('coding-gate invariant: generic pass ≠ verified_success', () => {
  // Legit unverified patch: legacy `pass` MUST NOT imply verified_success.
  const unverified = classifyCodingTaskGateDetailed(G.legitUnverified);
  assert.equal(unverified.verdict, 'pass');
  assert.equal(unverified.verifiedSuccess, false);
  assert.equal(unverified.falseCompletion, false);

  const verified = classifyCodingTaskGateDetailed(G.verifiedComplete);
  assert.equal(verified.verdict, 'pass');
  assert.equal(verified.verifiedSuccess, true);
  assert.equal(verified.falseCompletion, false);
});

test('coding-gate: bare verifierOk cannot certify verified_success (P0-F O05)', () => {
  // Same claim shape as G.verifiedComplete but WITHOUT receipt/revision/gate
  // result — the legacy boolean must not fabricate authoritative/fresh.
  const bare = classifyCodingTaskGateDetailed({
    terminalOutcome: 'VERIFIED_COMPLETE' as TerminalOutcome,
    statusText: 'COMPLETE',
    hasSuccessfulMutation: true,
    verifierOk: true,
    requireVerifier: true,
  });
  assert.equal(bare.verdict, 'pass'); // legacy verdict unchanged
  assert.equal(bare.verifiedSuccess, false); // not certified by a bare boolean
  assert.equal(bare.falseCompletion, true); // claim implied verified success
});

test('coding-gate: claim + failing verifier is fail + FALSE_COMPLETION', () => {
  const r = classifyCodingTaskGateDetailed(G.claimButVerifierFails);
  assert.equal(r.verdict, 'fail');
  assert.equal(r.falseCompletion, true);
});

test('coding-gate: no mutation + claim is fail + FALSE_COMPLETION', () => {
  const r = classifyCodingTaskGateDetailed(G.noMutationClaim);
  assert.equal(r.verdict, 'fail');
  assert.equal(r.falseCompletion, true);
});

test('coding-gate: blocked and infra outcomes are never success and never false completion', () => {
  const blocked = classifyCodingTaskGateDetailed(G.blocked);
  assert.equal(blocked.verdict, 'diagnostic');
  assert.equal(blocked.verifiedSuccess, false);
  assert.equal(blocked.falseCompletion, false);

  const infra = classifyCodingTaskGateDetailed(G.infra);
  assert.equal(infra.verdict, 'fail');
  assert.equal(infra.falseCompletion, false);
});

test('coding-gate: isCodingTaskSuccess keeps legacy behavior (backward compat)', () => {
  assert.equal(isCodingTaskSuccess(G.verifiedComplete), true);
  assert.equal(isCodingTaskSuccess(G.legitUnverified), true);
  assert.equal(isCodingTaskSuccess(G.claimButVerifierFails), false);
  assert.equal(isCodingTaskSuccess(G.blocked), false);
});
