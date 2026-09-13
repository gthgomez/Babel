import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import type { ToolStreamEvent } from '../runners/base.js';
import { OpenCodeGoApiRunner } from '../runners/openCodeGoApi.js';
import { ObservedBabelReviewRunner, parseObservedBabelReviewAnswer, validateBabelReviewCalls, REVIEW_OUTPUT_TOKEN_BUDGET, REVIEW_NATIVE_BUFFER_MAX_BYTES, type BabelReviewCall } from './babelReviewObserver.js';
import { babelReviewModelPolicy } from './babelChatReview.js';

test('review telemetry covers all inference paths and records provider failures', async () => {
  const original = globalThis.fetch; const calls: BabelReviewCall[] = [];
  const runner = new ObservedBabelReviewRunner('mimo-v2.5', call => calls.push(call), { credentialSource: 'explicit-test', explicitCredential: 'fixture-only' });
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    const usage = { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 };
    if (body.stream) return new Response(`data: ${JSON.stringify({ model: 'mimo-v2.5', choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }], usage })}\n\ndata: [DONE]\n\n`);
    return new Response(JSON.stringify({ model: 'mimo-v2.5', choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }], usage }));
  };
  try {
    await runner.execute('test', z.object({ ok: z.boolean() }));
    await runner.executeRaw('test');
    for await (const _chunk of runner.executeRawStream('test')) { /* consume */ }
    for await (const _chunk of runner.executeWithToolsStream([{ role: 'user', content: 'test' }], [])) { /* consume */ }
    assert.deepEqual(calls.map(c => c.path), ['structured', 'raw', 'raw_stream', 'native_tools']);
    assert.ok(calls.every(c => c.status === 'completed' && c.metadata?.observed_model_id === 'mimo-v2.5' && c.metadata.prompt_tokens === 20));
    globalThis.fetch = async () => new Response('Unavailable', { status: 503 });
    await assert.rejects(runner.executeRaw('test'));
    assert.equal(calls.at(-1)?.status, 'failed');
  } finally { globalThis.fetch = original; }
});

test('tool-call finish without actual tool calls cannot become a JSON approval', async () => {
  const original = globalThis.fetch; const calls: BabelReviewCall[] = []; let parsed = false;
  const runner = new ObservedBabelReviewRunner('longcat-2.0', call => calls.push(call), { credentialSource: 'explicit-test', explicitCredential: 'fixture-only' });
  globalThis.fetch = async () => new Response(`data: ${JSON.stringify({ model: 'longcat-2.0', choices: [{ delta: { content: '{"verdict":"APPROVE","uncertain":false,"reviewed_files":["a.ts"],"findings":[],"blocking_findings":[]}' }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`);
  try {
    const events: ToolStreamEvent[] = [];
    for await (const event of runner.executeWithToolsStream([{ role: 'user', content: 'review' }], [])) events.push(event);
    assert.deepEqual(events, [{ type: 'error', message: 'CHAT_REVIEW_NATIVE_TERMINATION_INVALID' }]);
    assert.equal(calls.length, 1); assert.equal(calls[0]?.status, 'failed');
    assert.equal(calls[0]?.metadata?.normalized_finish_reason, 'TOOL_CALL');
    assert.throws(() => parseObservedBabelReviewAnswer(calls, 'longcat-2.0', () => { parsed = true; return 'APPROVE'; }));
    assert.equal(parsed, false);
  } finally { globalThis.fetch = original; }
});

test('one transient pre-output retry preserves failed usage and exact model attribution', async () => {
  const original = globalThis.fetch; const calls: BabelReviewCall[] = []; let requests = 0;
  const runner = new ObservedBabelReviewRunner('mimo-v2.5', call => calls.push(call), { credentialSource: 'explicit-test', explicitCredential: 'fixture-only' });
  globalThis.fetch = async () => {
    if (++requests === 1) throw new TypeError('fetch failed');
    return new Response(`data: ${JSON.stringify({ model: 'mimo-v2.5', choices: [{ delta: { content: 'review answer' }, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 } })}\n\ndata: [DONE]\n\n`);
  };
  try {
    const events = [];
    for await (const event of runner.executeWithToolsStream([{ role: 'user', content: 'test' }], [])) events.push(event);
    assert.equal(requests, 2); assert.equal(events.some(e => e.type === 'error'), false);
    assert.deepEqual(calls.map(c => c.status), ['failed', 'completed']);
    assert.equal(calls[0]?.metadata?.prompt_tokens, null);
    validateBabelReviewCalls(calls, 'mimo-v2.5');
    assert.throws(() => validateBabelReviewCalls(calls.slice(0, 1), 'mimo-v2.5'));
    assert.throws(() => validateBabelReviewCalls(calls, 'longcat-2.0'));
    const forged = structuredClone(calls); forged[1]!.request_id = 'different';
    assert.throws(() => validateBabelReviewCalls(forged, 'mimo-v2.5'));
    const wrongPath = structuredClone(calls); wrongPath[1]!.path = 'structured';
    assert.throws(() => validateBabelReviewCalls(wrongPath, 'mimo-v2.5'));
  } finally { globalThis.fetch = original; }
});

test('transient retry ceiling and authentication errors remain failed evidence', async () => {
  const original = globalThis.fetch; let requests = 0; const calls: BabelReviewCall[] = [];
  const runner = new ObservedBabelReviewRunner('mimo-v2.5', call => calls.push(call), { credentialSource: 'explicit-test', explicitCredential: 'fixture-only' });
  try {
    globalThis.fetch = async () => { requests++; throw new TypeError('fetch failed'); };
    for await (const _event of runner.executeWithToolsStream([{ role: 'user', content: 'test' }], [])) { /* consume */ }
    assert.equal(requests, 2); assert.throws(() => validateBabelReviewCalls(calls, 'mimo-v2.5'));
    requests = 0; calls.length = 0;
    globalThis.fetch = async () => { requests++; return new Response('Unauthorized; Network error in provider text', { status: 401 }); };
    for await (const _event of runner.executeWithToolsStream([{ role: 'user', content: 'test' }], [])) { /* consume */ }
    assert.equal(requests, 1); assert.throws(() => validateBabelReviewCalls(calls, 'mimo-v2.5'));
  } finally { globalThis.fetch = original; }
});

test('unrecognized interrupted stream errors stay failed and never deliver partial output', async () => {
  const original = globalThis.fetch; let requests = 0; const calls: BabelReviewCall[] = [];
  const runner = new ObservedBabelReviewRunner('mimo-v2.5', call => calls.push(call), { credentialSource: 'explicit-test', explicitCredential: 'fixture-only' });
  try {
    globalThis.fetch = async () => {
      requests++;
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ model: 'mimo-v2.5', choices: [{ delta: { content: 'partial answer' } }] })}\n\n`));
        setTimeout(() => controller.error(new Error('Network error')), 20);
      } }));
    };
    const events = [];
    for await (const event of runner.executeWithToolsStream([{ role: 'user', content: 'test' }], [])) events.push(event);
    assert.ok(events.every(event => event.type === 'error'));
    assert.equal(requests, 1); assert.throws(() => validateBabelReviewCalls(calls, 'mimo-v2.5'));
  } finally { globalThis.fetch = original; }
});

function nativeResponse(text: string, done: boolean, model = 'mimo-v2.5', usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }) {
  return new Response(`data: ${JSON.stringify({ model, choices: [{ delta: { reasoning_content: `${text}-thought`, content: text, tool_calls: [{ index: 0, id: `${text}-tool`, type: 'function', function: { name: 'read_file', arguments: '{"path":"fixture.ts"}' } }] }, finish_reason: 'tool_calls' }], ...(usage ? { usage } : {}) })}\n\n${done ? 'data: [DONE]\n\n' : ''}`);
}

test('premature EOF retries only the identical current request and releases no failed buffered events', async () => {
  const original = globalThis.fetch; const calls: BabelReviewCall[] = []; const bodies: unknown[] = [];
  const runner = new ObservedBabelReviewRunner('mimo-v2.5', call => calls.push(call), { credentialSource: 'explicit-test', explicitCredential: 'fixture-only' });
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return bodies.length === 1
      ? nativeResponse('discarded-partial', false, 'mimo-v2.5', { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 })
      : nativeResponse('accepted', true, 'mimo-v2.5', { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 });
  };
  try {
    const events = [];
    for await (const event of runner.executeWithToolsStream([{ role: 'user', content: 'same review task' }], [], 'same system', undefined, 'auto')) events.push(event);
    assert.equal(bodies.length, 2); assert.deepEqual(bodies[0], bodies[1]);
    assert.ok(!JSON.stringify(events).includes('discarded-partial'));
    assert.deepEqual(events.map(event => event.type), ['thought_delta', 'text_delta', 'tool_use', 'done']);
    assert.ok(events.some(event => event.type === 'tool_use' && event.id === 'accepted-tool'));
    assert.deepEqual(calls.map(call => call.status), ['failed', 'completed']);
    assert.equal(calls[0]?.metadata?.observed_model_id, 'mimo-v2.5');
    assert.equal(calls[0]?.metadata?.prompt_tokens, 7);
    assert.equal(calls[0]?.metadata?.completion_tokens, 2);
    assert.equal(calls[0]?.request_id, calls[1]?.request_id);
    assert.deepEqual(calls.map(call => call.attempt), [1, 2]);
    validateBabelReviewCalls(calls, 'mimo-v2.5');
    const forged = structuredClone(calls); forged[0]!.metadata!.observed_model_id = 'longcat-2.0';
    assert.throws(() => validateBabelReviewCalls(forged, 'mimo-v2.5'));
  } finally { globalThis.fetch = original; }
});

test('failed current stream usage stays unknown rather than inheriting a prior invocation', async () => {
  const original = globalThis.fetch; const calls: BabelReviewCall[] = []; let requests = 0;
  const runner = new ObservedBabelReviewRunner('mimo-v2.5', call => calls.push(call), { credentialSource: 'explicit-test', explicitCredential: 'fixture-only' });
  globalThis.fetch = async () => ++requests === 2 ? nativeResponse('partial', false) : nativeResponse('complete', true, 'mimo-v2.5', { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 });
  try {
    for (let invocation = 0; invocation < 2; invocation++) for await (const _event of runner.executeWithToolsStream([{ role: 'user', content: 'test' }], [])) { /* consume */ }
    assert.equal(requests, 3); assert.deepEqual(calls.map(call => call.status), ['completed', 'failed', 'completed']);
    assert.equal(calls[0]?.metadata?.prompt_tokens, 100);
    assert.equal(calls[1]?.metadata?.prompt_tokens, null); assert.equal(calls[1]?.metadata?.completion_tokens, null);
    assert.equal(calls[1]?.metadata?.observed_model_id, 'mimo-v2.5');
    validateBabelReviewCalls(calls, 'mimo-v2.5');
  } finally { globalThis.fetch = original; }
});

test('two premature stream endings remain failed evidence with no partial deliveries', async () => {
  const original = globalThis.fetch; const calls: BabelReviewCall[] = []; let requests = 0;
  const runner = new ObservedBabelReviewRunner('mimo-v2.5', call => calls.push(call), { credentialSource: 'explicit-test', explicitCredential: 'fixture-only' });
  globalThis.fetch = async () => { requests++; return nativeResponse('never-deliver', false); };
  try {
    const events = [];
    for await (const event of runner.executeWithToolsStream([{ role: 'user', content: 'test' }], [])) events.push(event);
    assert.equal(requests, 2); assert.deepEqual(calls.map(call => call.status), ['failed', 'failed']);
    assert.equal(events.length, 1); assert.equal(events[0]?.type, 'error');
    assert.ok(!JSON.stringify(events).includes('never-deliver'));
    assert.throws(() => validateBabelReviewCalls(calls, 'mimo-v2.5'));
  } finally { globalThis.fetch = original; }
});

test('model identity failures after buffered output never release it or retry', async () => {
  const original = globalThis.fetch;
  try {
    for (const done of [false, true]) {
      const calls: BabelReviewCall[] = []; let requests = 0; const events: ToolStreamEvent[] = [];
      const runner = new ObservedBabelReviewRunner('mimo-v2.5', call => calls.push(call), { credentialSource: 'explicit-test', explicitCredential: 'fixture-only' });
      globalThis.fetch = async () => { requests++; return nativeResponse('wrong-model', done, 'longcat-2.0'); };
      await assert.rejects(async () => { for await (const event of runner.executeWithToolsStream([{ role: 'user', content: 'test' }], [])) events.push(event); }, (error: unknown) => (error as { code?: string }).code === 'MODEL_ATTRIBUTION_FAILURE');
      assert.equal(requests, 1); assert.deepEqual(events, []); assert.equal(calls[0]?.status, 'failed');
      assert.equal(calls[0]?.metadata?.observed_model_id, 'longcat-2.0');
      assert.throws(() => validateBabelReviewCalls(calls, 'mimo-v2.5'));
    }
  } finally { globalThis.fetch = original; }
});

test('already aborted and mid-stream aborted reviews never retry or release buffered output', async () => {
  const original = globalThis.fetch;
  try {
    for (const preAborted of [true, false]) {
      const controller = new AbortController(); if (preAborted) controller.abort();
      const calls: BabelReviewCall[] = []; let requests = 0; const events: ToolStreamEvent[] = [];
      const runner = new ObservedBabelReviewRunner('mimo-v2.5', call => calls.push(call), { credentialSource: 'explicit-test', explicitCredential: 'fixture-only' });
      globalThis.fetch = async () => { requests++; controller.abort(); return nativeResponse('cancelled-content', false); };
      await assert.rejects(async () => { for await (const event of runner.executeWithToolsStream([{ role: 'user', content: 'test' }], [], undefined, controller.signal)) events.push(event); });
      assert.equal(requests, preAborted ? 0 : 1); assert.deepEqual(events, []);
      assert.ok(calls.every(call => call.status === 'failed' && !call.retry_reason));
    }
  } finally { globalThis.fetch = original; }
});

test('abort or consumer return during validated replay retains usage but never certifies or retries delivery', async () => {
  const original = globalThis.fetch;
  try {
    for (const action of ['abort', 'return'] as const) {
      const controller = new AbortController(); const calls: BabelReviewCall[] = []; let requests = 0;
      const runner = new ObservedBabelReviewRunner('mimo-v2.5', call => calls.push(call), { credentialSource: 'explicit-test', explicitCredential: 'fixture-only' });
      globalThis.fetch = async () => { requests++; return nativeResponse('validated', true, 'mimo-v2.5', { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 }); };
      const consume = async () => {
        for await (const _event of runner.executeWithToolsStream([{ role: 'user', content: 'test' }], [], undefined, controller.signal)) {
          if (action === 'return') break;
          controller.abort();
        }
      };
      if (action === 'abort') await assert.rejects(consume);
      else await consume();
      assert.equal(requests, 1); assert.equal(calls.length, 1); assert.equal(calls[0]?.status, 'failed');
      assert.equal(calls[0]?.metadata?.prompt_tokens, 10); assert.equal(calls[0]?.retry_reason, undefined);
      assert.throws(() => validateBabelReviewCalls(calls, 'mimo-v2.5'));
    }
  } finally { globalThis.fetch = original; }
});

test('oversized native buffers fail closed without delivering content or retrying', async () => {
  const original = globalThis.fetch; const calls: BabelReviewCall[] = []; const events: ToolStreamEvent[] = []; let requests = 0;
  const runner = new ObservedBabelReviewRunner('mimo-v2.5', call => calls.push(call), { credentialSource: 'explicit-test', explicitCredential: 'fixture-only' });
  globalThis.fetch = async () => { requests++; return nativeResponse('x'.repeat(REVIEW_NATIVE_BUFFER_MAX_BYTES), true); };
  try {
    await assert.rejects(async () => { for await (const event of runner.executeWithToolsStream([{ role: 'user', content: 'test' }], [])) events.push(event); }, /CHAT_REVIEW_NATIVE_BUFFER_LIMIT/);
    assert.equal(requests, 1); assert.deepEqual(events, []); assert.equal(calls[0]?.status, 'failed');
    assert.equal(calls[0]?.retry_reason, undefined);
  } finally { globalThis.fetch = original; }
});

test('a full-length streamed answer is not rejected by the buffer event guard', async () => {
  const original = globalThis.fetch; const calls: BabelReviewCall[] = []; let requests = 0;
  const runner = new ObservedBabelReviewRunner('mimo-v2.5', call => calls.push(call), { credentialSource: 'explicit-test', explicitCredential: 'fixture-only' });
  // The pre-fix event guard capped buffered events at 32768, a value that
  // collided with the raised token budget, so a long but legitimate answer
  // could fail as an oversized buffer. Deliver more events than that old cap
  // but far fewer bytes than the byte bound.
  const chunks = 40000;
  globalThis.fetch = async () => {
    requests++;
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (let i = 0; i < chunks; i++) controller.enqueue(encoder.encode(`data: ${JSON.stringify({ model: 'mimo-v2.5', choices: [{ delta: { content: 'x' } }] })}\n\n`));
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ model: 'mimo-v2.5', choices: [{ delta: { content: 'y' }, finish_reason: 'stop' }] })}\n\n`));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    }));
  };
  try {
    const events: ToolStreamEvent[] = [];
    for await (const event of runner.executeWithToolsStream([{ role: 'user', content: 'review' }], [])) events.push(event);
    assert.equal(requests, 1);
    assert.ok(events.filter(event => event.type === 'text_delta').length >= chunks);
    assert.equal(events.some(event => event.type === 'error'), false);
    assert.equal(calls[0]?.status, 'completed');
  } finally { globalThis.fetch = original; }
});

test('reviewer requests the explicit non-thinking profile for every canonical model and inference path', async () => {
  const original = globalThis.fetch;
  try {
    for (const model of ['mimo-v2.5', 'longcat-2.0', 'deepseek-v4-flash'] as const) {
      const bodies: Record<string, unknown>[] = []; const calls: BabelReviewCall[] = [];
      globalThis.fetch = async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>; bodies.push(body);
        const usage = { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 };
        if (body.stream) return new Response(`data: ${JSON.stringify({ model, choices: [{ delta: { content: '{"ok":true}' }, finish_reason: 'stop' }], usage })}\n\ndata: [DONE]\n\n`);
        return new Response(JSON.stringify({ model, choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }], usage }));
      };
      const runner = new ObservedBabelReviewRunner(model, call => calls.push(call), { credentialSource: 'explicit-test', explicitCredential: 'fixture-only' });
      await runner.execute('test', z.object({ ok: z.boolean() }));
      await runner.executeRaw('test');
      for await (const _event of runner.executeRawStream('test')) { /* consume */ }
      for await (const _event of runner.executeWithToolsStream([{ role: 'user', content: 'test' }], [])) { /* consume */ }
      assert.deepEqual(calls.map(call => call.path), ['structured', 'raw', 'raw_stream', 'native_tools']);
      assert.equal(bodies.length, 4);
      for (const body of bodies) {
        assert.equal(body.model, model); assert.equal(body.max_tokens, REVIEW_OUTPUT_TOKEN_BUDGET); assert.equal(body.temperature, 0);
        assert.deepEqual(body.thinking, { type: 'disabled' });
      }
      // The advertised model policy must not drift from the requested budget.
      assert.equal(babelReviewModelPolicy(model, 'trusted-installation').maxOutputTokens, REVIEW_OUTPUT_TOKEN_BUDGET);
      for (const call of calls) {
        assert.equal(call.metadata?.provider, 'opencode-go'); assert.equal(call.metadata?.observed_model_id, model);
        assert.deepEqual(call.metadata?.requested_thinking, { type: 'disabled' });
        assert.equal(call.metadata?.thinking_disabled_reason, model === 'longcat-2.0' ? 'reviewer_observed_reasoning_only_output_exhaustion' : 'reviewer_missing_reasoning_content_replay');
        assert.equal(call.metadata?.thinking_mode_evidence, 'request_only_not_upstream_confirmed');
      }
      const transport = new OpenCodeGoApiRunner(model, { maxTokens: REVIEW_OUTPUT_TOKEN_BUDGET, temperature: 0 }, { credentialSource: 'explicit-test', explicitCredential: 'fixture-only' });
      await transport.executeRaw('test');
      assert.equal(Object.hasOwn(bodies[4]!, 'thinking'), false, 'ordinary transport defaults must remain unchanged');
    }
  } finally { globalThis.fetch = original; }
});

test('invalid native finishes and empty finals withhold all content and cannot request format repair', async () => {
  const original = globalThis.fetch;
  const validLookingVerdict = '{"verdict":"APPROVE","uncertain":false,"reviewed_files":["fixture.ts"],"findings":[],"blocking_findings":[]}';
  try {
    for (const model of ['mimo-v2.5', 'longcat-2.0', 'deepseek-v4-flash'] as const) {
      for (const [finish, content] of [['length', validLookingVerdict], ['length', ''], ['content_filter', validLookingVerdict], ['interrupted', validLookingVerdict], ['unexpected', validLookingVerdict], ['stop', ''], ['stop', ' \n '], ['tool_calls', '']] as const) {
        const calls: BabelReviewCall[] = []; let requests = 0;
        const runner = new ObservedBabelReviewRunner(model, call => calls.push(call), { credentialSource: 'explicit-test', explicitCredential: 'fixture-only' });
        globalThis.fetch = async () => {
          requests++;
          return new Response(`data: ${JSON.stringify({ model, choices: [{ delta: { reasoning_content: 'fixture thought', content }, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`);
        };
        const events: ToolStreamEvent[] = [];
        for await (const event of runner.executeWithToolsStream([{ role: 'user', content: 'test' }], [])) events.push(event);
        assert.equal(requests, 1, `${model}/${finish}: no transport retry`);
        assert.equal(events.length, 1); assert.equal(events[0]?.type, 'error');
        assert.equal(calls[0]?.status, 'failed'); assert.equal(calls[0]?.retry_reason, undefined);
        assert.equal(calls[0]?.metadata?.observed_model_id, model);
        assert.equal(calls[0]?.metadata?.completion_tokens, null);
        if (finish === 'length') assert.equal(calls[0]?.metadata?.normalized_finish_reason, 'OUTPUT_BUDGET_EXHAUSTED');
        let parses = 0; let formatRepairs = 0;
        try { parseObservedBabelReviewAnswer(calls, model, () => { parses++; return JSON.parse('OK'); }); }
        catch (error) { if (error instanceof SyntaxError) formatRepairs++; }
        assert.equal(parses, 0); assert.equal(formatRepairs, 0);
        assert.throws(() => parseObservedBabelReviewAnswer(calls, model, () => JSON.parse(validLookingVerdict)), { message: /^CHAT_REVIEW_ATTRIBUTION_INCOMPLETE(_INVALID_CALL_[A-Z_]+)?$/ });
        if (finish === 'length') assert.throws(() => parseObservedBabelReviewAnswer(calls, model, () => JSON.parse(validLookingVerdict)), { message: /^CHAT_REVIEW_ATTRIBUTION_INCOMPLETE_INVALID_CALL_OUTPUT_BUDGET_EXHAUSTED$/ });
      }
    }
  } finally { globalThis.fetch = original; }
});

test('length-truncated tool requests are withheld while complete tools and natural answers remain usable', async () => {
  const original = globalThis.fetch;
  try {
    for (const finish of ['length', 'tool_calls', 'stop']) {
      const calls: BabelReviewCall[] = []; const events: ToolStreamEvent[] = [];
      const runner = new ObservedBabelReviewRunner('longcat-2.0', call => calls.push(call), { credentialSource: 'explicit-test', explicitCredential: 'fixture-only' });
      globalThis.fetch = async () => new Response(`data: ${JSON.stringify({ model: 'longcat-2.0', choices: [{ delta: finish === 'stop' ? { content: '{"ok":true}' } : { tool_calls: [{ index: 0, id: 'read-1', type: 'function', function: { name: 'read_file', arguments: '{"path":"source/fixture.ts"}' } }] }, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`);
      for await (const event of runner.executeWithToolsStream([{ role: 'user', content: 'test' }], [])) events.push(event);
      if (finish === 'length') {
        assert.deepEqual(events.map(event => event.type), ['error']); assert.equal(calls[0]?.status, 'failed');
      } else {
        assert.equal(calls[0]?.status, 'completed'); validateBabelReviewCalls(calls, 'longcat-2.0');
        assert.ok(events.some(event => event.type === (finish === 'stop' ? 'text_delta' : 'tool_use')));
        assert.deepEqual(parseObservedBabelReviewAnswer(calls, 'longcat-2.0', () => JSON.parse('{"ok":true}')), { ok: true });
        assert.throws(() => parseObservedBabelReviewAnswer(calls, 'longcat-2.0', () => JSON.parse('bad json')), SyntaxError, 'only a usable response may enter format-only repair');
      }
    }
  } finally { globalThis.fetch = original; }
});
