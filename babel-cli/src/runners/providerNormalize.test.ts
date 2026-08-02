import test from 'node:test';
import assert from 'node:assert';
import {
  normalizeFinishReason,
  classifyProviderError,
  parseRetryAfterHeader,
  isRetryableStatus,
} from './providerNormalize.js';

test('normalizeFinishReason', () => {
  assert.strictEqual(normalizeFinishReason('stop'), 'stop');
  assert.strictEqual(normalizeFinishReason('tool_calls'), 'tool_calls');
  assert.strictEqual(normalizeFinishReason('length'), 'length');
  assert.strictEqual(normalizeFinishReason('content_filter'), 'content_filter');
  assert.strictEqual(normalizeFinishReason('recitation'), 'recitation');

  // Aliases
  assert.strictEqual(normalizeFinishReason('end_turn'), 'stop');
  assert.strictEqual(normalizeFinishReason('max_tokens'), 'length');

  // Fallback
  assert.strictEqual(normalizeFinishReason('random_thing'), 'unknown');
  assert.strictEqual(normalizeFinishReason(null), 'unknown');
  assert.strictEqual(normalizeFinishReason(undefined), 'unknown');
});

test('classifyProviderError', () => {
  assert.strictEqual(classifyProviderError(new Error('Rate limit exceeded')), 'rate_limit');
  assert.strictEqual(classifyProviderError(new Error('429 Too Many Requests')), 'rate_limit');
  assert.strictEqual(classifyProviderError(new Error('Context overflow')), 'context_overflow');
  assert.strictEqual(classifyProviderError(new Error('Invalid authentication')), 'auth_fatal');
  assert.strictEqual(classifyProviderError(new Error('Quota exceeded')), 'quota_fatal');
  assert.strictEqual(classifyProviderError(new Error('Bad request')), 'invalid_request');
  assert.strictEqual(classifyProviderError(new Error('Server overloaded')), 'transient');
  assert.strictEqual(classifyProviderError(new Error('Timeout')), 'transient');

  // Testing status codes
  assert.strictEqual(classifyProviderError(new Error('Fetch error'), 429), 'rate_limit');
  assert.strictEqual(classifyProviderError(new Error('Fetch error'), 401), 'auth_fatal');
  assert.strictEqual(classifyProviderError(new Error('Fetch error'), 403), 'auth_fatal'); // assuming 403 could be auth
  assert.strictEqual(classifyProviderError(new Error('Fetch error'), 400), 'invalid_request');
  assert.strictEqual(classifyProviderError(new Error('Fetch error'), 503), 'transient');
});

test('parseRetryAfterHeader', () => {
  assert.strictEqual(parseRetryAfterHeader('120'), 120);
  assert.strictEqual(parseRetryAfterHeader('0'), 0);

  // Date parsing relative to now
  const futureDate = new Date(Date.now() + 60000).toUTCString();
  const parsed = parseRetryAfterHeader(futureDate);
  assert.ok(parsed !== null && parsed >= 59 && parsed <= 60);

  // Invalid
  assert.strictEqual(parseRetryAfterHeader(null), null);
  assert.strictEqual(parseRetryAfterHeader(undefined), null);
  assert.strictEqual(parseRetryAfterHeader('invalid'), null);
});

test('isRetryableStatus', () => {
  assert.strictEqual(isRetryableStatus(408), true);
  assert.strictEqual(isRetryableStatus(429), true);
  assert.strictEqual(isRetryableStatus(500), true);
  assert.strictEqual(isRetryableStatus(502), true);
  assert.strictEqual(isRetryableStatus(503), true);
  assert.strictEqual(isRetryableStatus(504), true);

  assert.strictEqual(isRetryableStatus(200), false);
  assert.strictEqual(isRetryableStatus(400), false);
  assert.strictEqual(isRetryableStatus(401), false);
  assert.strictEqual(isRetryableStatus(404), false);
});
