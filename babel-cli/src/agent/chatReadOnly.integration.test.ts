import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatEngine } from './chatEngine.js';
import { runCliChatTask } from '../interactive/execution/chatCore.js';
import { OpenCodeGoApiRunner } from '../runners/openCodeGoApi.js';
import { babelReviewModelPolicy } from '../services/babelChatReview.js';

test('actual chat dispatch denies adversarial tools and out-of-snapshot reads', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-review-adversarial-'));
  const source = join(root, 'source');
  const { mkdirSync } = await import('node:fs'); mkdirSync(source);
  const content = 'unchanged\n// ENV_BLOCKED: pytest command not found\n// ImportError while loading conftest';
  writeFileSync(join(source, 'fixture.txt'), content);
  writeFileSync(join(root, 'outside.txt'), 'not reviewer data');
  const keys = { BABEL_EXECUTION_PROFILE: 'read_only_audit', BABEL_READ_ONLY: 'true', BABEL_PROJECT_ROOT: source, BABEL_RUNS_DIR: join(root, 'runs'), BABEL_COMPACTION: 'off', BABEL_MEMORY_WRITEBACK: '0', BABEL_CHAT_TASK_CLASS: 'investigate' };
  const previous = Object.fromEntries(Object.keys(keys).map(key => [key, process.env[key]]));
  Object.assign(process.env, keys);
  const originalFetch = globalThis.fetch;
  let call = 0;
  const actions = [
    { name: 'write_file', args: { path: join(source, 'fixture.txt'), content: 'overwritten' } },
    { name: 'str_replace', args: { file_path: join(source, 'fixture.txt'), old_str: 'unchanged', new_str: 'overwritten' } },
    { name: 'run_command', args: { command: 'echo unsafe', cwd: source } },
    { name: 'read_file', args: { path: join(root, 'outside.txt') } },
    { name: 'read_range', args: { file_path: join(root, 'outside.txt'), start_line: 1, end_line: 2 } },
    { name: 'semantic_search', args: { query: 'shared private memory' } },
    { name: 'read_range', args: { file_path: join(source, 'fixture.txt'), start_line: 2, end_line: 3 } },
    { name: 'read_file', args: { path: join(source, 'fixture.txt') } },
  ];
  globalThis.fetch = async () => {
    const action = actions[call++];
    const delta = action ? { tool_calls: [{ index: 0, id: `tool-${call}`, type: 'function', function: { name: action.name, arguments: JSON.stringify(action.args) } }] } : { content: 'Review complete.' };
    return new Response(`data: ${JSON.stringify({ model: 'mimo-v2.5', choices: [{ delta, finish_reason: action ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } })}\n\ndata: [DONE]\n\n`, { status: 200 });
  };
  try {
    const runner = new OpenCodeGoApiRunner('mimo-v2.5', {}, { credentialSource: 'explicit-test', explicitCredential: 'fixture-only' });
    const result = await runCliChatTask({ task: 'Review and inspect fixture.txt without changes.', projectRoot: source, outputFormat: 'json', engineFactory: options => new ChatEngine({ ...options, maxTurns: 12, providerRunner: runner, providerPolicy: babelReviewModelPolicy('mimo-v2.5', source) }) });
    assert.equal(readFileSync(join(source, 'fixture.txt'), 'utf8'), content);
    assert.equal(result.payload['mode'], 'chat');
    const tools = result.payload['toolCalls'] as Array<{ tool: string; error?: string; target?: string; exit_code?: number }>;
    for (const name of ['write_file', 'str_replace', 'run_command', 'semantic_search']) assert.ok(tools.some(t => t.tool === name && t.error), name);
    assert.ok(tools.some(t => t.target === join(root, 'outside.txt') && t.error));
    assert.ok(tools.some(t => t.target === join(source, 'fixture.txt') && t.exit_code === 0));
    assert.equal(result.payload['write_count'], 0);
    assert.equal(result.payload['terminal_outcome'], 'NO_CHANGE_REQUIRED');
    assert.equal(result.payload['env_blocked'], false);
    assert.ok(tools.some(t => t.tool === 'read_range' && t.target === join(source, 'fixture.txt') && t.exit_code === 0));
    assert.ok(existsSync(join(root, 'outside.txt')));
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});
