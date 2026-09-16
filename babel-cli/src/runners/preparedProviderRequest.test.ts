import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  assertPreparedProviderRequestAdmissible,
  prepareProviderRequest,
} from './preparedProviderRequest.js';

test('prepared request derives digest and bytes from the exact serialized body', () => {
  const body = JSON.stringify({ messages: [{ role: 'user', content: '😀' }], tools: [] });
  const prepared = prepareProviderRequest({
    body,
    mode: 'native',
    provider: 'deepseek',
    requestedModelId: 'deepseek-v4-flash',
    requestId: 'request-1',
    attemptId: 'attempt-1',
    reservedCompletionTokens: 512,
  });

  assert.equal(prepared.body, body);
  assert.equal(prepared.body_bytes, Buffer.byteLength(body, 'utf8'));
  assert.equal(prepared.body_digest, createHash('sha256').update(body, 'utf8').digest('hex'));
  assert.equal(prepared.accounting.request_digest, prepared.body_digest);
  assert.equal(prepared.accounting.request_bytes, prepared.body_bytes);
  assert.equal(prepared.accounting.input_message_count, 1);
  assert.equal(prepared.accounting.reserved_completion_tokens, 512);
  assert.equal(prepared.accounting_kind, 'exact_serialized_body');
  assert.equal(prepared.context_limit_tokens, 1_000_000);
  assert.equal(prepared.context_limit_source, 'policy');
  assert.equal(prepared.admission, 'qualified');
});

test('prepared request keeps explicit identity and mode without serializing credentials', () => {
  const prepared = prepareProviderRequest({
    body: JSON.stringify({ messages: [{ role: 'user', content: 'task' }] }),
    mode: 'legacy',
    provider: 'deepinfra',
    requestedModelId: 'model-a',
    normalizedModelId: 'model-b',
    sentModelId: 'model-c',
    requestId: 'request-2',
    attemptId: 'attempt-2',
    parentRequestId: 'parent-1',
  });

  assert.equal(prepared.mode, 'legacy');
  assert.equal(prepared.request_id, 'request-2');
  assert.equal(prepared.attempt_id, 'attempt-2');
  assert.equal(prepared.parent_request_id, 'parent-1');
  assert.equal(prepared.normalized_model_id, 'model-b');
  assert.equal(prepared.sent_model_id, 'model-c');
  assert.notEqual(prepared.request_id, prepared.attempt_id);
  assert.equal(prepared.context_limit_tokens, null);
  assert.equal(prepared.context_limit_source, 'unknown');
  assert.equal(prepared.admission, 'unknown');
  assert.equal(prepared.body.includes('credential'), false);
  assert.throws(() => {
    (prepared as { body: string }).body = 'mutated';
  }, TypeError);
});

test('prepared request preserves explicit parent identity and fails closed on an over-limit final body', () => {
  const prepared = prepareProviderRequest({
    body: JSON.stringify({ messages: [{ role: 'user', content: 'a long enough task' }] }),
    mode: 'native',
    provider: 'deepinfra',
    requestedModelId: 'unknown-model',
    requestId: 'request-rebuilt',
    parentRequestId: 'request-before-compaction',
    contextLimitTokens: 1,
    reservedCompletionTokens: 1,
  });

  assert.equal(prepared.request_id, 'request-rebuilt');
  assert.equal(prepared.parent_request_id, 'request-before-compaction');
  assert.equal(prepared.context_limit_tokens, 1);
  assert.equal(prepared.context_limit_source, 'explicit');
  assert.equal(prepared.admission, 'over_limit');
  assert.throws(() => assertPreparedProviderRequestAdmissible(prepared), /exceeds 1 token context limit/);
});

test('explicitly unknown context limits do not become an implicit admission pass', () => {
  const prepared = prepareProviderRequest({
    body: JSON.stringify({ messages: [{ role: 'user', content: 'task' }] }),
    mode: 'text',
    provider: 'opencode',
    requestedModelId: 'x-preview-f-free',
    contextLimitTokens: null,
    reservedCompletionTokens: 512,
  });

  assert.equal(prepared.context_limit_tokens, null);
  assert.equal(prepared.context_limit_source, 'unknown');
  assert.equal(prepared.admission, 'unknown');
  assert.doesNotThrow(() => assertPreparedProviderRequestAdmissible(prepared));
});

test('ordinary retries keep logical request identity but allocate a new attempt identity', () => {
  const body = JSON.stringify({ messages: [{ role: 'user', content: 'retry safely' }] });
  const first = prepareProviderRequest({
    body,
    mode: 'native',
    provider: 'deepseek',
    requestedModelId: 'deepseek-v4-flash',
    requestId: 'logical-request',
    attemptId: 'transport-attempt-1',
    reservedCompletionTokens: 512,
  });
  const retry = prepareProviderRequest({
    body,
    mode: 'native',
    provider: 'deepseek',
    requestedModelId: 'deepseek-v4-flash',
    requestId: first.request_id,
    attemptId: 'transport-attempt-2',
    reservedCompletionTokens: 512,
  });

  assert.equal(retry.request_id, first.request_id);
  assert.notEqual(retry.attempt_id, first.attempt_id);
  assert.equal(retry.body_digest, first.body_digest);
  assert.equal(retry.body_bytes, first.body_bytes);
  assert.equal(retry.parent_request_id, null);
});
