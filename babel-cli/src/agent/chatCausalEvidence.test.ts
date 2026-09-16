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
