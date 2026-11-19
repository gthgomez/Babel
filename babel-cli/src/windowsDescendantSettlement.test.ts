/**
 * Windows descendant settlement (SC-10).
 *
 * The contract: a cancelled/timed-out supervisor may only report a settled
 * tree when a complete descendant census observed zero survivors. A failed
 * census is never success. Synthetic pids only outside the Windows-only
 * integration fixture (no-op child processes that exit immediately).
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  listWindowsDescendantPids,
  settleWindowsDescendants,
  type WindowsDescendantProbe,
} from './windowsProcessSettlement.js';

function scriptedProbe(rounds: number[][]): WindowsDescendantProbe & { killed: number[]; calls: number } {
  const state = {
    killed: [] as number[],
    calls: 0,
    listDescendants: (_rootPid: number): number[] | null => {
      const index = Math.min(state.calls, rounds.length - 1);
      state.calls += 1;
      return rounds[index] ?? [];
    },
    kill: (pid: number): boolean => {
      state.killed.push(pid);
      return true;
    },
  };
  return state;
}

test('a complete census with no descendants confirms settlement without kills', async () => {
  const probe = scriptedProbe([[]]);
  const result = await settleWindowsDescendants(4242, { probe, wait: async () => undefined });
  assert.deepEqual(result, {
    confirmed: true,
    remaining: [],
    probeUnavailable: false,
    killsAttempted: 0,
  });
});

test('grandchildren found by the census are killed and re-censused before settlement', async () => {
  const probe = scriptedProbe([[101, 102], []]);
  const result = await settleWindowsDescendants(4242, { probe, wait: async () => undefined });
  assert.equal(result.confirmed, true);
  assert.deepEqual(probe.killed, [101, 102]);
  assert.equal(probe.calls, 2, 'settlement must re-census after killing');
});

test('survivors after the bounded rounds are reported, never silently settled', async () => {
  const probe = scriptedProbe([[101], [101], [101], [101]]);
  const result = await settleWindowsDescendants(4242, { probe, rounds: 2, wait: async () => undefined });
  assert.equal(result.confirmed, false);
  assert.deepEqual(result.remaining, [101]);
  assert.equal(result.probeUnavailable, false);
  assert.equal(result.killsAttempted, 2);
});

test('an unavailable census fails closed instead of claiming an empty tree', async () => {
  const probe: WindowsDescendantProbe = {
    listDescendants: () => null,
    kill: () => true,
  };
  const result = await settleWindowsDescendants(4242, { probe, wait: async () => undefined });
  assert.equal(result.confirmed, false);
  assert.equal(result.probeUnavailable, true);
  assert.equal(result.killsAttempted, 0);
});

test('the real census is unavailable off Windows and never fabricates an empty tree', () => {
  if (process.platform === 'win32') return;
  assert.equal(listWindowsDescendantPids(process.pid), null);
});

test(
  'Windows cancel path observes a grandchild that the leader-only probe cannot see',
  { skip: process.platform !== 'win32' ? 'Windows-only descendant fixture' : false },
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'babel-w08-win-tree-'));
    const grandchildPidFile = join(root, 'grandchild.pid');
    writeFileSync(join(root, 'grandchild.mjs'), 'setInterval(() => {}, 1000);\n');
    writeFileSync(
      join(root, 'parent.mjs'),
      `import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const child = spawn(process.execPath, ['grandchild.mjs'], { cwd: ${JSON.stringify(root)}, stdio: 'ignore' });
child.unref();
child.once('spawn', () => {
  writeFileSync(${JSON.stringify(grandchildPidFile)}, String(child.pid));
  process.exit(0);
});
`,
    );
    const parent = spawn(process.execPath, [join(root, 'parent.mjs')], {
      cwd: root,
      stdio: 'ignore',
      windowsHide: true,
    });
    // Attach before any await: a fast Windows exit would otherwise be missed
    // and leave this promise pending with an empty event loop.
    const parentExited = new Promise<void>((resolve) => parent.once('exit', () => resolve()));
    try {
      const deadline = Date.now() + 10_000;
      while (!existsSync(grandchildPidFile)) {
        if (Date.now() > deadline) throw new Error('grandchild pid was never published');
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const grandchildPid = Number(readFileSync(grandchildPidFile, 'utf8'));
      assert.ok(Number.isSafeInteger(grandchildPid) && grandchildPid > 0);
      await parentExited;
      const settlement = await settleWindowsDescendants(parent.pid!, { rounds: 2, roundDelayMs: 50 });
      assert.equal(settlement.confirmed, true);
      assert.equal(settlement.remaining.length, 0);
      const census = listWindowsDescendantPids(parent.pid!);
      assert.deepEqual(census, []);
      assert.equal(
        (() => {
          try {
            process.kill(grandchildPid, 0);
            return true;
          } catch {
            return false;
          }
        })(),
        false,
        'grandchild must not survive descendant settlement',
      );
    } finally {
      parent.kill();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
