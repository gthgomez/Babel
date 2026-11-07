import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AgentSession } from './session.js';

test('fix fallback propagates cancellation to the actual provider request', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-fix-fallback-cancel-'));
  const controller = new AbortController();
  const originalFetch = globalThis.fetch;
  const originalKey = process.env['OPENROUTER_API_KEY'];
  const originalRoot = process.env['BABEL_PROJECT_ROOT'];
  let calls = 0;
  let observedAbort = false;
  try {
    writeFileSync(join(root, 'README.md'), 'synthetic project\n');
    process.env['OPENROUTER_API_KEY'] = 'synthetic-test-key';
    process.env['BABEL_PROJECT_ROOT'] = root;
    globalThis.fetch = (async (_input, init) => {
      calls += 1;
      controller.abort();
      observedAbort = init?.signal?.aborted === true;
      throw new DOMException('Synthetic cancellation', 'AbortError');
    }) as typeof fetch;
    const session = new AgentSession({
      task: 'Refactor the entire repository.', verb: 'fix', projectRoot: root,
      model: 'deepseek-v4-flash-openrouter', signal: controller.signal,
    });
    await session.run().catch(() => undefined);
    assert.equal(calls, 1, 'exactly one synthetic request should reach the provider boundary');
    assert.equal(observedAbort, true, 'the provider request must receive the parent cancellation');
    assert.equal(readFileSync(join(root, 'README.md'), 'utf8'), 'synthetic project\n');
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env['OPENROUTER_API_KEY']; else process.env['OPENROUTER_API_KEY'] = originalKey;
    if (originalRoot === undefined) delete process.env['BABEL_PROJECT_ROOT']; else process.env['BABEL_PROJECT_ROOT'] = originalRoot;
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
