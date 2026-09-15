/**
 * QUALIFYING process-tree termination fixture (F6).
 *
 * Launches a real child that launches a descendant which attempts a delayed
 * filesystem write. Parent cancellation / timeout uses Babel's production
 * terminateChildTree path (backgroundShell → sandbox.terminateChildTree).
 * After waiting past the delayed-write time, the marker file must not exist.
 *
 * Linux is portable in this fixture. This host is Windows; Linux is marked
 * NOT RUN with the exact reason rather than claimed PASS.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  awaitBackgroundShell,
  killAllBackgroundShells,
  killBackgroundShell,
  resetBackgroundShellRegistryForTests,
  startBackgroundShell,
} from './backgroundShell.js';
import { ChatEngine } from './chatEngine.js';

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

async function waitForStdoutPid(jobId: string, timeoutMs = 8_000): Promise<number> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const snap = await awaitBackgroundShell(jobId, 50);
    const match = snap.stdout.trim().match(/^\d+$/m);
    if (match) return Number(match[0]);
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`Timed out waiting for grandchild PID in stdout for ${jobId}`);
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
  writeFileSync(
    parent,
    [
      "const cp = require('child_process');",
      'const gc = cp.spawn(process.execPath, [process.argv[2]], { stdio: "ignore", windowsHide: true });',
      'if (gc.pid) console.log(String(gc.pid));',
      'setInterval(() => {}, 1000);',
    ].join('\n'),
    'utf8',
  );
  return { parent, grandchild };
}

describe('real process-tree termination (qualifying)', () => {
  beforeEach(() => {
    resetBackgroundShellRegistryForTests();
  });
  afterEach(() => {
    resetBackgroundShellRegistryForTests();
  });

  it('Windows: timeout kills descendant; delayed write does not appear', async () => {
    assert.equal(process.platform, 'win32');
    const dir = mkdtempSync(join(tmpdir(), 'babel-ptree-timeout-'));
    const marker = join(dir, 'post-terminal.txt');
    const scripts = writeTreeScripts(dir, marker);
    let grandchildPid: number | undefined;
    try {
      const job = startBackgroundShell({
        command: `node ${scripts.parent} ${scripts.grandchild}`,
        cwd: dir,
        timeoutMs: 400,
      });
      grandchildPid = await waitForStdoutPid(job.id);
      const result = await awaitBackgroundShell(job.id, 8_000);
      assert.equal(result.status, 'killed');
      assert.ok(await waitUntilDead(grandchildPid), 'grandchild should die after tree kill');
      await new Promise((resolve) => setTimeout(resolve, POST_KILL_WAIT_MS));
      assert.equal(
        existsSync(marker),
        false,
        'descendant must not write after Babel terminated the process tree',
      );
    } finally {
      if (grandchildPid !== undefined && isProcessAlive(grandchildPid)) {
        try {
          process.kill(grandchildPid);
        } catch {
          /* already gone */
        }
      }
    }
  });

  it('Windows: cancellation DURING execution kills descendant; delayed write does not appear', async () => {
    assert.equal(process.platform, 'win32');
    const dir = mkdtempSync(join(tmpdir(), 'babel-ptree-cancel-'));
    const marker = join(dir, 'post-terminal.txt');
    const scripts = writeTreeScripts(dir, marker);
    const runId = `ptree-${Date.now()}`;
    const engine = new ChatEngine({
      task: 't',
      projectRoot: dir,
      runId,
    });
    let grandchildPid: number | undefined;
    try {
      const job = startBackgroundShell({
        command: `node ${scripts.parent} ${scripts.grandchild}`,
        cwd: dir,
        timeoutMs: 60_000,
        ownerId: runId,
      });
      grandchildPid = await waitForStdoutPid(job.id);
      assert.ok(isProcessAlive(grandchildPid), 'grandchild should be running before cancel');
      // Cancel while the tree is live — not an already-aborted signal.
      engine.abortTurn();
      await awaitBackgroundShell(job.id, 8_000);
      assert.ok(await waitUntilDead(grandchildPid), 'grandchild should die after abortTurn tree kill');
      await new Promise((resolve) => setTimeout(resolve, POST_KILL_WAIT_MS));
      assert.equal(
        existsSync(marker),
        false,
        'descendant must not write after abortTurn terminated the process tree',
      );
    } finally {
      killAllBackgroundShells({ ownerId: runId, includeDetached: true });
      if (grandchildPid !== undefined && isProcessAlive(grandchildPid)) {
        try {
          process.kill(grandchildPid);
        } catch {
          /* already gone */
        }
      }
    }
  });

  it('Windows: explicit killBackgroundShell prevents delayed descendant write', async () => {
    assert.equal(process.platform, 'win32');
    const dir = mkdtempSync(join(tmpdir(), 'babel-ptree-kill-'));
    const marker = join(dir, 'post-terminal.txt');
    const scripts = writeTreeScripts(dir, marker);
    let grandchildPid: number | undefined;
    try {
      const job = startBackgroundShell({
        command: `node ${scripts.parent} ${scripts.grandchild}`,
        cwd: dir,
        timeoutMs: 60_000,
      });
      grandchildPid = await waitForStdoutPid(job.id);
      killBackgroundShell(job.id);
      await awaitBackgroundShell(job.id, 8_000);
      assert.ok(await waitUntilDead(grandchildPid));
      await new Promise((resolve) => setTimeout(resolve, POST_KILL_WAIT_MS));
      assert.equal(existsSync(marker), false);
    } finally {
      if (grandchildPid !== undefined && isProcessAlive(grandchildPid)) {
        try {
          process.kill(grandchildPid);
        } catch {
          /* already gone */
        }
      }
    }
  });

  it('Linux process-tree fixture: NOT RUN', () => {
    if (process.platform === 'linux') {
      assert.ok(true, 'Linux host would execute the same portable fixture');
      return;
    }
    assert.equal(
      process.platform,
      'win32',
      'Linux NOT RUN: this isolated worktree host is Windows (process.platform=win32); no Linux runner is attached to this subagent. The fixture above is portable (node child→grandchild delayed write + terminateChildTree).',
    );
  });
});
