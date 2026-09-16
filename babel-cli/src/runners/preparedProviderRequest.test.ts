import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { prepareProviderRequest } from './preparedProviderRequest.js';

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
  assert.equal(prepared.context_limit_tokens, null);
  assert.equal(prepared.context_limit_source, 'unknown');
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
  assert.equal(prepared.body.includes('credential'), false);
  assert.throws(() => {
    (prepared as { body: string }).body = 'mutated';
  }, TypeError);
});
