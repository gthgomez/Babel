import assert from 'node:assert/strict';
import test from 'node:test';

import { z } from 'zod';

const originalFetch = globalThis.fetch;
const originalApiKey = process.env['DEEPSEEK_API_KEY'];

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalApiKey === undefined) {
    delete process.env['DEEPSEEK_API_KEY'];
  } else {
    process.env['DEEPSEEK_API_KEY'] = originalApiKey;
  }
});

test('DeepSeek API runner calls the direct OpenAI-compatible endpoint', async () => {
  process.env['DEEPSEEK_API_KEY'] = 'sk-test-key';
  const { DeepSeekApiRunner } = await import('./deepSeekApi.js');
  let requestUrl = '';
  let requestBody: { model?: string; response_format?: { type?: string } } = {};

  globalThis.fetch = (async (input, init) => {
    requestUrl = String(input);
    requestBody = JSON.parse(String(init?.body ?? '{}')) as {
      model?: string;
      response_format?: { type?: string };
    };
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: '{"ok":true}' } }],
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 2000,
          total_tokens: 3000,
          prompt_cache_hit_tokens: 400,
          prompt_cache_miss_tokens: 600,
        },
      }),
      { status: 200 },
    );
  }) as typeof fetch;

  const runner = new DeepSeekApiRunner('deepseek-v4-flash');
  const result = await runner.execute('return ok', z.object({ ok: z.literal(true) }));
  const metadata = runner.getLastInvocationMetadata();

  assert.deepEqual(result, { ok: true });
  assert.equal(requestUrl, 'https://api.deepseek.com/v1/chat/completions');
  assert.equal(requestBody.model, 'deepseek-v4-flash');
  assert.deepEqual(requestBody.response_format, { type: 'json_object' });
  assert.equal(metadata?.provider, 'deepseek');
  assert.equal(metadata?.provider_model_id, 'deepseek-v4-flash');
  assert.equal(metadata?.total_tokens, 3000);
  assert.equal(metadata?.prompt_cache_hit_tokens, 400);
  assert.equal(metadata?.prompt_cache_miss_tokens, 600);
  assert.equal(metadata?.cost_precision, 'exact');
  assert.match(metadata?.pricing_source_url ?? '', /deepseek/i);
  assert.ok(Math.abs((metadata?.estimated_cost_usd ?? 0) - 0.00064512) < 1e-12);
});

test('DeepSeek API runner retries retryable HTTP failures', async () => {
  process.env['DEEPSEEK_API_KEY'] = 'sk-test-key';
  const { DeepSeekApiRunner } = await import('./deepSeekApi.js');
  let calls = 0;

  globalThis.fetch = (async () => {
    calls += 1;
    if (calls === 1) {
      return new Response('temporary overload', { status: 500 });
    }
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: '{"status":"ok"}' } }],
      }),
      { status: 200 },
    );
  }) as typeof fetch;

  const result = await new DeepSeekApiRunner('deepseek-v4-flash').execute(
    'return ok',
    z.object({ status: z.literal('ok') }),
  );

  assert.deepEqual(result, { status: 'ok' });
  assert.equal(calls, 2);
});

test('DeepSeek API runner throws structured Zod errors with parsed output', async () => {
  process.env['DEEPSEEK_API_KEY'] = 'sk-test-key';
  const { DeepSeekApiRunner } = await import('./deepSeekApi.js');
  const { isStructuredOutputError } = await import('./base.js');

  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content: '{"ok":false}' } }],
      }),
      { status: 200 },
    )) as typeof fetch;

  await assert.rejects(
    () =>
      new DeepSeekApiRunner('deepseek-v4-flash').execute(
        'return ok',
        z.object({ ok: z.literal(true) }),
      ),
    (error: unknown) => {
      assert.equal(isStructuredOutputError(error), true);
      if (!isStructuredOutputError(error)) return false;
      assert.equal(error.failure_kind, 'zod_validation_failed');
      assert.equal(error.provider, 'deepseek');
      assert.equal(error.model, 'deepseek-v4-flash');
      assert.equal(error.raw_output, '{"ok":false}');
      assert.deepEqual(error.parsed_json, { ok: false });
      assert.ok(error.zod_issues);
      assert.match(error.message, /Zod validation failed/);
      return true;
    },
  );
});

test('DeepSeek API runner requires DEEPSEEK_API_KEY', async () => {
  delete process.env['DEEPSEEK_API_KEY'];
  const { DeepSeekApiRunner } = await import('./deepSeekApi.js');

  assert.throws(() => new DeepSeekApiRunner('deepseek-v4-flash'), /DEEPSEEK_API_KEY is not set/);
});

test('DeepSeek API runner rejects deprecated direct model aliases', async () => {
  process.env['DEEPSEEK_API_KEY'] = 'sk-test-key';
  const { DeepSeekApiRunner } = await import('./deepSeekApi.js');

  assert.throws(
    () => new DeepSeekApiRunner('deepseek-chat'),
    /Unsupported DeepSeek model "deepseek-chat"/,
  );
});

test('DeepSeek API runner conservatively prices input cache misses when cache split is absent', async () => {
  process.env['DEEPSEEK_API_KEY'] = 'sk-test-key';
  const { DeepSeekApiRunner } = await import('./deepSeekApi.js');

  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content: '{"ok":true}' } }],
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 2000,
          total_tokens: 3000,
        },
      }),
      { status: 200 },
    )) as typeof fetch;

  const runner = new DeepSeekApiRunner('deepseek-v4-pro');
  await runner.execute('return ok', z.object({ ok: z.literal(true) }));

  const metadata = runner.getLastInvocationMetadata();
  assert.equal(metadata?.cost_precision, 'conservative');
  assert.ok(Math.abs((metadata?.estimated_cost_usd ?? 0) - 0.002175) < 1e-12);
});

// ─── executeWithToolsStream tests ─────────────────────────────────────

function makeSseResponse(sseLines: string[]): Response {
  const data = sseLines.join('\n') + '\n';
  return new Response(data, { status: 200 });
}

test('DeepSeek API runner executeWithToolsStream yields tool_use for native tool calls', async () => {
  process.env['DEEPSEEK_API_KEY'] = 'sk-test-key';
  const { DeepSeekApiRunner } = await import('./deepSeekApi.js');

  globalThis.fetch = (async () =>
    makeSseResponse([
      'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":null,"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_file","arguments":""}}]}}]}',
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\": \\"src/file.ts\\"}"}}]}}]}',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}',
      'data: [DONE]',
    ])) as typeof fetch;

  const runner = new DeepSeekApiRunner('deepseek-v4-flash');
  const events: any[] = [];
  for await (const event of runner.executeWithToolsStream(
    [{ role: 'user', content: 'read src/file.ts' }],
    [{
      type: 'function' as const,
      function: {
        name: 'read_file',
        description: 'Read a file',
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      },
    }],
  )) {
    events.push(event);
  }

  assert.equal(events.length, 2);
  assert.equal(events[0]!.type, 'tool_use');
  assert.equal(events[0]!.name, 'read_file');
  assert.deepEqual(events[0]!.input, { path: 'src/file.ts' });
  assert.equal(events[0]!.id, 'call_1');
  assert.equal(events[1]!.type, 'done');
  assert.equal(events[1]!.finishReason, 'tool_calls');

  // Verify metadata was populated
  const metadata = runner.getLastInvocationMetadata();
  assert.equal(metadata?.provider, 'deepseek');
  assert.equal(metadata?.prompt_tokens, 10);
  assert.equal(metadata?.completion_tokens, 5);
});

test('DeepSeek API runner executeWithToolsStream yields text_delta for completion', async () => {
  process.env['DEEPSEEK_API_KEY'] = 'sk-test-key';
  const { DeepSeekApiRunner } = await import('./deepSeekApi.js');

  globalThis.fetch = (async () =>
    makeSseResponse([
      'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"Hello"}}]}',
      'data: {"choices":[{"index":0,"delta":{"content":" world"}}]}',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":3,"total_tokens":8}}',
      'data: [DONE]',
    ])) as typeof fetch;

  const runner = new DeepSeekApiRunner('deepseek-v4-flash');
  const events: any[] = [];
  for await (const event of runner.executeWithToolsStream(
    [{ role: 'user', content: 'say hello' }],
    [],
  )) {
    events.push(event);
  }

  assert.equal(events.length, 3);
  assert.equal(events[0]!.type, 'text_delta');
  assert.equal(events[0]!.text, 'Hello');
  assert.equal(events[1]!.type, 'text_delta');
  assert.equal(events[1]!.text, ' world');
  assert.equal(events[2]!.type, 'done');
  assert.equal(events[2]!.finishReason, 'stop');
});

test('DeepSeek API runner executeWithToolsStream yields error on HTTP failure', async () => {
  process.env['DEEPSEEK_API_KEY'] = 'sk-test-key';
  const { DeepSeekApiRunner } = await import('./deepSeekApi.js');

  globalThis.fetch = (async () =>
    new Response('Unauthorized', { status: 401 })
  ) as typeof fetch;

  const runner = new DeepSeekApiRunner('deepseek-v4-flash');
  const events: any[] = [];
  for await (const event of runner.executeWithToolsStream(
    [{ role: 'user', content: 'do something' }],
    [],
  )) {
    events.push(event);
  }

  assert.equal(events.length, 1);
  assert.equal(events[0]!.type, 'error');
  assert.match(events[0]!.message, /HTTP 401/);
});
