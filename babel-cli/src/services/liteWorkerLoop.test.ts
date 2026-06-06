import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { AgentSession } from '../agent/session.js';
import {
  readLiteTrustDemoFixture,
  resolveLiteTrustDemoFixturePath,
} from './liteTrustDemo.js';
import { runLiteWorkerLoop, runLiteWorkerLoopHarness } from './liteWorkerLoop.js';

function writeTrustDemoRepo(root: string, implementation: string, targetFile: string): void {
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    type: 'module',
    scripts: { test: 'node src/math.test.js' },
  }, null, 2), 'utf-8');
  writeFileSync(join(root, targetFile), implementation, 'utf-8');
  writeFileSync(join(root, 'src', 'math.test.js'), [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { add } from './math.js';",
    '',
    "test('add sums two numbers', () => {",
    '  assert.equal(add(1, 2), 3);',
    '});',
    '',
  ].join('\n'), 'utf-8');
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'babel-lite',
    GIT_AUTHOR_EMAIL: 'babel-lite@local',
    GIT_COMMITTER_NAME: 'babel-lite',
    GIT_COMMITTER_EMAIL: 'babel-lite@local',
  };
  assert.equal(spawnSync('git', ['init'], { cwd: root, encoding: 'utf-8' }).status, 0);
  assert.equal(spawnSync('git', ['add', '.'], { cwd: root, encoding: 'utf-8', env: gitEnv }).status, 0);
  assert.equal(spawnSync('git', ['commit', '-m', 'init'], { cwd: root, encoding: 'utf-8', env: gitEnv }).status, 0);
}

test('lite worker loop harness runs plan propose fix review undo offline', { concurrency: false }, async () => {
  const result = await runLiteWorkerLoopHarness();
  assert.equal(result.status, 'pass');
  assert.equal(result.execution_mode, 'offline_demo');
  assert.deepEqual(
    result.steps.map(step => step.name),
    ['bl_plan', 'bl_propose', 'bl_fix', 'bl_review', 'bl_undo'],
  );
  assert.equal(result.worker_steps.length, 5);
});

test('AgentSession worker chain completes on trust demo fixture', { concurrency: false, timeout: 120_000 }, async () => {
  const fixture = readLiteTrustDemoFixture(resolveLiteTrustDemoFixturePath());
  const root = mkdtempSync(join(tmpdir(), 'babel-session-worker-'));
  try {
    writeTrustDemoRepo(root, fixture.broken_implementation, fixture.target_file);
    const session = new AgentSession({
      task: fixture.task,
      verb: 'do',
      projectRoot: root,
      provider: 'mock',
      workerChain: true,
    });
    const result = await session.run();
    assert.equal(result.exitCode, 0);
    const payload = result.payload as { status?: string; execution_mode?: string; steps?: unknown[] };
    assert.equal(payload.status, 'WORKER_LOOP_COMPLETE');
    assert.equal(payload.execution_mode, 'offline_demo');
    assert.equal(payload.steps?.length, 5);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runLiteWorkerLoop reports failure when review step cannot run', { concurrency: false }, async () => {
  const fixture = readLiteTrustDemoFixture(resolveLiteTrustDemoFixturePath());
  const root = mkdtempSync(join(tmpdir(), 'babel-lite-worker-loop-fail-'));
  try {
    writeTrustDemoRepo(root, fixture.broken_implementation, fixture.target_file);
    const result = await runLiteWorkerLoop({
      projectRoot: root,
      task: '',
      fixturePath: resolveLiteTrustDemoFixturePath(),
    });
    assert.equal(result.status, 'fail');
    const failedStep = result.steps.find(step => step.status === 'fail');
    assert.ok(failedStep);
    assert.equal(failedStep?.verb, 'plan');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
