import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { ObservedBabelReviewRunner, type BabelReviewCall } from './babelReviewObserver.js';

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
