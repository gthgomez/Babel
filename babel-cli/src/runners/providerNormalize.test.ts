import test from 'node:test';
import assert from 'node:assert';
import {
  normalizeFinishReason,
  classifyStreamFinish,
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

test('classifyStreamFinish accepts normal text and explicit tool-call terminals', () => {
  assert.deepEqual(
    classifyStreamFinish({ reported: 'stop', sawDone: true, hasToolCalls: false }),
    { status: 'complete', finishReason: 'stop', executeTools: false },
  );
  assert.deepEqual(
    classifyStreamFinish({ reported: 'tool_calls', sawDone: true, hasToolCalls: true }),
    { status: 'complete', finishReason: 'tool_calls', executeTools: true },
  );
  assert.deepEqual(
    classifyStreamFinish({ reported: 'stop', sawDone: true, hasToolCalls: true }),
    { status: 'complete', finishReason: 'tool_calls', executeTools: true },
  );
});

test('classifyStreamFinish never infers stop from missing or unknown data', () => {
  for (const reported of [null, undefined, '', '   ']) {
    const missing = classifyStreamFinish({ reported, sawDone: true, hasToolCalls: true });
    assert.equal(missing.status, 'failed');
    assert.equal(missing.status === 'failed' ? missing.finishReason : null, 'missing');
  }
  const unknown = classifyStreamFinish({ reported: 'gateway_magic', sawDone: true, hasToolCalls: false });
  assert.equal(unknown.status, 'failed');
  assert.match(unknown.status === 'failed' ? unknown.message : '', /unrecognized/i);
});

test('classifyStreamFinish fails filtered, truncated, error and tool-less tool_calls terminals', () => {
  for (const [reported, expected] of [
    ['content_filter', 'content_filter'],
    ['recitation', 'recitation'],
    ['length', 'length'],
    ['error', 'error'],
  ] as const) {
    const disposition = classifyStreamFinish({ reported, sawDone: true, hasToolCalls: true });
    assert.equal(disposition.status, 'failed');
    assert.equal(disposition.status === 'failed' ? disposition.finishReason : null, expected);
  }
  const toolLess = classifyStreamFinish({ reported: 'tool_calls', sawDone: true, hasToolCalls: false });
  assert.equal(toolLess.status, 'failed');
  assert.match(toolLess.status === 'failed' ? toolLess.message : '', /without an accumulated tool call/i);
});

test('classifyStreamFinish requires the transport end marker', () => {
  const disposition = classifyStreamFinish({ reported: 'stop', sawDone: false, hasToolCalls: false });
  assert.equal(disposition.status, 'failed');
  assert.match(disposition.status === 'failed' ? disposition.message : '', /terminal marker/i);
});
