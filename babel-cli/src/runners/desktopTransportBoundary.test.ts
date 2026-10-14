import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { loadBabelCliEnv } from '../config/envBootstrap.js';
import { DeepInfraApiRunner } from './deepInfraApi.js';
import { DeepSeekApiRunner } from './deepSeekApi.js';
import { OpenRouterApiRunner } from './openRouterApi.js';
import { OllamaApiRunner } from './ollamaApi.js';
import { LLMSummarizeCompaction } from '../agent/chatCompaction.js';

test('Desktop local Ollama ignores a remote endpoint restored by profile bootstrap', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'babel-synthetic-ollama-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const names = ['BABEL_DESKTOP_PROVIDER', 'BABEL_OLLAMA_BASE_URL'];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  t.after(() => { for (const name of names) { if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name]; } });
  const file = join(directory, '.env');
  await writeFile(file, 'BABEL_OLLAMA_BASE_URL=https://foreign.invalid/v1\n', { mode: 0o600 });
  delete process.env['BABEL_OLLAMA_BASE_URL'];
  loadBabelCliEnv(process.env, file);
  class EndpointProbe extends OllamaApiRunner { endpoint(): string { return this.apiUrl; } }
  const runner = new EndpointProbe('qwen3:latest');
  process.env['BABEL_DESKTOP_PROVIDER'] = 'ollama';
  assert.equal(runner.endpoint(), 'http://127.0.0.1:11434/v1/chat/completions');
  delete process.env['BABEL_DESKTOP_PROVIDER'];
  assert.equal(runner.endpoint(), 'https://foreign.invalid/v1/chat/completions');
});

test('Desktop raw, native and compaction requests reject redirects', async (t) => {
  const names = ['BABEL_DESKTOP_PROVIDER', 'DEEPSEEK_API_KEY', 'OPENROUTER_API_KEY', 'DEEPINFRA_API_KEY'];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  const previousFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = previousFetch; for (const name of names) { if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name]; } });
  for (const name of names.slice(1)) process.env[name] = 'synthetic-only';
  process.env['DEEPSEEK_API_KEY'] = 'sk-test-key';
  const requests: RequestInit[] = [];
  globalThis.fetch = (async (_url, init) => {
    requests.push(init ?? {});
    const body = JSON.parse(String(init?.body));
    if (!body.stream) return Response.json({ model: body.model, choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    return new Response(`data: ${JSON.stringify({ model: body.model, choices: [{ delta: { content: '{"ok":true}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`, { status: 200 });
  }) as typeof fetch;
  for (const [provider, runner] of [
    ['openrouter', new OpenRouterApiRunner('deepseek/deepseek-v4-pro')],
    ['deepinfra', new DeepInfraApiRunner('Qwen/Qwen3-235B-A22B-Instruct-2507')],
    ['deepseek', new DeepSeekApiRunner('deepseek-v4-pro')],
    ['ollama', new OllamaApiRunner('qwen3:latest')],
  ] as const) {
    process.env['BABEL_DESKTOP_PROVIDER'] = provider;
    await runner.execute('Public fixture', z.object({ ok: z.literal(true) }));
    for await (const _event of runner.executeWithToolsStream([{ role: 'user', content: 'Public fixture' }], [])) { /* Drain the actual native transport. */ }
  }
  process.env['BABEL_DESKTOP_PROVIDER'] = 'openrouter';
  const strategy = new LLMSummarizeCompaction({ keepRecentMessages: 2 });
  await strategy.compact(Array.from({ length: 8 }, (_, index) => ({ role: index % 2 === 0 ? 'user' as const : 'assistant' as const, content: 'Public fixture '.repeat(30) })), {
    model: 'deepseek/deepseek-v4-pro', maxTokens: 100,
    summarizationProvider: { apiKey: 'synthetic-only', baseUrl: 'https://openrouter.ai/api/v1/chat/completions', defaultModel: 'deepseek/deepseek-v4-pro' }, allowAmbientProvider: false,
  });
  assert.equal(requests.length, 9);
  for (const request of requests) assert.equal(request.redirect, 'error');
});
