import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const load = async name => import(`../native/${name}.mjs`);

test('host-run argv targets the CLI remote host-run entry with model route', async () => {
  const { buildHostRunArgs } = await load('sharedProtocolRun');
  const entry = join(tmpdir(), 'babel-cli', 'dist', 'index.js');
  const root = join(tmpdir(), 'project');
  const args = buildHostRunArgs(entry, root, {
    runId: 'run-1',
    mode: 'chat',
    task: 'hello',
    sessionId: 'thr-abc',
    model: 'deepseek/deepseek-v4-flash',
    provider: 'openrouter',
  });
  assert.ok(args.includes('host-run'));
  assert.ok(args.includes('--resume-thread'));
  assert.ok(args.includes('thr-abc'));
  assert.ok(args.includes('--model'));
  assert.ok(args.includes('--provider'));
});
