import assert from 'node:assert/strict';
import test from 'node:test';

import { buildChatCausalEvidence } from './chatCausalEvidence.js';
import type { SessionEvent } from './sessionEvents.js';

function base(kind: SessionEvent['kind'], seq: number): SessionEvent {
  return {
    schema_version: 1,
    event_id: `event-${seq}`,
    session_id: 'session-1',
    turn_id: 'turn-1',
    seq,
    ts: new Date(0).toISOString(),
    kind,
  } as SessionEvent;
}

test('causal evidence links exact model request, tool lifecycle, and verifier outcome', () => {
  const input = {
    ...base('model_input_receipt', 1),
    kind: 'model_input_receipt',
    inference_id: 'inference-1',
    provider: 'deepseek',
    requested_model_id: 'deepseek-chat',
    normalized_model_id: 'deepseek-chat',
    sent_model_id: 'deepseek-chat',
    input_digest: 'request-digest',
    input_ref: 'input.json',
  } as SessionEvent;
  const proposed = {
    ...base('tool_proposed', 2),
    kind: 'tool_proposed', tool_call_id: 'call-1', tool_name: 'test_run', idempotency_key: 'call-1',
  } as SessionEvent;
  const started = { ...proposed, ...base('tool_started', 3), kind: 'tool_started' } as SessionEvent;
  const completed = { ...proposed, ...base('tool_completed', 4), kind: 'tool_completed', exit_code: 0 } as SessionEvent;
  const verifier = { ...base('verifier_attempt', 5), kind: 'verifier_attempt', command_preview: 'npm test', authoritative: true, exit_code: 0, tool_call_id: 'call-1' } as SessionEvent;
  const result = { ...base('model_result_delivery', 6), kind: 'model_result_delivery', inference_id: 'inference-1', provider: 'deepseek', model: 'deepseek-chat', status: 'delivered' } as SessionEvent;
  const view = buildChatCausalEvidence([result, verifier, completed, started, proposed, input]);
  assert.equal(view.readiness, 'ready', JSON.stringify(view));
  assert.equal(view.nodes.find((node) => node.kind === 'model_input_receipt')?.request_digest, 'request-digest');
  assert.equal(view.contradictions.length, 0);
});

test('causal evidence preserves missing terminal evidence as incomplete', () => {
  const proposed = {
    ...base('tool_proposed', 1), kind: 'tool_proposed', tool_call_id: 'call-1', tool_name: 'file_write', idempotency_key: 'call-1',
  } as SessionEvent;
  const view = buildChatCausalEvidence([proposed]);
  assert.equal(view.readiness, 'incomplete');
  assert.match(view.unknowns.join('\n'), /terminal tool evidence missing/);
});

test('causal evidence treats empty event input as incomplete', () => {
  const view = buildChatCausalEvidence([]);
  assert.equal(view.readiness, 'incomplete');
  assert.deepEqual(view.nodes, []);
  assert.match(view.unknowns.join('\n'), /event evidence is empty/);
});

test('causal evidence rejects duplicate and conflicting model attempts', () => {
  const input = {
    ...base('model_input_receipt', 1),
    kind: 'model_input_receipt',
    inference_id: 'inference-1',
    provider: 'deepseek',
    requested_model_id: 'deepseek-chat',
    normalized_model_id: 'deepseek-chat',
    sent_model_id: 'deepseek-chat',
    input_digest: 'digest-a',
    input_ref: 'input-a.json',
  } as SessionEvent;
  const conflictingInput = {
    ...input,
    ...base('model_input_receipt', 2),
    input_digest: 'digest-b',
    input_ref: 'input-b.json',
  } as SessionEvent;
  const result = {
    ...base('model_result_delivery', 3),
    kind: 'model_result_delivery',
    inference_id: 'inference-1',
    provider: 'deepseek',
    model: 'deepseek-chat',
    status: 'delivered',
  } as SessionEvent;
  const duplicateResult = { ...result, ...base('model_result_delivery', 4) } as SessionEvent;
  const view = buildChatCausalEvidence([input, conflictingInput, result, duplicateResult]);
  assert.equal(view.readiness, 'contradictory');
  assert.match(view.contradictions.join('\n'), /conflicting model input digests/);
  assert.match(view.contradictions.join('\n'), /duplicate model result delivery/);
});

test('causal evidence rejects duplicate and conflicting tool terminals', () => {
  const proposed = {
    ...base('tool_proposed', 1),
    kind: 'tool_proposed',
    tool_call_id: 'call-1',
    tool_name: 'file_write',
    idempotency_key: 'attempt-1',
  } as SessionEvent;
  const started = { ...proposed, ...base('tool_started', 2), kind: 'tool_started' } as SessionEvent;
  const failed = { ...proposed, ...base('tool_failed', 3), kind: 'tool_failed', exit_code: 1 } as SessionEvent;
  const completed = { ...proposed, ...base('tool_completed', 4), kind: 'tool_completed', exit_code: 0 } as SessionEvent;
  const conflicting = {
    ...proposed,
    ...base('tool_completed', 5),
    kind: 'tool_completed',
    tool_call_id: 'call-2',
    exit_code: 0,
  } as SessionEvent;
  const view = buildChatCausalEvidence([proposed, started, failed, completed, conflicting]);
  assert.equal(view.readiness, 'contradictory');
  assert.match(view.contradictions.join('\n'), /duplicate tool terminal/);
  assert.match(view.contradictions.join('\n'), /conflicting lifecycle identity/);
});

test('causal evidence keeps distinct model retry attempts separate', () => {
  const input = (seq: number, inferenceId: string, digest: string): SessionEvent => ({
    ...base('model_input_receipt', seq),
    kind: 'model_input_receipt',
    inference_id: inferenceId,
    provider: 'deepseek',
    requested_model_id: 'deepseek-chat',
    normalized_model_id: 'deepseek-chat',
    sent_model_id: 'deepseek-chat',
    input_digest: digest,
    input_ref: `${inferenceId}.json`,
  } as SessionEvent);
  const result = (seq: number, inferenceId: string, status: 'delivered' | 'failed'): SessionEvent => ({
    ...base('model_result_delivery', seq),
    kind: 'model_result_delivery',
    inference_id: inferenceId,
    provider: 'deepseek',
    model: 'deepseek-chat',
    status,
  } as SessionEvent);
  const view = buildChatCausalEvidence([
    input(1, 'attempt-1', 'digest-a'),
    result(2, 'attempt-1', 'failed'),
    input(3, 'attempt-2', 'digest-b'),
    result(4, 'attempt-2', 'delivered'),
  ]);
  assert.equal(view.readiness, 'ready', JSON.stringify(view));
  assert.deepEqual(view.contradictions, []);
});

test('causal evidence rejects events mixed across session identities', () => {
  const input = {
    ...base('model_input_receipt', 0),
    session_id: 'session-a',
    kind: 'model_input_receipt',
    inference_id: 'inference-1',
    provider: 'deepseek',
    requested_model_id: 'deepseek-chat',
    normalized_model_id: 'deepseek-chat',
    sent_model_id: 'deepseek-chat',
    input_digest: 'digest-a',
    input_ref: 'input-a.json',
  } as SessionEvent;
  const result = {
    ...base('model_result_delivery', 1),
    session_id: 'session-b',
    kind: 'model_result_delivery',
    inference_id: 'inference-1',
    provider: 'deepseek',
    model: 'deepseek-chat',
    status: 'delivered',
  } as SessionEvent;
  const view = buildChatCausalEvidence([input, result]);
  assert.equal(view.readiness, 'contradictory');
  assert.match(view.contradictions.join('\n'), /mixes session identities/);
});

test('causal evidence requires outcome coverage for a completeness claim', () => {
  const turnStarted = {
    ...base('turn_ended', 1),
    kind: 'turn_started',
  } as unknown as SessionEvent;
  const view = buildChatCausalEvidence([turnStarted], {
    expectedEventKinds: ['turn_ended'],
  });
  assert.equal(view.readiness, 'incomplete');
  assert.equal(view.completeness, 'incomplete');
  assert.match(view.unknowns.join('\n'), /no terminal or outcome coverage/);
});

test('causal evidence reports an explicit verified durable prefix binding', () => {
  const input = {
    ...base('model_input_receipt', 0),
    kind: 'model_input_receipt',
    inference_id: 'inference-1',
    provider: 'deepseek',
    requested_model_id: 'deepseek-chat',
    normalized_model_id: 'deepseek-chat',
    sent_model_id: 'deepseek-chat',
    input_digest: 'digest-a',
    input_ref: 'input-a.json',
  } as SessionEvent;
  const result = {
    ...base('model_result_delivery', 1),
    kind: 'model_result_delivery',
    inference_id: 'inference-1',
    provider: 'deepseek',
    model: 'deepseek-chat',
    status: 'delivered',
  } as SessionEvent;
  const view = buildChatCausalEvidence([input, result], {
    durablePrefix: { sessionId: 'session-1', lastSeq: 1, lastEventId: 'event-1' },
  });
  assert.equal(view.readiness, 'ready');
  assert.equal(view.durability, 'verified');
});

test('causal evidence does not verify a durable prefix with a sequence gap', () => {
  const input = {
    ...base('model_input_receipt', 0),
    kind: 'model_input_receipt',
    inference_id: 'inference-gap',
    provider: 'deepseek',
    requested_model_id: 'deepseek-chat',
    normalized_model_id: 'deepseek-chat',
    sent_model_id: 'deepseek-chat',
    input_digest: 'digest-gap',
    input_ref: 'input-gap.json',
  } as SessionEvent;
  const result = {
    ...base('model_result_delivery', 2),
    kind: 'model_result_delivery',
    inference_id: 'inference-gap',
    provider: 'deepseek',
    model: 'deepseek-chat',
    status: 'delivered',
  } as SessionEvent;
  const view = buildChatCausalEvidence([input, result], {
    durablePrefix: { sessionId: 'session-1', lastSeq: 2, lastEventId: 'event-2' },
  });
  assert.equal(view.readiness, 'incomplete');
  assert.equal(view.durability, 'unverified');
  assert.match(view.unknowns.join('\n'), /does not match the supplied durable prefix/);
});
