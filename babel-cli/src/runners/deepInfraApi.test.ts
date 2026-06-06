import assert from 'node:assert/strict';
import test from 'node:test';

import { z } from 'zod';

const originalFetch = globalThis.fetch;
const originalApiKey = process.env['DEEPINFRA_API_KEY'];
const originalStreamIdle = process.env['BABEL_DEEPINFRA_STREAM_IDLE_TIMEOUT_MS'];
const originalStreamRetries = process.env['BABEL_DEEPINFRA_STREAM_MAX_RETRIES'];

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalApiKey === undefined) {
    delete process.env['DEEPINFRA_API_KEY'];
  } else {
    process.env['DEEPINFRA_API_KEY'] = originalApiKey;
  }
  if (originalStreamIdle === undefined) {
    delete process.env['BABEL_DEEPINFRA_STREAM_IDLE_TIMEOUT_MS'];
  } else {
    process.env['BABEL_DEEPINFRA_STREAM_IDLE_TIMEOUT_MS'] = originalStreamIdle;
  }
  if (originalStreamRetries === undefined) {
    delete process.env['BABEL_DEEPINFRA_STREAM_MAX_RETRIES'];
  } else {
    process.env['BABEL_DEEPINFRA_STREAM_MAX_RETRIES'] = originalStreamRetries;
  }
});

test('DeepInfra API runner retries retryable HTTP failures before parsing JSON', async () => {
  process.env['DEEPINFRA_API_KEY'] = 'test-key';
  const { DeepInfraApiRunner } = await import('./deepInfraApi.js');
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    if (calls === 1) {
      return new Response('temporary overload', { status: 500 });
    }
    return new Response(JSON.stringify({
      choices: [{ message: { content: '{"ok":true}' } }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    }), { status: 200 });
  }) as typeof fetch;

  const runner = new DeepInfraApiRunner('deepseek-ai/DeepSeek-V3-0324');
  const result = await runner.execute('return ok', z.object({ ok: z.literal(true) }));
  const metadata = runner.getLastInvocationMetadata();

  assert.deepEqual(result, { ok: true });
  assert.equal(calls, 2);
  assert.equal(metadata?.provider, 'deepinfra');
  assert.equal(metadata?.provider_model_id, 'deepseek-ai/DeepSeek-V3-0324');
  assert.equal(metadata?.cost_precision, 'conservative');
  assert.match(metadata?.pricing_source_url ?? '', /deepinfra/i);
  assert.ok(Math.abs((metadata?.estimated_cost_usd ?? 0) - 0.00000214) < 1e-12);
});

test('DeepInfra API runner retries transport aborts before failing the call', async () => {
  process.env['DEEPINFRA_API_KEY'] = 'test-key';
  const { DeepInfraApiRunner } = await import('./deepInfraApi.js');
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    if (calls === 1) {
      const error = new Error('aborted');
      error.name = 'AbortError';
      throw error;
    }
    return new Response(JSON.stringify({
      choices: [{ message: { content: '{"status":"ok"}' } }],
    }), { status: 200 });
  }) as typeof fetch;

  const result = await new DeepInfraApiRunner('deepseek-ai/DeepSeek-V3-0324')
    .execute('return ok', z.object({ status: z.literal('ok') }));

  assert.deepEqual(result, { status: 'ok' });
  assert.equal(calls, 2);
});

test('DeepInfra API runner throws structured invalid JSON errors with raw output', async () => {
  process.env['DEEPINFRA_API_KEY'] = 'test-key';
  const { DeepInfraApiRunner } = await import('./deepInfraApi.js');
  const { isStructuredOutputError } = await import('./base.js');

  globalThis.fetch = (async () => new Response(JSON.stringify({
    choices: [{ message: { content: 'not json' } }],
  }), { status: 200 })) as typeof fetch;

  await assert.rejects(
    () => new DeepInfraApiRunner('deepseek-ai/DeepSeek-V3-0324')
      .execute('return ok', z.object({ ok: z.literal(true) })),
    (error: unknown) => {
      assert.equal(isStructuredOutputError(error), true);
      if (!isStructuredOutputError(error)) return false;
      assert.equal(error.failure_kind, 'invalid_json');
      assert.equal(error.provider, 'deepinfra');
      assert.equal(error.model, 'deepseek-ai/DeepSeek-V3-0324');
      assert.equal(error.raw_output, 'not json');
      assert.equal(error.parsed_json, null);
      assert.match(error.message, /invalid json/);
      return true;
    },
  );
});

test('DeepInfra API runner retries a stream idle timeout', async () => {
  process.env['DEEPINFRA_API_KEY'] = 'test-key';
  process.env['BABEL_DEEPINFRA_STREAM_IDLE_TIMEOUT_MS'] = '5';
  process.env['BABEL_DEEPINFRA_STREAM_MAX_RETRIES'] = '1';
  const { DeepInfraApiRunner } = await import('./deepInfraApi.js');
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(new ReadableStream({
        start() {
          // Intentionally never enqueue data so the idle timer classifies the failure.
        },
      }), { status: 200 });
    }
    return new Response([
      'data: {"choices":[{"delta":{"content":"{\\"ok\\":true}"}}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n'), { status: 200 });
  }) as typeof fetch;

  const result = await new DeepInfraApiRunner('deepseek-ai/DeepSeek-V3-0324')
    .execute('return ok', z.object({ ok: z.literal(true) }), { onChunk: () => {} });

  assert.deepEqual(result, { ok: true });
  assert.equal(calls, 2);
});

test('DeepInfra API runner classifies stream idle timeout after retries', async () => {
  process.env['DEEPINFRA_API_KEY'] = 'test-key';
  process.env['BABEL_DEEPINFRA_STREAM_IDLE_TIMEOUT_MS'] = '5';
  process.env['BABEL_DEEPINFRA_STREAM_MAX_RETRIES'] = '0';
  const { DeepInfraApiRunner } = await import('./deepInfraApi.js');
  globalThis.fetch = (async () => new Response(new ReadableStream({
    start() {
      // Intentionally idle.
    },
  }), { status: 200 })) as typeof fetch;

  await assert.rejects(
    () => new DeepInfraApiRunner('deepseek-ai/DeepSeek-V3-0324')
      .execute('return ok', z.object({ ok: z.literal(true) }), { onChunk: () => {} }),
    /stream idle timeout after 5ms/,
  );
});
