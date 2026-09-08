import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
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

test('partial model output is never retried', async () => {
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
    for await (const _event of runner.executeWithToolsStream([{ role: 'user', content: 'test' }], [])) { /* consume */ }
    assert.equal(requests, 1); assert.throws(() => validateBabelReviewCalls(calls, 'mimo-v2.5'));
  } finally { globalThis.fetch = original; }
});
