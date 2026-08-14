import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, beforeEach, afterEach } from 'node:test';

import {
  awaitBackgroundShell,
  capObservationText,
  clearBackgroundShellRegistry,
  killAllBackgroundShells,
  killBackgroundShell,
  resetBackgroundShellRegistryForTests,
  startBackgroundShell,
} from './backgroundShell.js';
import { getSafeEnv } from '../utils/safeEnv.js';
import { ChatEngine } from './chatEngine.js';

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function waitUntilDead(pid: number, timeoutMs = 2_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isProcessAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !isProcessAlive(pid);
}

async function waitForStdoutPid(jobId: string, timeoutMs = 5_000): Promise<number> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const snap = await awaitBackgroundShell(jobId, 50);
    const match = snap.stdout.trim().match(/^\d+$/m);
    if (match) return Number(match[0]);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for grandchild PID in stdout for ${jobId}`);
}

describe('backgroundShell', () => {
  beforeEach(() => {
    resetBackgroundShellRegistryForTests();
  });

  afterEach(() => {
    resetBackgroundShellRegistryForTests();
  });

  it('starts a command and returns a task id immediately', async () => {
    // Simple argv (no quotes) — same tokenizer contract as sandbox shellExec.
    const job = startBackgroundShell({
      command: 'echo hello-bg',
      cwd: process.cwd(),
    });
    assert.ok(job.id.startsWith('bg-'));
    assert.equal(job.status, 'running');

    const result = await awaitBackgroundShell(job.id, 15_000);
    assert.equal(result.timed_out, false);
    assert.equal(result.exit_code, 0);
    assert.match(result.stdout, /hello-bg/);
    assert.equal(result.status, 'completed');
  });

  it('await reports timed_out without killing a still-running job', async () => {
    // Avoid quoted args; sandbox-style split on whitespace.
    const sleeper =
      process.platform === 'win32' ? 'ping -n 4 127.0.0.1' : 'sleep 3';
    const job = startBackgroundShell({ command: sleeper, cwd: process.cwd() });
    const early = await awaitBackgroundShell(job.id, 200);
    assert.equal(early.timed_out, true);
    assert.equal(early.status, 'running');

    const done = await awaitBackgroundShell(job.id, 20_000);
    assert.equal(done.timed_out, false);
    assert.ok(done.status === 'completed' || done.status === 'failed' || done.status === 'killed');
  });

  it('returns an error for unknown task ids', async () => {
    const result = await awaitBackgroundShell('bg-missing', 100);
    assert.equal(result.status, 'failed');
    assert.match(result.stderr, /Unknown background task_id/);
  });

  it('hard-kills a job when timeoutMs elapses', async () => {
    const sleeper =
      process.platform === 'win32' ? 'ping -n 10 127.0.0.1' : 'sleep 8';
    const job = startBackgroundShell({
      command: sleeper,
      cwd: process.cwd(),
      timeoutMs: 400,
    });
    const result = await awaitBackgroundShell(job.id, 10_000);
    assert.equal(result.timed_out, false);
    assert.equal(result.status, 'killed');
    assert.match(result.stderr, /timed out after 400ms/);
  });

  it('killBackgroundShell stops a running job', async () => {
    const sleeper =
      process.platform === 'win32' ? 'ping -n 10 127.0.0.1' : 'sleep 8';
    const job = startBackgroundShell({
      command: sleeper,
      cwd: process.cwd(),
      timeoutMs: 60_000,
    });
    const killed = killBackgroundShell(job.id);
    assert.equal(killed.status, 'killed');
    const result = await awaitBackgroundShell(job.id, 5_000);
    assert.equal(result.status, 'killed');
  });

  it('hard timeout terminates the full process tree (grandchild)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bg-shell-timeout-tree-'));
    const grandchildScript = join(dir, 'grandchild.js');
    const parentScript = join(dir, 'parent.js');
    writeFileSync(grandchildScript, 'setTimeout(()=>{},60000);\n');
    writeFileSync(parentScript, [
      "const cp=require('child_process');",
      'const gc=cp.spawn(process.execPath,[process.argv[2]],{stdio:"ignore"});',
      'console.log(String(gc.pid));',
      'setTimeout(()=>{},60000);',
    ].join(''));
    let grandchildPid: number | undefined;
    try {
      const job = startBackgroundShell({
        command: `node ${parentScript} ${grandchildScript}`,
        cwd: process.cwd(),
        timeoutMs: 400,
      });
      grandchildPid = await waitForStdoutPid(job.id);
      const result = await awaitBackgroundShell(job.id, 5_000);
      assert.equal(result.status, 'killed');
      assert.ok(await waitUntilDead(grandchildPid), 'grandchild should exit after timeout tree kill');
    } finally {
      if (grandchildPid !== undefined && isProcessAlive(grandchildPid)) {
        try { process.kill(grandchildPid); } catch { /* already gone */ }
      }
    }
  });
  it('killBackgroundShell terminates the full process tree (grandchild)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bg-shell-tree-'));
    const grandchildScript = join(dir, 'grandchild.js');
    const parentScript = join(dir, 'parent.js');
    writeFileSync(grandchildScript, 'setTimeout(()=>{},60000);\n');
    // Grandchild must stay in the job's process group (no detached:true) —
    // POSIX terminateChildTree kills by group, so a detached grandchild would
    // escape by design. Same contract as sandbox.test.ts tree-parent.mjs.
    writeFileSync(
      parentScript,
      [
        "const cp=require('child_process');",
        'const gc=cp.spawn(process.execPath,[process.argv[2]],{stdio:"ignore"});',
        'console.log(String(gc.pid));',
        'setTimeout(()=>{},60000);',
      ].join(''),
    );

    let grandchildPid: number | undefined;
    try {
      const job = startBackgroundShell({
        command: `node ${parentScript} ${grandchildScript}`,
        cwd: process.cwd(),
        timeoutMs: 60_000,
      });
      grandchildPid = await waitForStdoutPid(job.id);
      assert.ok(isProcessAlive(grandchildPid), 'grandchild should be running before kill');

      killBackgroundShell(job.id);
      assert.ok(await waitUntilDead(grandchildPid), 'grandchild should exit after tree kill');
    } finally {
      // A failed assertion must not leak a 60s node process.
      if (grandchildPid !== undefined && isProcessAlive(grandchildPid)) {
        try {
          process.kill(grandchildPid);
        } catch {
          /* already gone */
        }
      }
    }
  });

  it('killAllBackgroundShells kills non-detached jobs and preserves detached', async () => {
    const sleeper =
      process.platform === 'win32' ? 'ping -n 10 127.0.0.1' : 'sleep 8';
    const normal = startBackgroundShell({
      command: sleeper,
      cwd: process.cwd(),
      timeoutMs: 60_000,
    });
    const detached = startBackgroundShell({
      command: sleeper,
      cwd: process.cwd(),
      timeoutMs: 60_000,
      detached: true,
    });

    const { killed } = killAllBackgroundShells();
    assert.deepEqual(killed, [normal.id]);

    const normalResult = await awaitBackgroundShell(normal.id, 2_000);
    assert.equal(normalResult.status, 'killed');
    assert.match(normalResult.stderr, /Killed by turn cancellation/);

    const detachedEarly = await awaitBackgroundShell(detached.id, 200);
    assert.equal(detachedEarly.timed_out, true);
    assert.equal(detachedEarly.status, 'running');

    killBackgroundShell(detached.id);
    const detachedDone = await awaitBackgroundShell(detached.id, 2_000);
    assert.equal(detachedDone.status, 'killed');
  });

  it('killAllBackgroundShells with ownerId only kills that owner', async () => {
    const sleeper =
      process.platform === 'win32' ? 'ping -n 10 127.0.0.1' : 'sleep 8';
    const mine = startBackgroundShell({
      command: sleeper,
      cwd: process.cwd(),
      timeoutMs: 60_000,
      ownerId: 'engine-a',
    });
    const sibling = startBackgroundShell({
      command: sleeper,
      cwd: process.cwd(),
      timeoutMs: 60_000,
      ownerId: 'engine-b',
    });

    const { killed } = killAllBackgroundShells({ ownerId: 'engine-a' });
    assert.deepEqual(killed, [mine.id]);

    const mineResult = await awaitBackgroundShell(mine.id, 5_000);
    assert.equal(mineResult.status, 'killed');

    const siblingSnap = await awaitBackgroundShell(sibling.id, 200);
    assert.equal(siblingSnap.status, 'running');
    killBackgroundShell(sibling.id);
  });

  it('abortTurn terminates its full owned process tree (grandchild)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bg-shell-abort-tree-'));
    const grandchildScript = join(dir, 'grandchild.js');
    const parentScript = join(dir, 'parent.js');
    writeFileSync(grandchildScript, 'setTimeout(()=>{},60000);\n');
    writeFileSync(parentScript, [
      "const cp=require('child_process');",
      'const gc=cp.spawn(process.execPath,[process.argv[2]],{stdio:"ignore"});',
      'console.log(String(gc.pid));',
      'setTimeout(()=>{},60000);',
    ].join(''));
    const runId = 'bg-shell-abort-tree';
    const engine = new ChatEngine({ task: 't', projectRoot: process.cwd(), runId });
    let grandchildPid: number | undefined;
    try {
      const job = startBackgroundShell({ command: `node ${parentScript} ${grandchildScript}`, cwd: process.cwd(), timeoutMs: 60_000, ownerId: runId });
      grandchildPid = await waitForStdoutPid(job.id);
      engine.abortTurn();
      const result = await awaitBackgroundShell(job.id, 5_000);
      assert.equal(result.status, 'killed');
      assert.ok(await waitUntilDead(grandchildPid), 'grandchild should exit after owner abort tree kill');
    } finally {
      if (grandchildPid !== undefined && isProcessAlive(grandchildPid)) {
        try { process.kill(grandchildPid); } catch { /* already gone */ }
      }
    }
  });
  it('abortTurn kills only that engine\'s non-detached background shells', async () => {
    const sleeper =
      process.platform === 'win32' ? 'ping -n 10 127.0.0.1' : 'sleep 8';
    const runId = 'bg-shell-abort-test';
    const engine = new ChatEngine({ task: 't', projectRoot: process.cwd(), runId });
    const job = startBackgroundShell({
      command: sleeper,
      cwd: process.cwd(),
      timeoutMs: 60_000,
      ownerId: runId,
    });
    const other = startBackgroundShell({
      command: sleeper,
      cwd: process.cwd(),
      timeoutMs: 60_000,
      ownerId: 'some-other-engine',
    });
    engine.abortTurn();
    const result = await awaitBackgroundShell(job.id, 5_000);
    assert.equal(result.status, 'killed');
    assert.match(result.stderr, /Killed by turn cancellation/);

    const otherSnap = await awaitBackgroundShell(other.id, 200);
    assert.equal(otherSnap.status, 'running');
    killBackgroundShell(other.id);
  });

  it('clearBackgroundShellRegistry kills running jobs and resets ids', async () => {
    const sleeper =
      process.platform === 'win32' ? 'ping -n 10 127.0.0.1' : 'sleep 8';
    const job = startBackgroundShell({
      command: sleeper,
      cwd: process.cwd(),
      timeoutMs: 60_000,
    });
    clearBackgroundShellRegistry();
    const missing = await awaitBackgroundShell(job.id, 100);
    assert.match(missing.stderr, /Unknown background task_id/);
    const next = startBackgroundShell({ command: 'echo next', cwd: process.cwd() });
    assert.equal(next.id, 'bg-1');
  });

  it('capObservationText truncates long output for LLM context', () => {
    const long = 'x'.repeat(40_000);
    const capped = capObservationText(long, 100);
    assert.ok(capped.length < long.length);
    assert.match(capped, /truncated/);
    assert.equal(capObservationText('short', 100), 'short');
  });

  it('getSafeEnv strips typical secret keys from child env allowlist', () => {
    const safe = getSafeEnv({
      PATH: '/usr/bin',
      HOME: '/tmp',
      OPENAI_API_KEY: 'api-key-fixture',
      DEEPSEEK_API_KEY: 'ds-secret',
      BABEL_ROOT: '/proj',
      BABEL_MY_SECRET: 'nope',
    } as NodeJS.ProcessEnv);
    assert.equal(safe['PATH'], '/usr/bin');
    assert.equal(safe['BABEL_ROOT'], '/proj');
    assert.equal(safe['OPENAI_API_KEY'], undefined);
    assert.equal(safe['DEEPSEEK_API_KEY'], undefined);
    assert.equal(safe['BABEL_MY_SECRET'], undefined);
  });
});
