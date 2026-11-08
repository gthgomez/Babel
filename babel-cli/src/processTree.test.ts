/**
 * Unit coverage for the process-exit wait added with the trusted review
 * service's finite cleanup timeout (PR #365 follow-up).
 *
 * waitForProcessGroupExit must return quickly once the target is gone: the
 * POSIX path detects group exit via kill(-pgid, 0) ESRCH, and the Windows
 * path must probe the leader directly because libuv rejects negative PIDs
 * with EINVAL there (a group probe can never observe exit and would spin
 * the whole timeout before the fallback).
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { describe, it } from 'node:test';

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  isProcessAlive,
  isProcessGroupAlive,
  terminateChildTree,
  waitForProcessExit,
  waitForProcessGroupExit,
} from './processTree.js';

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function waitUntilDead(pid: number, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(!isAlive(pid), `pid ${pid} did not exit within ${timeoutMs}ms`);
}

/** Long-lived sleeper whose PID is its process-group leader on POSIX. */
function spawnSleeper(): ReturnType<typeof spawn> {
  return process.platform === 'win32'
    ? spawn('cmd.exe', ['/d', '/s', '/c', 'ping -n 30 127.0.0.1 >nul'], { stdio: 'ignore' })
    : spawn('sleep', ['30'], { stdio: 'ignore', detached: true });
}

describe('isProcessAlive', () => {
  it('reports the current process as alive', () => {
    assert.equal(isProcessAlive(process.pid), true);
  });

  it('reports an exited child as not alive', async () => {
    const child = spawnSleeper();
    const pid = child.pid;
    assert.ok(pid);
    terminateChildTree(child);
    await waitUntilDead(pid);
    assert.equal(isProcessAlive(pid), false);
  });
});

describe('waitForProcessExit', () => {
  it('returns true after a terminated child exits', async () => {
    const child = spawnSleeper();
    const pid = child.pid;
    assert.ok(pid);
    terminateChildTree(child);
    const exited = await waitForProcessExit(pid, 10_000);
    assert.equal(exited, true);
    assert.equal(isProcessAlive(pid), false);
  });
});

describe('waitForProcessGroupExit', () => {
  it('returns true immediately for an already-exited leader', async () => {
    const child = spawnSleeper();
    const pid = child.pid;
    assert.ok(pid);
    terminateChildTree(child);
    await waitUntilDead(pid);
    const start = Date.now();
    const exited = await waitForProcessGroupExit(pid, 10_000);
    const elapsed = Date.now() - start;
    assert.equal(exited, true);
    assert.ok(elapsed < 2_000, `should return promptly after exit, took ${elapsed}ms`);
  });

  it('returns false after the timeout while the leader is still running', async () => {
    const child = spawnSleeper();
    const pid = child.pid;
    assert.ok(pid);
    try {
      assert.equal(isAlive(pid), true, 'sleeper should be running');
      const start = Date.now();
      const exited = await waitForProcessGroupExit(pid, 150);
      const elapsed = Date.now() - start;
      assert.equal(exited, false);
      assert.ok(elapsed >= 140, `must honor the timeout, returned after ${elapsed}ms`);
      assert.ok(isAlive(pid), 'timeout wait must not terminate the leader');
    } finally {
      terminateChildTree(child);
      await waitUntilDead(pid);
    }
  });

  it('returns true quickly after the process group is terminated', async () => {
    const child = spawnSleeper();
    const pid = child.pid;
    assert.ok(pid);
    terminateChildTree(child);
    const start = Date.now();
    const exited = await waitForProcessGroupExit(pid, 10_000);
    const elapsed = Date.now() - start;
    assert.equal(exited, true);
    assert.ok(elapsed < 5_000, `group wait must resolve after termination, took ${elapsed}ms`);
  });

  it('returns false when the leader died but a same-group descendant remains (POSIX)', async (t) => {
    if (process.platform === 'win32') {
      t.skip('POSIX process-group semantics only');
      return;
    }
    const root = mkdtempSync(join(tmpdir(), 'babel-pgid-straggler-'));
    const statePath = join(root, 'state.json');
    const leaderScript = join(root, 'leader.mjs');
    writeFileSync(
      leaderScript,
      `import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
writeFileSync(${JSON.stringify(statePath)}, JSON.stringify({ leaderPid: process.pid, childPid: child.pid }));
await new Promise(() => {});
`,
    );
    const leader = spawn(process.execPath, [leaderScript], { detached: true, stdio: 'ignore' });
    const leaderPid = leader.pid;
    assert.ok(leaderPid);
    let childPid = 0;
    for (let i = 0; i < 100; i++) {
      try {
        const state = JSON.parse(readFileSync(statePath, 'utf8')) as { childPid?: number };
        if (state.childPid && state.childPid > 0) {
          childPid = state.childPid;
          break;
        }
      } catch {
        // leader still starting
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(childPid > 0, 'fixture child pid must be recorded');
    assert.equal(isProcessGroupAlive(leaderPid), true);
    process.kill(leaderPid, 'SIGKILL');
    await waitUntilDead(leaderPid);
    assert.equal(isProcessAlive(leaderPid), false);
    assert.equal(isProcessAlive(childPid), true, 'descendant must survive leader-only kill');
    assert.equal(isProcessGroupAlive(leaderPid), true, 'group must still be alive');
    const exited = await waitForProcessGroupExit(leaderPid, 200);
    assert.equal(exited, false, 'must fail closed, not treat dead leader as empty group');
    try {
      process.kill(-leaderPid, 'SIGKILL');
    } catch {
      process.kill(childPid, 'SIGKILL');
    }
    if (process.platform === 'linux') {
      assert.equal(await waitForProcessGroupExit(leaderPid, 2000), true, 'killed descendant must be non-runnable even if PID 1 retains its zombie record');
      try {
        const stat = readFileSync(`/proc/${childPid}/stat`, 'utf8');
        const state = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[0];
        assert.ok(state === 'Z' || state === 'X' || state === 'x', `killed descendant remains runnable (state=${state})`);
      } catch (error) {
        assert.equal((error as NodeJS.ErrnoException).code, 'ENOENT');
      }
    } else {
      await waitUntilDead(childPid);
    }
  });

  it('treats a zombie-only Linux process group as settled but keeps running descendants blocking', async (t) => {
    if (process.platform !== 'linux') {
      t.skip('Linux procfs zombie-state qualification');
      return;
    }
    const root = mkdtempSync(join(tmpdir(), 'babel-pgid-zombie-'));
    const statePath = join(root, 'state.json');
    const childScript = join(root, 'child.mjs');
    const leaderScript = join(root, 'leader.mjs');
    writeFileSync(childScript,
      `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(statePath)}, JSON.stringify({ childPid: process.pid })); setInterval(() => {}, 1000);\n`);
    writeFileSync(leaderScript,
      `import { spawn } from 'node:child_process'; spawn(process.execPath, [${JSON.stringify(childScript)}], { stdio: 'ignore' }); setInterval(() => {}, 1000);\n`);
    const leader = spawn(process.execPath, [leaderScript], { cwd: root, detached: true, stdio: 'ignore' });
    const leaderPid = leader.pid;
    assert.ok(leaderPid);
    try {
      let childPid = 0;
      const startDeadline = Date.now() + 3000;
      while (!existsSync(statePath) && Date.now() < startDeadline) await new Promise(resolve => setTimeout(resolve, 10));
      if (existsSync(statePath)) childPid = Number((JSON.parse(readFileSync(statePath, 'utf8')) as { childPid?: number }).childPid ?? 0);
      assert.ok(childPid > 0, 'same-group descendant must start before termination');
      assert.equal(isProcessGroupAlive(leaderPid), true, 'negative control: a runnable descendant blocks settlement');
      terminateChildTree(leader);
      assert.equal(await waitForProcessGroupExit(leaderPid, 2000), true,
        'a zombie exit record is not runnable work and must not keep termination pending');
      try {
        const stat = readFileSync(`/proc/${childPid}/stat`, 'utf8');
        const state = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[0];
        assert.ok(state === 'Z' || state === 'X' || state === 'x',
          `process-group settlement must not accept a runnable descendant (state=${state})`);
      } catch (error) {
        assert.equal((error as NodeJS.ErrnoException).code, 'ENOENT', 'descendant must be gone or a non-runnable zombie');
      }
    } finally {
      try { process.kill(-leaderPid, 'SIGKILL'); } catch { /* group already settled */ }
      rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 });
    }
  });
});
