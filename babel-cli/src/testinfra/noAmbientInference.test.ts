/**
 * Test-safety guard contract: ordinary verification must FAIL if it attempts
 * an unauthorized external model request. This suite pins the guard itself AND
 * the `--import` bootstrap wiring in the `test:unit` script: if the bootstrap
 * is removed, this file fails at load time.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ALLOW_ENV,
  installNoAmbientInferenceGuard,
  isBlockedInferenceHost,
  isNoAmbientInferenceGuardInstalled,
  normalizeInferenceHost,
  requestHostname,
  shouldBlockAmbientInference,
} from './no-ambient-inference.mjs';

// Bootstrap pin: `test:unit` must load register-no-ambient-inference.mjs via
// `--import` before any test file. This assertion fails the suite loudly if the
// bootstrap is ever dropped from package.json.
assert.equal(
  isNoAmbientInferenceGuardInstalled(),
  true,
  'test:unit bootstrap did not install the no-ambient-inference guard',
);

test('guard blocks known inference provider hosts and subdomains', async () => {
  assert.equal(ALLOW_ENV, 'BABEL_TESTS_ALLOW_INFERENCE');
  assert.ok(isBlockedInferenceHost('api.deepinfra.com'));
  assert.ok(isBlockedInferenceHost('opencode.ai'));
  assert.ok(isBlockedInferenceHost('sub.api.openai.com'));
  assert.ok(isBlockedInferenceHost('api.groq.com'));
  assert.ok(!isBlockedInferenceHost('example-deepinfra.com.evil.test'));
  assert.ok(!isBlockedInferenceHost('api.deepinfra.com.cn'));
  assert.ok(!isBlockedInferenceHost('localhost'));
  assert.ok(!isBlockedInferenceHost('127.0.0.1'));
});

test('guard normalizes DNS-absolute and encoded hostnames before classification', async () => {
  assert.equal(normalizeInferenceHost('API.OpenAI.com.'), 'api.openai.com');
  assert.ok(isBlockedInferenceHost('api.openai.com.'));
  assert.ok(isBlockedInferenceHost('api.deepinfra.com.'));
  assert.equal(requestHostname('https://api.openai.com./v1/chat'), 'api.openai.com.');
  assert.ok(shouldBlockAmbientInference('https://api.openai.com./v1/chat', {}));
  assert.ok(shouldBlockAmbientInference('https://api.openai.com%2e/v1/chat', {}));
  assert.ok(shouldBlockAmbientInference('https://api.groq.com/openai/v1/chat/completions', {}));
  assert.ok(!shouldBlockAmbientInference('http://127.0.0.1:1234/v1/chat', {}));
  assert.ok(!shouldBlockAmbientInference('https://example.com/health', {}));
});

test('explicit live-suite opt-in disables only the guard decision', async () => {
  assert.ok(shouldBlockAmbientInference('https://api.deepinfra.com/v1/chat', {}));
  assert.ok(!shouldBlockAmbientInference('https://api.deepinfra.com/v1/chat', { [ALLOW_ENV]: '1' }));
  // A non-'1' value never widens the guard.
  assert.ok(shouldBlockAmbientInference('https://api.deepinfra.com/v1/chat', { [ALLOW_ENV]: 'true' }));
});

test('installed guard turns a provider request into a loud test failure', async () => {
  // The bootstrap normally installs the guard before this file loads; install is
  // idempotent, so this call is a no-op under `test:unit`. The rejection
  // assertions below are what prove the guard is active.
  installNoAmbientInferenceGuard();
  await assert.rejects(
    () => fetch('https://api.deepinfra.com/v1/openai/chat/completions'),
    /AMBIENT_INFERENCE_ATTEMPT_BLOCKED/,
  );
  await assert.rejects(
    () => fetch('https://opencode.ai/zen/go/v1/chat/completions'),
    /AMBIENT_INFERENCE_ATTEMPT_BLOCKED/,
  );
  await assert.rejects(
    () => fetch('https://api.deepinfra.com./v1/openai/chat/completions'),
    /AMBIENT_INFERENCE_ATTEMPT_BLOCKED/,
  );
});

test('guard passes loopback traffic through to the original fetch', async () => {
  installNoAmbientInferenceGuard();
  // The original fetch is untouched for non-provider hosts; a loopback request
  // must attempt a real connection (which fails with a network error, not the
  // guard error).
  await assert.rejects(
    () => fetch('http://127.0.0.1:9/nothing'),
    (error: Error) => !/AMBIENT_INFERENCE_ATTEMPT_BLOCKED/.test(error.message),
  );
});
