import assert from 'node:assert/strict';
import { existsSync, writeFileSync, mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { describe, it, beforeEach, afterEach } from 'node:test';

import {
  awaitBackgroundShell,
  capObservationText,
  clearBackgroundShellRegistry,
  getBackgroundShellJob,
  hasConfirmedBackgroundProcessTreeSettlement,
  hasUnsettledBackgroundShells,
  killAllBackgroundShells,
  killBackgroundShell,
  resetBackgroundShellRegistryForTests,
  startBackgroundShell,
} from './backgroundShell.js';
import { getSafeEnv } from '../utils/safeEnv.js';
import { ChatEngine } from './chatEngine.js';
import type { ProcessWitness } from '../diagnostics/bdns/processWitness.js';

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    if (process.platform === 'linux') {
      // A killed process can remain as a zombie when the container's PID 1
      // does not reap it. Zombies cannot execute; check every remaining task
      // so a zombie leader with a live worker is still considered alive.
      const state = (path: string): string | null => {
        try {
          const stat = readFileSync(path, 'utf8');
          const closeParen = stat.lastIndexOf(')');
          return closeParen < 0 ? null : stat.slice(closeParen + 2).trim().split(/\s+/)[0] ?? null;
        } catch { return null; }
      };
      const rootState = state(`/proc/${pid}/stat`);
      if (rootState === 'Z' || rootState === 'X' || rootState === 'x') {
        try {
          const tasks = readdirSync(`/proc/${pid}/task`).filter(value => /^\d+$/.test(value));
          if (tasks.length > 0 && tasks.every(tid => {
            const taskState = state(`/proc/${pid}/task/${tid}/stat`);
            return taskState === 'Z' || taskState === 'X' || taskState === 'x';
          })) return false;
        } catch { /* inaccessible or changing proc data fails closed */ }
      }
    }
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
  it('requires process-tree evidence before reporting a completed background process', () => {
    assert.equal(hasConfirmedBackgroundProcessTreeSettlement('linux', true, false), true);
    assert.equal(hasConfirmedBackgroundProcessTreeSettlement('win32', true, false), false,
      'Windows direct-child close is not a process-tree settlement proof');
    assert.equal(hasConfirmedBackgroundProcessTreeSettlement('linux', true, true), false,
      'uncertain tree termination remains incomplete');
    assert.equal(hasConfirmedBackgroundProcessTreeSettlement('linux', false, false), false);
  });
  beforeEach(() => {
    resetBackgroundShellRegistryForTests();
  });

  afterEach(() => {
    resetBackgroundShellRegistryForTests();
  });

  it('starts a command and returns a task id immediately', async () => {
    // Simple argv (no quotes) — same tokenizer contract as sandbox shellExec.
    const job = startBackgroundShell({
      command: `node -e "console.log('hello-bg')"`,
      cwd: process.cwd(),
    });
    assert.ok(job.id.startsWith('bg-'));
    assert.equal(job.status, 'running');

    const result = await awaitBackgroundShell(job.id, 15_000);
    assert.equal(result.timed_out, false);
    assert.equal(result.exit_code, process.platform === 'win32' ? 1 : 0, result.stderr);
    assert.match(result.stdout, /hello-bg/);
    assert.equal(result.status, process.platform === 'win32' ? 'failed' : 'completed');
  });

  it('pins a trusted bare command to the resolved executable path', async () => {
    let witnessedExecutable = '';
    const processWitness = {
      requested: (input: { executable: string }) => {
        witnessedExecutable = input.executable;
        return 'test-execution';
      },
      started: () => {},
      failedToStart: () => {},
      exited: () => {},
    } as unknown as ProcessWitness;
    const job = startBackgroundShell({
      command: 'node -e "process.stdout.write(\'pinned\')"',
      cwd: process.cwd(),
      processWitness,
    });
    assert.notEqual(witnessedExecutable, 'node');
    if (process.platform === 'win32') {
      assert.match(witnessedExecutable, /[\\/]System32[\\/]cmd\.exe$/i, witnessedExecutable);
    } else {
      assert.ok(witnessedExecutable.startsWith('/'), witnessedExecutable);
    }
    const result = await awaitBackgroundShell(job.id, 15_000);
    assert.equal(result.exit_code, process.platform === 'win32' ? 1 : 0, result.stderr);
    assert.equal(result.stdout, 'pinned');
  });

  it('passes quoted arguments as one argv item', async () => {
    const script = join(mkdtempSync(join(tmpdir(), 'babel-bg-')), 'argv.mjs');
    writeFileSync(script, 'process.stdout.write(process.argv[2] ?? "missing")', 'utf8');
    const job = startBackgroundShell({
      command: `node "${script}" "value with spaces"`,
      cwd: process.cwd(),
    });
    const result = await awaitBackgroundShell(job.id, 15_000);
    assert.equal(result.exit_code, process.platform === 'win32' ? 1 : 0, result.stderr);
    assert.equal(result.stdout, 'value with spaces');
  });

  it('await reports timed_out without killing a still-running job', async () => {
    // Use a portable long-lived process to observe the nonterminal timeout.
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

  it('clears stale POSIX tree uncertainty after close confirms the group has settled', {
    skip: process.platform === 'win32' ? 'POSIX process-group cleanup is not available on Windows' : false,
  }, async (t) => {
    const originalKill = process.kill.bind(process);
    t.mock.method(process, 'kill', ((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid < 0) {
        const error = Object.assign(new Error('process group already exited'), { code: 'ESRCH' });
        throw error;
      }
      return originalKill(pid, signal);
    }) as typeof process.kill);

    const job = startBackgroundShell({ command: 'sleep 8', cwd: process.cwd(), timeoutMs: 60_000 });
    const killed = killBackgroundShell(job.id);
    assert.equal(killed.status, 'killed');
    assert.equal(getBackgroundShellJob(job.id)?.processCompleted, false,
      'a failed group signal is uncertain until the close handler confirms settlement');

    const result = await awaitBackgroundShell(job.id, 5_000);
    assert.equal(result.status, 'killed');
    assert.equal(getBackgroundShellJob(job.id)?.processCompleted, true,
      'a complete POSIX group observation clears stale uncertainty');
    assert.equal(hasUnsettledBackgroundShells(job.ownerId), false);
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

  it('preserves cancellation that arrives while close waits for POSIX tree settlement', {
    skip: process.platform === 'win32' ? 'POSIX process-group cleanup is not available on Windows' : false,
  }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bg-shell-cancel-during-settlement-'));
    const grandchildScript = join(dir, 'grandchild.js');
    const parentScript = join(dir, 'parent.js');
    writeFileSync(grandchildScript, 'setTimeout(()=>{},60000);\n');
    writeFileSync(parentScript, [
      "const cp=require('child_process');",
      'const child=cp.spawn(process.execPath,[process.argv[2]],{stdio:"ignore"});',
      'child.unref();',
      'console.log(String(child.pid));',
      'process.exit(0);',
    ].join(''));
    const ownerId = 'cancel-during-initial-settlement';
    let grandchildPid: number | undefined;
    try {
      const job = startBackgroundShell({
        command: `node ${parentScript} ${grandchildScript}`,
        cwd: dir,
        ownerId,
        timeoutMs: 10_000,
      });
      const directChild = (job as unknown as { child?: import('node:child_process').ChildProcess }).child;
      assert.ok(directChild, 'the fixture has an owned direct child');
      const directClose = new Promise<void>(resolveClose => directChild.once('close', () => resolveClose()));
      grandchildPid = await waitForStdoutPid(job.id);
      await directClose;
      assert.equal(job.status, 'running', 'the close handler is still waiting on the live descendant');
      assert.equal(hasUnsettledBackgroundShells(ownerId), true);
      assert.equal(killBackgroundShell(job.id).status, 'killed');
      await job.done;
      const result = await awaitBackgroundShell(job.id, 1_000);
      assert.equal(result.status, 'killed', 'the later cancellation cause survives the earlier close snapshot');
      assert.equal(getBackgroundShellJob(job.id)?.processCompleted, true,
        'the cancellation cause does not prevent independently confirmed tree settlement');
      assert.ok(grandchildPid !== undefined && await waitUntilDead(grandchildPid),
        'the descendant is stopped before the owner fence is released');
      assert.equal(hasUnsettledBackgroundShells(ownerId), false);
    } finally {
      if (grandchildPid !== undefined && isProcessAlive(grandchildPid)) {
        try { process.kill(grandchildPid); } catch { /* already gone */ }
      }
      rmSync(dir, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
    }
  });

  it('preserves cancellation while automatic tree cleanup is waiting for settlement', {
    skip: process.platform === 'win32' ? 'POSIX process-group cleanup is not available on Windows' : false,
  }, async t => {
    const dir = mkdtempSync(join(tmpdir(), 'bg-shell-cancel-during-cleanup-'));
    const readyMarker = join(dir, 'handler-ready');
    const signalMarker = join(dir, 'term-received');
    const grandchildScript = join(dir, 'grandchild.js');
    const parentScript = join(dir, 'parent.js');
    writeFileSync(grandchildScript, [
      "require('fs').writeFileSync(process.argv[2],'ready');",
      "process.on('SIGTERM',()=>{require('fs').writeFileSync(process.argv[3],'yes');setTimeout(()=>process.exit(0),250)});",
      'setTimeout(()=>{},60000);',
    ].join(''));
    writeFileSync(parentScript, [
      "const cp=require('child_process');",
      "const fs=require('fs');",
      'const child=cp.spawn(process.execPath,[process.argv[2],process.argv[3],process.argv[4]],{stdio:"ignore"});',
      'child.unref();',
      'console.log(String(child.pid));',
      'const wait=()=>fs.existsSync(process.argv[3])?process.exit(0):setTimeout(wait,10);wait();',
    ].join(''));
    const ownerId = 'cancel-during-auto-settlement';
    const originalKill = process.kill.bind(process);
    t.mock.method(process, 'kill', ((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid < 0 && signal === 'SIGKILL') {
        // Keep the fixture alive briefly after automatic cleanup starts so the
        // test can record cancellation during the second settlement wait.
        return originalKill(pid, 'SIGTERM');
      }
      return originalKill(pid, signal);
    }) as typeof process.kill);
    let grandchildPid: number | undefined;
    try {
      const job = startBackgroundShell({
        command: `node ${parentScript} ${grandchildScript} ${readyMarker} ${signalMarker}`,
        cwd: dir,
        ownerId,
        timeoutMs: 10_000,
      });
      const directChild = (job as unknown as { child?: import('node:child_process').ChildProcess }).child;
      assert.ok(directChild);
      const directClose = new Promise<void>(resolveClose => directChild.once('close', () => resolveClose()));
      grandchildPid = await waitForStdoutPid(job.id);
      await directClose;
      const signalDeadline = Date.now() + 3_000;
      while (!existsSync(signalMarker) && Date.now() < signalDeadline) {
        await new Promise(resolveDelay => setTimeout(resolveDelay, 10));
      }
      assert.equal(existsSync(signalMarker), true,
        `automatic cleanup has entered its settlement wait: ${JSON.stringify(getBackgroundShellJob(job.id))}`);
      assert.equal(job.status, 'running');
      assert.equal(hasUnsettledBackgroundShells(ownerId), true);
      assert.equal(killBackgroundShell(job.id).status, 'killed');
      await job.done;
      const result = await awaitBackgroundShell(job.id, 1_000);
      assert.equal(result.status, 'killed', 'cancellation survives confirmed automatic cleanup');
      assert.match(result.stderr, /descendants remained .* terminated/i,
        'the cleanup outcome remains visible alongside cancellation');
      assert.equal(getBackgroundShellJob(job.id)?.processCompleted, true);
      assert.equal(hasUnsettledBackgroundShells(ownerId), false,
        'the owner fence opens only after the cleanup wait confirms settlement');
      assert.ok(grandchildPid !== undefined && await waitUntilDead(grandchildPid));
    } finally {
      if (grandchildPid !== undefined && isProcessAlive(grandchildPid)) {
        try { process.kill(grandchildPid); } catch { /* already gone */ }
      }
      rmSync(dir, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
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

  it('does not release await_command while an unrefed descendant can still write', {
    skip: process.platform === 'win32' ? 'POSIX process-group cleanup is not available on Windows' : false,
  }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bg-shell-close-descendant-'));
    const marker = join(dir, 'late-write');
    const grandchildScript = join(dir, 'grandchild.js');
    const parentScript = join(dir, 'parent.js');
    writeFileSync(grandchildScript, `setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(marker)},'late'),700);\n`);
    writeFileSync(parentScript, [
      "const cp=require('child_process');",
      'const child=cp.spawn(process.execPath,[process.argv[2]],{stdio:"ignore"});',
      'child.unref();',
      'process.exit(0);',
    ].join(''));
    const job = startBackgroundShell({
      command: `node ${parentScript} ${grandchildScript}`,
      cwd: process.cwd(),
      timeoutMs: 5_000,
    });
    const result = await awaitBackgroundShell(job.id, 5_000);
    assert.equal(result.status, 'failed', 'remaining descendants are reported instead of a false successful completion');
    assert.equal(result.exit_code, 1);
    assert.match(result.stderr, /descendants remained .* terminated/i);
    assert.equal(getBackgroundShellJob(job.id)?.processCompleted, true, 'process-tree cleanup is confirmed before the await settles');
    await new Promise(resolve => setTimeout(resolve, 900));
    const { existsSync } = await import('node:fs');
    assert.equal(existsSync(marker), false, 'the child cannot perform delayed work after await_command returns');
  });

  it('does not certify Windows parent close as process-tree settlement', {
    skip: process.platform !== 'win32' ? 'Windows-only process-tree termination contract' : false,
  }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bg-shell-windows-descendant-'));
    const marker = join(dir, 'late-write');
    const pidFile = join(dir, 'descendant.pid');
    const grandchildScript = join(dir, 'grandchild.js');
    const parentScript = join(dir, 'parent.js');
    writeFileSync(grandchildScript, [
      "require('fs').writeFileSync(process.argv[2], String(process.pid));",
      `setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(marker)},'late'),1200);`,
    ].join(''));
    writeFileSync(parentScript, [
      "const cp=require('child_process');",
      'const child=cp.spawn(process.execPath,[process.argv[2],process.argv[3]],{stdio:"ignore"});',
      'child.unref();',
      'child.once("spawn",()=>setTimeout(()=>{process.exitCode=7},100));',
      'process.stderr.write("EACCES: access denied\\n");',
    ].join(''));
    let descendantPid: number | undefined;
    try {
      const job = startBackgroundShell({
        command: `node "${parentScript}" "${grandchildScript}" "${pidFile}"`,
        cwd: dir,
        timeoutMs: 10_000,
      ownerId: 'windows-tree-proof-test',
      });
      const result = await awaitBackgroundShell(job.id, 5_000);
      assert.equal(result.status, 'failed');
      assert.ok(existsSync(pidFile), 'unrefed descendant started');
      descendantPid = Number(readFileSync(pidFile, 'utf8'));
      assert.ok(Number.isInteger(descendantPid) && descendantPid > 0);
      assert.equal(getBackgroundShellJob(job.id)?.processCompleted, false,
        'Windows direct-child close cannot certify descendant settlement');
      assert.equal(hasUnsettledBackgroundShells(job.ownerId), true,
        'the owner fence stays closed while descendant settlement is unproven');
      await new Promise(resolve => setTimeout(resolve, 1500));
      assert.equal(existsSync(marker), true,
        'the fixture demonstrates that a descendant can continue after the parent closes');
    } finally {
      if (descendantPid) {
        const windowsRoot = process.env['SystemRoot'] || process.env['WINDIR'] || 'C:\\Windows';
        childProcess.spawnSync(join(windowsRoot, 'System32', 'taskkill.exe'),
          ['/F', '/T', '/PID', String(descendantPid)], { stdio: 'ignore', windowsHide: true, timeout: 5000 });
      }
      rmSync(dir, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
    }
  });

  it('preserves a recorded Windows cancellation while settlement remains unknown', {
    skip: process.platform !== 'win32' ? 'Windows-only process-tree termination contract' : false,
  }, async () => {
    const ownerId = 'windows-cancel-unsettled-test';
    const job = startBackgroundShell({
      command: 'node -e "console.log(process.pid);setInterval(()=>{},1000)"',
      cwd: process.cwd(),
      ownerId,
      timeoutMs: 30_000,
    });
    try {
      await waitForStdoutPid(job.id);
      assert.equal(killBackgroundShell(job.id).status, 'killed');
      const result = await awaitBackgroundShell(job.id, 5_000);
      assert.equal(result.status, 'killed', 'the recorded cancellation cause remains visible');
      assert.match(result.stderr, /process-tree termination could not be confirmed/i);
      assert.equal(getBackgroundShellJob(job.id)?.processCompleted, false,
        'a killed status does not certify process-tree settlement');
      assert.equal(hasUnsettledBackgroundShells(ownerId), true,
        'the owner fence remains closed while settlement is unknown');
    } finally {
      clearBackgroundShellRegistry(ownerId);
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
    const engine = new ChatEngine({ model: 'deepseek-v4-flash-openrouter', task: 't', projectRoot: process.cwd(), runId });
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
    const engine = new ChatEngine({ model: 'deepseek-v4-flash-openrouter', task: 't', projectRoot: process.cwd(), runId });
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
    const next = startBackgroundShell({ command: `node -e "console.log('next')"`, cwd: process.cwd() });
    assert.equal(next.id, 'bg-1');
  });

  it('retains owner uncertainty when the Windows tree-kill helper fails', { skip: process.platform !== 'win32' ? 'Windows-only process-tree termination contract' : false }, async t => {
    const owner = 'synthetic-unsettled-background';
    const root = mkdtempSync(join(tmpdir(), 'babel-background-uncertain-'));
    const script = join(root, 'hold.js');
    writeFileSync(script, 'console.log(process.pid);setTimeout(function(){},8000);\n');
    const job = startBackgroundShell({
      command: `node "${script}"`,
      cwd: root, ownerId: owner, timeoutMs: 15000,
    });
    await waitForStdoutPid(job.id);
    assert.equal(hasUnsettledBackgroundShells(owner), true);
    assert.equal(hasUnsettledBackgroundShells('other-owner'), false);
    t.mock.method(childProcess, 'spawnSync', (() => ({ status: 1, error: undefined })) as unknown as typeof childProcess.spawnSync);
    syncBuiltinESMExports();
    try {
      killBackgroundShell(job.id);
      await job.done;
      assert.equal(hasUnsettledBackgroundShells(owner), true, 'a parent exit cannot prove the failed tree kill settled descendants');
      assert.equal(getBackgroundShellJob(job.id)?.processCompleted, false, 'direct-child close does not certify completion while tree termination is unknown');
    } finally {
      t.mock.restoreAll(); syncBuiltinESMExports();
      rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
    }
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
