import assert from 'node:assert/strict';
import test from 'node:test';

import { z } from 'zod';

const originalFetch = globalThis.fetch;
const originalOllamaTokens = process.env['BABEL_OLLAMA_TOKENS'];
const originalDeepInfraTokens = process.env['BABEL_DEEPINFRA_TOKENS'];

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalOllamaTokens === undefined) {
    delete process.env['BABEL_OLLAMA_TOKENS'];
  } else {
    process.env['BABEL_OLLAMA_TOKENS'] = originalOllamaTokens;
  }
  if (originalDeepInfraTokens === undefined) {
    delete process.env['BABEL_DEEPINFRA_TOKENS'];
  } else {
    process.env['BABEL_DEEPINFRA_TOKENS'] = originalDeepInfraTokens;
  }
});

test('OllamaApiRunner constructs without an API key', async () => {
  // Ensure OLLAMA_API_KEY is not set
  delete process.env['OLLAMA_API_KEY'];

  // Should not throw — Ollama needs no API key
  const { OllamaApiRunner } = await import('./ollamaApi.js');
  const runner = new OllamaApiRunner('qwen3.5:4b');
  assert.ok(runner instanceof OllamaApiRunner);
});

test('OllamaApiRunner returns localhost apiUrl', async () => {
  const { OllamaApiRunner } = await import('./ollamaApi.js');
  const runner = new OllamaApiRunner('qwen3.5:4b');

  // apiUrl is protected — access via (runner as any)
  const url = (runner as any).apiUrl;
  assert.match(url, /localhost:11434/);
  assert.match(url, /\/chat\/completions$/);
});

test('OllamaApiRunner respects BABEL_OLLAMA_BASE_URL', async () => {
  process.env['BABEL_OLLAMA_BASE_URL'] = 'http://192.168.1.100:8080/v1';

  const { OllamaApiRunner } = await import('./ollamaApi.js');
  const runner = new OllamaApiRunner('gemma3:4b');

  const url = (runner as any).apiUrl;
  assert.match(url, /192\.168\.1\.100:8080/);
  assert.match(url, /\/chat\/completions$/);

  delete process.env['BABEL_OLLAMA_BASE_URL'];
});

test('OllamaApiRunner getLastInvocationMetadata returns null tokens and zero cost', async () => {
  process.env['BABEL_OLLAMA_TOKENS'] = '256';

  // Mock a successful response with no usage field (Ollama may omit it)
  globalThis.fetch = (async () => {
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: '{"ok":true}' } }],
        // No usage field — Ollama may not report token counts
      }),
      { status: 200 },
    );
  }) as typeof fetch;

  const { OllamaApiRunner } = await import('./ollamaApi.js');
  const runner = new OllamaApiRunner('qwen3.5:4b');
  const result = await runner.execute('return ok', z.object({ ok: z.literal(true) }));
  const metadata = runner.getLastInvocationMetadata();

  assert.deepEqual(result, { ok: true });
  assert.equal(metadata?.provider, 'ollama');
  assert.equal(metadata?.estimated_cost_usd, 0);
  // Token counts should be null when Ollama doesn't report them
  assert.equal(metadata?.prompt_tokens, null);
  assert.equal(metadata?.completion_tokens, null);
  assert.equal(metadata?.total_tokens, null);
});

test('OllamaApiRunner preserves token counts when Ollama reports them', async () => {
  process.env['BABEL_OLLAMA_TOKENS'] = '256';

  globalThis.fetch = (async () => {
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: 'hello' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
      { status: 200 },
    );
  }) as typeof fetch;

  const { OllamaApiRunner } = await import('./ollamaApi.js');
  const runner = new OllamaApiRunner('qwen3.5:4b');
  await runner.executeRaw('say hello');

  const metadata = runner.getLastInvocationMetadata();
  assert.equal(metadata?.provider, 'ollama');
  assert.equal(metadata?.prompt_tokens, 10);
  assert.equal(metadata?.completion_tokens, 5);
  assert.equal(metadata?.total_tokens, 15);
  assert.equal(metadata?.estimated_cost_usd, 0);
});

test('OllamaApiRunner does not leak BABEL_DEEPINFRA_TOKENS override', async () => {
  const before = process.env['BABEL_DEEPINFRA_TOKENS'];

  process.env['BABEL_OLLAMA_TOKENS'] = '2048';
  const { OllamaApiRunner } = await import('./ollamaApi.js');
  new OllamaApiRunner('qwen3.5:4b');

  // After construction, BABEL_DEEPINFRA_TOKENS should be restored
  if (before === undefined) {
    assert.equal(process.env['BABEL_DEEPINFRA_TOKENS'], undefined);
  } else {
    assert.equal(process.env['BABEL_DEEPINFRA_TOKENS'], before);
  }

  delete process.env['BABEL_OLLAMA_TOKENS'];
});
