/**
 * convergence-outcome.regression-gate.test.ts — RED baseline for canonical outcomes.
 *
 * Locks the P0-F semantic kernel (which is already correct) and demonstrates
 * the adapter gap: dimensionsFromCodingTaskInput fabricates authoritative/fresh
 * verification from the bare `verifierOk` boolean and hardcodes
 * contractChecksPass/independentReviewPass to null. The fix ("derive, don't
 * extend") sources every dimension from TaskContractV1 + VerifierReceiptV2 +
 * workspace revision + completion-gate result + reviewer receipt.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveOutcome, dimensionsFromCodingTaskInput } from './outcomeSemantics.js';
import type { OutcomeDimensions } from './outcomeSemantics.js';

function dims(overrides: Partial<OutcomeDimensions>): OutcomeDimensions {
  return {
    workerClaimedSuccess: true,
    mutationProduced: true,
    verificationRequired: true,
    verificationAttempted: true,
    verificationAuthoritative: true,
    verificationFresh: true,
    visibleChecksPass: true,
    contractChecksPass: null,
    independentReviewPass: null,
    terminalOutcome: null,
    ...overrides,
  };
}

// ─── Kernel semantics (guards — already correct, must not regress) ─────────

test('P0-F: stale verifier receipt is FALSE_COMPLETION (kernel guard)', () => {
  const r = resolveOutcome(dims({ verificationFresh: false }));
  assert.equal(r.label, 'FALSE_COMPLETION');
  assert.equal(r.verifiedSuccess, false);
  assert.equal(r.falseCompletion, true);
});

test('P0-F: non-authoritative verifier is FALSE_COMPLETION (kernel guard)', () => {
  const r = resolveOutcome(dims({ verificationAuthoritative: false }));
  assert.equal(r.label, 'FALSE_COMPLETION');
});

test('P0-F: visible pass + contract fail is FALSE_COMPLETION (kernel guard)', () => {
  const r = resolveOutcome(dims({ contractChecksPass: false }));
  assert.equal(r.label, 'FALSE_COMPLETION');
  assert.equal(r.falseCompletion, true);
});

test('P0-F: accurate unverified patch is NOT false completion (kernel guard)', () => {
  const r = resolveOutcome(dims({ verificationRequired: false }));
  assert.equal(r.label, 'UNVERIFIED_PATCH');
  assert.equal(r.falseCompletion, false);
  assert.equal(r.verifiedSuccess, false);
});

// ─── Adapter adequacy (RED today — the derive-don't-extend fix) ────────────

test('P0-F: adapter must not certify authoritative/fresh from verifierOk alone', () => {
  const d = dimensionsFromCodingTaskInput({
    terminalOutcome: 'VERIFIED_COMPLETE',
    statusText: 'ANSWER_READY',
    hasSuccessfulMutation: true,
    verifierOk: true,
    requireVerifier: true,
  });
  // No receipt and no workspace revision were supplied. A bare boolean cannot
  // certify that verification was authoritative and fresh.
  // Today: both are set to `verifierOk !== undefined` → true. Wrong.
  assert.equal(d.verificationAuthoritative, false);
  assert.equal(d.verificationFresh, false);
});

test('P0-F: adapter surfaces contract-check results (derive from completion gate)', () => {
  const d = dimensionsFromCodingTaskInput({
    terminalOutcome: 'VERIFIED_COMPLETE',
    statusText: 'ANSWER_READY',
    hasSuccessfulMutation: true,
    verifierOk: true,
    requireVerifier: true,
  });
  // The completion-gate decision exists in the runtime; the adapter must feed
  // it through. Today: contractChecksPass is hardcoded null, so the canonical
  // T03 state (visible pass + contract fail) is unrepresentable via the
  // coding-task adapter.
  assert.notEqual(d.contractChecksPass, null);
});
