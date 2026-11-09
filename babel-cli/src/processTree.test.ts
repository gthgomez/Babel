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
import { execFileSync, spawn } from 'node:child_process';
import { describe, it } from 'node:test';

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  isProcessAlive,
  isProcessGroupAlive,
  isLinuxProcessGroupAliveInProc,
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

function writeSyntheticProcTask(procRoot: string, pid: number, processGroup: number, state: string): void {
  const taskDir = join(procRoot, String(pid), 'task', String(pid));
  mkdirSync(taskDir, { recursive: true });
  const stat = `${pid} (fixture) ${state} 1 ${processGroup} ${processGroup} 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0`;
  writeFileSync(join(procRoot, String(pid), 'stat'), stat);
  writeFileSync(join(taskDir, 'stat'), stat);
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

type LinuxTaskState = { tid: string; state: string };

async function waitForLinuxTaskGroupToStop(pid: number, onSample?: (states: LinuxTaskState[]) => void): Promise<LinuxTaskState[]> {
  const deadline = Date.now() + 3_000;
  let latest: LinuxTaskState[] = [];
  while (Date.now() < deadline) {
    try {
      const taskDir = `/proc/${pid}/task`;
      latest = readdirSync(taskDir).flatMap(tid => {
        try {
          const stat = readFileSync(`${taskDir}/${tid}/stat`, 'utf8');
          return [{ tid, state: stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[0] ?? '' }];
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
          throw error;
        }
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    onSample?.(latest);
    if (latest.length === 0 || latest.every(({ state }) => state === 'Z' || state === 'X' || state === 'x')) return latest;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(`process ${pid} retained runnable threads after group kill (states=${latest.map(({ tid, state }) => `${tid}:${state}`).join(',')})`);
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
  it('retains stability across polling and resets it for changed or incomplete snapshots', async () => {
    const procRoot = mkdtempSync(join(tmpdir(), 'babel-proc-snapshot-'));
    const groupId = 77123;
    try {
      assert.equal(isLinuxProcessGroupAliveInProc(groupId, procRoot), true,
        'first empty snapshot is not enough to certify exit');
      await new Promise(resolve => setTimeout(resolve, 30));
      assert.equal(isLinuxProcessGroupAliveInProc(groupId, procRoot), false,
        'unchanged empty snapshots settle after the stability window');
      assert.equal(isLinuxProcessGroupAliveInProc(groupId, procRoot), false,
        'repeated unchanged empty snapshots remain settled');

      writeSyntheticProcTask(procRoot, groupId, groupId, 'Z');
      assert.equal(isLinuxProcessGroupAliveInProc(groupId, procRoot), true,
        'first all-dead process snapshot starts a new stability window');
      await new Promise(resolve => setTimeout(resolve, 30));
      assert.equal(isLinuxProcessGroupAliveInProc(groupId, procRoot), false,
        'unchanged all-dead snapshots settle');
      assert.equal(isLinuxProcessGroupAliveInProc(groupId, procRoot), false,
        'repeated unchanged all-dead snapshots remain settled');

      writeSyntheticProcTask(procRoot, groupId, groupId, 'S');
      assert.equal(isLinuxProcessGroupAliveInProc(groupId, procRoot), true,
        'a changed live snapshot remains alive and clears the old stability window');
      writeSyntheticProcTask(procRoot, groupId, groupId, 'Z');
      assert.equal(isLinuxProcessGroupAliveInProc(groupId, procRoot), true,
        'a changed all-dead snapshot must begin a fresh window');
      await new Promise(resolve => setTimeout(resolve, 30));
      assert.equal(isLinuxProcessGroupAliveInProc(groupId, procRoot), false,
        'the fresh unchanged snapshot window eventually settles');

      const incompleteRoot = mkdtempSync(join(tmpdir(), 'babel-proc-incomplete-'));
      try {
        mkdirSync(join(incompleteRoot, String(groupId)), { recursive: true });
        assert.equal(isLinuxProcessGroupAliveInProc(groupId, incompleteRoot), true,
          'a numeric proc entry whose stat disappears is incomplete');
        await new Promise(resolve => setTimeout(resolve, 30));
        assert.equal(isLinuxProcessGroupAliveInProc(groupId, incompleteRoot), true,
          'repeated incomplete scans never certify exit');
      } finally {
        rmSync(incompleteRoot, { recursive: true, force: true });
      }
    } finally {
      rmSync(procRoot, { recursive: true, force: true });
    }
  });

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
    if (process.platform === 'linux') {
      assert.equal(isProcessGroupAlive(pid), true, 'initial live snapshot must block settlement');
      await new Promise(resolve => setTimeout(resolve, 25));
      assert.equal(isProcessGroupAlive(pid), true, 'unchanged live snapshots remain unsettled');
    }
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
    if (process.platform === 'linux' && isProcessAlive(childPid)) {
      await waitForLinuxTaskGroupToStop(childPid);
      assert.equal(await waitForProcessGroupExit(leaderPid, 1000), true,
        'stable all-thread dead snapshots settle the killed descendant');
    } else {
      await waitUntilDead(childPid);
    }
  });

  it('keeps a Linux zombie leader with a live worker thread blocking group settlement', async (t) => {
    if (process.platform !== 'linux') {
      t.skip('Linux procfs zombie-state qualification');
      return;
    }
    const root = mkdtempSync(join(tmpdir(), 'babel-pgid-zombie-'));
    const statePath = join(root, 'state.json');
    const sourcePath = join(root, 'leader.c');
    const binaryPath = join(root, 'leader');
    const gccAvailable = (() => {
      try { execFileSync('gcc', ['--version'], { stdio: 'ignore' }); return true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
    })();
    if (!gccAvailable) {
      t.skip('gcc required for the multithreaded zombie-leader fixture');
      return;
    }
    writeFileSync(sourcePath,
      `#include <pthread.h>\n#include <stdio.h>\n#include <unistd.h>\nvoid *worker(void *unused) { for (;;) sleep(1); return 0; }\nint main(void) { pthread_t thread; if (pthread_create(&thread, 0, worker, 0) != 0) return 2; FILE *state = fopen(${JSON.stringify(statePath)}, "w"); if (!state) return 3; fprintf(state, "%d\\n", getpid()); fclose(state); pthread_exit(0); }\n`);
    execFileSync('gcc', ['-pthread', sourcePath, '-o', binaryPath]);
    const leader = spawn(binaryPath, [], { cwd: root, detached: true, stdio: 'ignore' });
    const leaderPid = leader.pid;
    assert.ok(leaderPid);
    const closed = new Promise<void>(resolve => leader.once('close', () => resolve()));
    try {
      const startDeadline = Date.now() + 3000;
      while (!existsSync(statePath) && Date.now() < startDeadline) await new Promise(resolve => setTimeout(resolve, 10));
      assert.ok(existsSync(statePath), 'native multithreaded fixture did not start');
      const pid = Number(readFileSync(statePath, 'utf8').trim());
      assert.equal(pid, leaderPid);
      const taskDir = `/proc/${pid}/task`;
      const tasks = readdirSync(taskDir).map(tid => {
        const stat = readFileSync(`${taskDir}/${tid}/stat`, 'utf8');
        return { tid: Number(tid), state: stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[0] };
      });
      assert.equal(tasks.find(task => task.tid === pid)?.state, 'Z', 'main thread should have exited via pthread_exit');
      assert.ok(tasks.some(task => task.tid !== pid && task.state !== 'Z' && task.state !== 'X' && task.state !== 'x'),
        `worker must remain live for the negative control: ${JSON.stringify(tasks)}`);
      let rawGroupProbe = 'present';
      try { process.kill(-pid, 0); } catch (error) { rawGroupProbe = (error as NodeJS.ErrnoException).code ?? 'unknown'; }
      assert.equal(isProcessGroupAlive(pid), true,
        `a zombie leader must not hide its live thread-group worker; tasks=${JSON.stringify(tasks)} raw=${rawGroupProbe}`);
      assert.equal(await waitForProcessGroupExit(pid, 100), false, 'live worker keeps termination unsettled');

      terminateChildTree(leader);
      const settled = await Promise.race([
        closed.then(() => true),
        new Promise<boolean>(resolve => setTimeout(() => resolve(false), 3000)),
      ]);
      assert.equal(settled, true, 'SIGKILL must terminate the runnable worker threads');
      assert.equal(await waitForProcessGroupExit(pid, 2000), true,
        'stable complete procfs snapshots settle only after every thread is dead');
    } finally {
      try { process.kill(-leaderPid, 'SIGKILL'); } catch { /* group already settled */ }
      rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 });
    }
  });
});
