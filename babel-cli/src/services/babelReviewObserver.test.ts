import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import type { ToolStreamEvent } from '../runners/base.js';
import { ObservedBabelReviewRunner, validateBabelReviewCalls, type BabelReviewCall } from './babelReviewObserver.js';

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
  globalThis.fetch = async () => { requests++; return nativeResponse('x'.repeat(4 * 1024 * 1024), true); };
  try {
    await assert.rejects(async () => { for await (const event of runner.executeWithToolsStream([{ role: 'user', content: 'test' }], [])) events.push(event); }, /CHAT_REVIEW_NATIVE_BUFFER_LIMIT/);
    assert.equal(requests, 1); assert.deepEqual(events, []); assert.equal(calls[0]?.status, 'failed');
    assert.equal(calls[0]?.retry_reason, undefined);
  } finally { globalThis.fetch = original; }
});
