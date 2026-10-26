/**
 * QUALIFYING process-tree termination fixture (F6).
 *
 * Launches a real child that launches a descendant which attempts a delayed
 * filesystem write. Parent cancellation / timeout uses Babel's production
 * terminateChildTree path (backgroundShell → sandbox.terminateChildTree).
 * After waiting past the delayed-write time, the marker file must not exist.
 *
 * Portable across Windows and Linux: the same node child→grandchild delayed
 * write is launched, then terminateChildTree must prevent the late write.
 */

import assert from 'node:assert/strict';
import childProcess, { type ChildProcess, type SpawnSyncOptions } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  awaitBackgroundShell,
  killAllBackgroundShells,
  killBackgroundShell,
  resetBackgroundShellRegistryForTests,
  startBackgroundShell,
  type BackgroundShellJob,
} from './backgroundShell.js';
import { ChatEngine } from './chatEngine.js';
import { terminateChildTree } from '../processTree.js';

const DELAY_WRITE_MS = 2_500;
const POST_KILL_WAIT_MS = DELAY_WRITE_MS + 1_200;

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function waitUntilDead(pid: number, timeoutMs = 5_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isProcessAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !isProcessAlive(pid);
}

const OWNERSHIP_READY_RE = /OWNERSHIP_READY\t(\d+)/;

function readOwnedPidsOrThrow(ownershipPath: string): { parent?: number; grandchild?: number } {
  const raw = readFileSync(ownershipPath, 'utf8').trim();
  if (raw.length === 0) {
    throw new Error(`${ownershipPath}: ownership file empty (never atomically published)`);
  }
  try {
    return JSON.parse(raw) as { parent?: number; grandchild?: number };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`${ownershipPath}: malformed ownership JSON: ${message}`, { cause: err });
  }
}

/** Wait until the parent publishes ownership atomically and signals readiness on stdout. */
async function waitForOwnershipReady(
  jobId: string,
  ownershipPath: string,
  timeoutMs = 8_000,
): Promise<number> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const snap = await awaitBackgroundShell(jobId, 50);
    const match = snap.stdout.match(OWNERSHIP_READY_RE);
    if (match) {
      const grandchildPid = Number(match[1]);
      assert.ok(Number.isSafeInteger(grandchildPid) && grandchildPid > 0);
      const pids = readOwnedPidsOrThrow(ownershipPath);
      assert.equal(pids.grandchild, grandchildPid, 'handshake pid must match atomically published ownership');
      return grandchildPid;
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`Timed out waiting for ownership ready handshake for ${jobId}`);
}

async function withOwnedFixtureTeardown<T>(
  dir: string,
  jobRef: { job?: BackgroundShellJob },
  run: () => Promise<T>,
): Promise<T> {
  let primary: unknown;
  let cleanupError: unknown;
  try {
    return await run();
  } catch (err) {
    primary = err;
  } finally {
    try {
      await cleanupOwnedTree(dir, jobRef.job);
      rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    } catch (err) {
      cleanupError = err;
    }
    if (primary !== undefined) {
      throw primary;
    }
    if (cleanupError !== undefined) {
      throw cleanupError;
    }
  }
  throw new Error('withOwnedFixtureTeardown: unreachable');
}

function writeTreeScripts(dir: string, markerPath: string): { parent: string; grandchild: string } {
  const grandchild = join(dir, 'grandchild.js');
  const parent = join(dir, 'parent.js');
  writeFileSync(
    grandchild,
    [
      "const fs = require('fs');",
      `const marker = ${JSON.stringify(markerPath)};`,
      `setTimeout(() => { try { fs.writeFileSync(marker, 'late-write'); } catch (e) {} }, ${DELAY_WRITE_MS});`,
      'setInterval(() => {}, 1000);',
    ].join('\n'),
    'utf8',
  );
  const ownershipPath = join(dir, 'owned-pids.json');
  const ownershipTmpPath = join(dir, 'owned-pids.json.tmp');
  writeFileSync(
    parent,
    [
      "const cp = require('child_process');",
      "const fs = require('fs');",
      `const ownership = ${JSON.stringify(ownershipPath)};`,
      `const ownershipTmp = ${JSON.stringify(ownershipTmpPath)};`,
      'function publishOwnership(record) {',
      '  fs.writeFileSync(ownershipTmp, JSON.stringify(record));',
      '  fs.renameSync(ownershipTmp, ownership);',
      '}',
      'const gc = cp.spawn(process.execPath, [process.argv[2]], { stdio: "ignore", windowsHide: true });',
      'if (!gc.pid) process.exit(1);',
      'publishOwnership({ parent: process.pid, grandchild: gc.pid });',
      "process.stdout.write('OWNERSHIP_READY\\t' + String(gc.pid) + '\\n');",
      'setInterval(() => {}, 1000);',
    ].join('\n'),
    'utf8',
  );
  return { parent, grandchild };
}

async function cleanupOwnedTree(dir: string, job?: BackgroundShellJob): Promise<void> {
  const ownership = join(dir, 'owned-pids.json');
  if (existsSync(ownership)) {
    const pids = readOwnedPidsOrThrow(ownership);
    // Fixture-owned PIDs only; never touch user processes outside this record.
    for (const pid of [pids.parent, pids.grandchild]) {
      if (!Number.isSafeInteger(pid) || !pid || pid <= 0) continue;
      try { process.kill(pid, 'SIGKILL'); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    }
  }
  if (job) await waitForOwnedClose(job.done);
}

async function waitForOwnedClose(closed: Promise<void>): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([closed, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('owned process did not close after fixture cleanup')), 5_000);
    })]);
  } finally { clearTimeout(timer); }
}

describe('real process-tree termination (qualifying)', () => {
  beforeEach(() => {
    resetBackgroundShellRegistryForTests();
  });
  afterEach(() => {
    resetBackgroundShellRegistryForTests();
  });

  it('timeout kills descendant; delayed write does not appear', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'babel-ptree-timeout-'));
    const marker = join(dir, 'post-terminal.txt');
    const ownership = join(dir, 'owned-pids.json');
    const scripts = writeTreeScripts(dir, marker);
    const jobRef: { job?: BackgroundShellJob } = {};
    await withOwnedFixtureTeardown(dir, jobRef, async () => {
      jobRef.job = startBackgroundShell({
        command: `node ${scripts.parent} ${scripts.grandchild}`,
        cwd: dir,
        timeoutMs: 400,
      });
      const grandchildPid = await waitForOwnershipReady(jobRef.job.id, ownership);
      const result = await awaitBackgroundShell(jobRef.job.id, 8_000);
      assert.equal(result.status, 'killed');
      assert.ok(await waitUntilDead(grandchildPid), 'grandchild should die after tree kill');
      await new Promise((resolve) => setTimeout(resolve, POST_KILL_WAIT_MS));
      assert.equal(
        existsSync(marker),
        false,
        'descendant must not write after Babel terminated the process tree',
      );
    });
  });

  it('cancellation DURING execution kills descendant; delayed write does not appear', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'babel-ptree-cancel-'));
    const marker = join(dir, 'post-terminal.txt');
    const scripts = writeTreeScripts(dir, marker);
    const runId = `ptree-${Date.now()}`;
    const engine = new ChatEngine({
      task: 't',
      projectRoot: dir,
      runId,
    });
    const ownership = join(dir, 'owned-pids.json');
    const jobRef: { job?: BackgroundShellJob } = {};
    await withOwnedFixtureTeardown(dir, jobRef, async () => {
      jobRef.job = startBackgroundShell({
        command: `node ${scripts.parent} ${scripts.grandchild}`,
        cwd: dir,
        timeoutMs: 60_000,
        ownerId: runId,
      });
      const grandchildPid = await waitForOwnershipReady(jobRef.job.id, ownership);
      assert.ok(isProcessAlive(grandchildPid), 'grandchild should be running before cancel');
      // Cancel while the tree is live — not an already-aborted signal.
      engine.abortTurn();
      await awaitBackgroundShell(jobRef.job.id, 8_000);
      assert.ok(await waitUntilDead(grandchildPid), 'grandchild should die after abortTurn tree kill');
      await new Promise((resolve) => setTimeout(resolve, POST_KILL_WAIT_MS));
      assert.equal(
        existsSync(marker),
        false,
        'descendant must not write after abortTurn terminated the process tree',
      );
      killAllBackgroundShells({ ownerId: runId, includeDetached: true });
    });
  });

  it('explicit killBackgroundShell prevents delayed descendant write', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'babel-ptree-kill-'));
    const marker = join(dir, 'post-terminal.txt');
    const scripts = writeTreeScripts(dir, marker);
    const ownership = join(dir, 'owned-pids.json');
    const jobRef: { job?: BackgroundShellJob } = {};
    await withOwnedFixtureTeardown(dir, jobRef, async () => {
      jobRef.job = startBackgroundShell({
        command: `node ${scripts.parent} ${scripts.grandchild}`,
        cwd: dir,
        timeoutMs: 60_000,
      });
      const grandchildPid = await waitForOwnershipReady(jobRef.job.id, ownership);
      killBackgroundShell(jobRef.job.id);
      await awaitBackgroundShell(jobRef.job.id, 8_000);
      assert.ok(await waitUntilDead(grandchildPid));
      await new Promise((resolve) => setTimeout(resolve, POST_KILL_WAIT_MS));
      assert.equal(existsSync(marker), false);
    });
  });

});

describe('Windows tree termination failure handling', () => {
  it('bounds persistent helper failures, stops after success, and does not retry an exited root', () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const originalSpawnSync = childProcess.spawnSync;
    try {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      for (const scenario of [
        { status: 0, exitCode: null, wantAttempts: 1 },
        { status: 1, exitCode: null, wantAttempts: 2 },
        { status: null, exitCode: null, wantAttempts: 2 },
        { status: 1, exitCode: 0, wantAttempts: 0 },
      ]) {
        let attempts = 0;
        let directKills = 0;
        childProcess.spawnSync = ((_file: string, _args: readonly string[], options?: SpawnSyncOptions) => {
          attempts++;
          assert.equal(options!.timeout, 1_500, 'each helper retains its startup/execution bound');
          assert.ok(attempts <= 2, 'persistent failure must never launch a third helper');
          return { status: scenario.status, pid: 100, signal: null, output: [null, null, null], stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
        }) as unknown as typeof childProcess.spawnSync;
        syncBuiltinESMExports();
        terminateChildTree({ pid: 12345, exitCode: scenario.exitCode, signalCode: null,
          kill: () => { directKills++; return true; } } as ChildProcess);
        assert.equal(attempts, scenario.wantAttempts);
        assert.equal(directKills, 1, 'existing direct-child fallback remains bounded');
      }
    } finally {
      childProcess.spawnSync = originalSpawnSync;
      Object.defineProperty(process, 'platform', originalPlatform);
      syncBuiltinESMExports();
    }
  });

  it('retries a transient taskkill timeout before severing the owned root ancestry', () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const originalSpawnSync = childProcess.spawnSync;
    let rootAlive = true;
    let descendantAlive = true;
    let attempts = 0;
    try {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      childProcess.spawnSync = (() => {
        attempts++;
        const result = { pid: 100, signal: null, output: [null, null, null], stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
        if (attempts === 1) return { ...result, status: null, error: Object.assign(new Error('controlled timeout'), { code: 'ETIMEDOUT' }) };
        if (rootAlive) descendantAlive = false;
        return { ...result, status: 0 };
      }) as unknown as typeof childProcess.spawnSync;
      syncBuiltinESMExports();
      terminateChildTree({ pid: 12345, kill: () => { rootAlive = false; return true; } } as ChildProcess);
      assert.equal(descendantAlive, false, 'retry must retain the ancestry needed to terminate descendants');
    } finally {
      childProcess.spawnSync = originalSpawnSync;
      Object.defineProperty(process, 'platform', originalPlatform);
      syncBuiltinESMExports();
    }
  });
});

it('fixture cleanup releases an owned interval parent after a failed tree kill', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'babel-ptree-cleanup-'));
  const ownership = join(dir, 'owned-pids.json');
  const scripts = writeTreeScripts(dir, join(dir, 'marker.txt'));
  const parent = childProcess.spawn(process.execPath, [scripts.parent, scripts.grandchild], { stdio: 'pipe', windowsHide: true });
  const closed = new Promise<void>(resolve => parent.once('close', () => resolve()));
  parent.stderr.resume();
  try {
    let timer: NodeJS.Timeout | undefined;
    let onData: (chunk: Buffer | string) => void = () => {};
    let onError: (error: Error) => void = () => {};
    try {
      await new Promise<void>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('owned parent handshake timed out')), 8_000);
        onData = (chunk) => {
          if (OWNERSHIP_READY_RE.test(String(chunk))) resolve();
        };
        onError = reject;
        parent.stdout.on('data', onData);
        parent.once('error', onError);
      });
      readOwnedPidsOrThrow(ownership);
    } finally {
      clearTimeout(timer);
      parent.stdout.off('data', onData);
      parent.off('error', onError);
    }
    await cleanupOwnedTree(dir);
    assert.equal(await waitUntilDead(parent.pid!), true, 'cleanup must terminate the interval parent that retains inherited pipes');
  } finally {
    await cleanupOwnedTree(dir);
    parent.kill('SIGKILL');
    await waitForOwnedClose(closed);
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});
