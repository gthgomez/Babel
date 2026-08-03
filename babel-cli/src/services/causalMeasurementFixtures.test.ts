/**
 * Slice 5: provider-free measurement fixtures — oracle, detectors, conservation.
 *
 * Proves measurement substrate wiring only; not live causal claims.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  detectHarnessSuppressed,
  detectHonestyCatch,
  FALSE_COMPLETE_TRANSCRIPT,
  INJECTED_BOUNDARY_TRANSCRIPT,
  KNOWN_GOOD_TRANSCRIPT,
  makeScriptedTranscript,
  runCorruptDigestConservationFixture,
  runHonestyCatchFixture,
  runInjectedSuppressionFixture,
  runIdentityMismatchFixture,
  runKnownGoodMeasurementFixture,
  runTrustedFixtureVerifier,
  runTruncatedDigestFixture,
} from './causalMeasurementFixtures.js';

describe('runTrustedFixtureVerifier', () => {
  test('known-good oracle pass (write + verify success)', () => {
    const oracle = runTrustedFixtureVerifier(KNOWN_GOOD_TRANSCRIPT);
    assert.equal(oracle.verified_pass, true);
    assert.equal(oracle.reason, 'write_and_verify_ok');
  });

  test('injected boundary transcript fails oracle (no successful write)', () => {
    const oracle = runTrustedFixtureVerifier(INJECTED_BOUNDARY_TRANSCRIPT);
    assert.equal(oracle.verified_pass, false);
    assert.ok(
      oracle.reason.includes('missing_successful_write') ||
        oracle.reason.includes('missing_successful_verify') ||
        oracle.reason.includes('fatal'),
      oracle.reason,
    );
  });

  test('false complete transcript fails oracle', () => {
    const oracle = runTrustedFixtureVerifier(FALSE_COMPLETE_TRANSCRIPT);
    assert.equal(oracle.verified_pass, false);
    assert.ok(
      oracle.reason.includes('missing_successful_write') ||
        oracle.reason.includes('missing_successful_verify'),
      oracle.reason,
    );
  });

  test('empty transcript fails', () => {
    const t = makeScriptedTranscript({ id: 'empty', steps: [] });
    const oracle = runTrustedFixtureVerifier(t);
    assert.equal(oracle.verified_pass, false);
    assert.equal(oracle.reason, 'empty_transcript');
  });
});

describe('detectHarnessSuppressed', () => {
  test('injected boundary → harness_suppressed true', () => {
    const control = runTrustedFixtureVerifier(KNOWN_GOOD_TRANSCRIPT);
    const enforce = runTrustedFixtureVerifier(INJECTED_BOUNDARY_TRANSCRIPT);
    const signal = detectHarnessSuppressed(control, enforce);
    assert.equal(control.verified_pass, true);
    assert.equal(enforce.verified_pass, false);
    assert.equal(signal.harness_suppressed, true);
    assert.equal(signal.control_verified_pass, true);
    assert.equal(signal.babel_enforce_non_pass, true);
  });

  test('non_pass shape input also detects suppression', () => {
    const control = runTrustedFixtureVerifier(KNOWN_GOOD_TRANSCRIPT);
    const signal = detectHarnessSuppressed(control, {
      non_pass: true,
      signature: 'agent:blocked_policy',
    });
    assert.equal(signal.harness_suppressed, true);
  });

  test('both pass → no suppression', () => {
    const pass = runTrustedFixtureVerifier(KNOWN_GOOD_TRANSCRIPT);
    const signal = detectHarnessSuppressed(pass, pass);
    assert.equal(signal.harness_suppressed, false);
  });
});

describe('detectHonestyCatch', () => {
  test('honesty_catch true for false complete + babel reject', () => {
    const oracle = runTrustedFixtureVerifier(FALSE_COMPLETE_TRANSCRIPT);
    assert.equal(oracle.verified_pass, false);
    const signal = detectHonestyCatch(true, oracle, true);
    assert.equal(signal.control_false_complete, true);
    assert.equal(signal.babel_correct_reject, true);
    assert.equal(signal.honesty_catch, true);
  });

  test('no honesty catch when babel does not reject', () => {
    const oracle = runTrustedFixtureVerifier(FALSE_COMPLETE_TRANSCRIPT);
    const signal = detectHonestyCatch(true, oracle, false);
    assert.equal(signal.control_false_complete, true);
    assert.equal(signal.honesty_catch, false);
  });

  test('no false complete when oracle passes', () => {
    const oracle = runTrustedFixtureVerifier(KNOWN_GOOD_TRANSCRIPT);
    const signal = detectHonestyCatch(true, oracle, true);
    assert.equal(signal.control_false_complete, false);
    assert.equal(signal.honesty_catch, false);
  });
});

describe('campaign-shaped measurement fixtures', () => {
  test('known-good measurement fixture produces capability pass path when FTP green', () => {
    const result = runKnownGoodMeasurementFixture();
    assert.equal(result.oracle.verified_pass, true);
    assert.equal(result.derived.eligibility.campaign_complete, true);
    assert.equal(result.derived.eligibility.artifact_valid, true);
    assert.equal(result.derived.intent_to_treat_capability.numerator, 1);
    assert.equal(result.derived.intent_to_treat_capability.denominator, 1);
    assert.equal(result.capability_verified_pass, true);
    assert.equal(result.derived.attempts[0]!.axes.host_fail_to_pass, 'pass');
    assert.equal(result.derived.attempts[0]!.capability_verified_pass, true);
  });

  test('injected suppression fixture wires harness_suppressed + boundary counters', () => {
    const result = runInjectedSuppressionFixture();
    assert.equal(result.controlOracle.verified_pass, true);
    assert.equal(result.enforceOracle.verified_pass, false);
    assert.equal(result.signal.harness_suppressed, true);
    assert.ok(result.boundary.force_mutate_shadow_count >= 1);
    assert.ok(result.boundary.policy_deny_count >= 1);
    assert.ok(result.boundary.denied_or_failed_write_tool_count >= 1);
    assert.equal(result.boundary.successful_write_tool_count, 0);
  });

  test('honesty catch fixture returns honesty_catch true', () => {
    const result = runHonestyCatchFixture();
    assert.equal(result.controlOracle.verified_pass, false);
    assert.equal(result.signal.honesty_catch, true);
    assert.equal(result.signal.control_false_complete, true);
    assert.equal(result.signal.babel_correct_reject, true);
  });

  test('corrupt/unexpected attempt fails conservation and artifact_valid', () => {
    const result = runCorruptDigestConservationFixture();
    assert.equal(result.conservation.ok, false);
    assert.ok(
      result.conservation.errors.some((e) => e.includes('unexpected')),
      result.conservation.errors.join('; '),
    );
    assert.equal(result.derived.eligibility.artifact_valid, false);
    assert.equal(result.derived.conservation_ok, false);

    // Duplicate + missing path
    assert.equal(result.duplicateConservation.ok, false);
    assert.ok(
      result.duplicateConservation.errors.some(
        (e) => e.includes('duplicate') || e.includes('missing'),
      ),
      result.duplicateConservation.errors.join('; '),
    );

    // Orphan reconcile exercised (process dead + grace 0)
    assert.ok(
      result.orphanReconcile.orphaned_attempt_ids.length >= 1 ||
        result.orphanReconcile.campaign_complete === true ||
        result.orphanReconcile.notes.length > 0,
      JSON.stringify(result.orphanReconcile),
    );
  });

  test('identity mismatch fails artifact_valid', () => {
    const result = runIdentityMismatchFixture();
    assert.equal(result.artifact_valid, false);
    assert.equal(result.derived.eligibility.artifact_valid, false);
    assert.equal(result.derived.eligibility.reliability_eligible, false);
    assert.ok(
      result.derived.notes.some((n) => n.includes('identity_mismatch')),
      result.derived.notes.join('; '),
    );
  });

  test('truncated digest / missing attempt fails conservation', () => {
    const result = runTruncatedDigestFixture();
    assert.equal(result.conservation.ok, false);
    assert.ok(
      result.conservation.errors.some((e) => e.includes('missing')),
      result.conservation.errors.join('; '),
    );
    assert.equal(result.derived.eligibility.artifact_valid, false);
  });
});
