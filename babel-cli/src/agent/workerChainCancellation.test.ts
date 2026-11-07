import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AgentSession } from './session.js';

test('an unqualified worker chain cannot admit successor steps after cancellation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-worker-stop-'));
  const controller = new AbortController();
  const originalRun = AgentSession.prototype.run;
  let calls = 0;
  try {
    AgentSession.prototype.run = async () => {
      calls += 1;
      controller.abort();
      return { payload: { status: 'PLAN_READY' }, exitCode: 0, humanText: '' };
    };
    const session = new AgentSession({ task: 'Synthetic worker task', verb: 'do', projectRoot: root, provider: 'mock', workerChain: true, signal: controller.signal });
    const result = await session.runWorkerLoop();
    assert.equal(calls, 0, 'the unqualified worker chain must not dispatch a child');
    assert.notEqual(result.exitCode, 0);
    assert.equal(result.payload['status'], 'WORKER_LOOP_BLOCKED');
  } finally {
    AgentSession.prototype.run = originalRun;
    rmSync(root, { recursive: true, force: true });
  }
});
