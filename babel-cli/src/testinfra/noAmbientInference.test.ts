/**
 * Test-safety guard contract: ordinary verification must FAIL if it attempts
 * an unauthorized external model request. This suite pins the guard itself.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  installNoAmbientInferenceGuard,
  isBlockedInferenceHost,
  ALLOW_ENV,
} from './no-ambient-inference.mjs';

test('guard blocks known inference provider hosts and subdomains', async () => {
  assert.ok(isBlockedInferenceHost('api.deepinfra.com'));
  assert.ok(isBlockedInferenceHost('opencode.ai'));
  assert.ok(isBlockedInferenceHost('sub.api.openai.com'));
  assert.ok(!isBlockedInferenceHost('example-deepinfra.com.evil.test'));
  assert.ok(!isBlockedInferenceHost('localhost'));
  assert.ok(!isBlockedInferenceHost('127.0.0.1'));
});

test('installed guard turns a provider request into a loud test failure', async () => {
  const installed = installNoAmbientInferenceGuard();
  assert.ok(installed, 'first install in this process must succeed');
  await assert.rejects(
    () => fetch('https://api.deepinfra.com/v1/openai/chat/completions'),
    /AMBIENT_INFERENCE_ATTEMPT_BLOCKED/,
  );
  await assert.rejects(
    () => fetch('https://opencode.ai/zen/go/v1/chat/completions'),
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
