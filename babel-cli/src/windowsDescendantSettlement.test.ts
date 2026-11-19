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
import { isProcessAlive } from './processTree.js';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  descendantPidsFromRows,
  confirmWindowsDescendants,
  listWindowsDescendantPids,
  observeWindowsDescendants,
  parseWmicProcessRows,
  settleWindowsDescendants,
  type WindowsDescendantProbe,
} from './windowsProcessSettlement.js';

/** Generated parent fixture: spawn an unref'ed grandchild and publish its pid. */
function buildParentFixture(root: string, grandchildPidFile: string): string {
  return `import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const child = spawn(process.execPath, ['grandchild.mjs'], { cwd: ${JSON.stringify(root)}, stdio: 'ignore' });
child.unref();
writeFileSync(${JSON.stringify(grandchildPidFile)}, String(child.pid));
process.exit(0);
`;
}

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

test('descendant walk follows the full parent chain from a dead leader', () => {
  const rows = [
    { processId: 1, parentProcessId: 0 },
    { processId: 100, parentProcessId: 1 },
    { processId: 101, parentProcessId: 100 },
    { processId: 102, parentProcessId: 101 },
    { processId: 200, parentProcessId: 1 },
  ];
  assert.deepEqual(descendantPidsFromRows(100, rows), [101, 102]);
  assert.deepEqual(descendantPidsFromRows(200, rows), []);
});

test('WMIC process table parsing preserves parent linkage and rejects noise', () => {
  const rows = parseWmicProcessRows([
    'Node,ParentProcessId,ProcessId',
    'RUNNER,1,100',
    'RUNNER,100,101',
    'RUNNER,101,102',
    'noise without commas',
    '',
  ].join('\r\n'));
  assert.deepEqual(rows, [
    { processId: 100, parentProcessId: 1 },
    { processId: 101, parentProcessId: 100 },
    { processId: 102, parentProcessId: 101 },
  ]);
  assert.deepEqual(descendantPidsFromRows(100, rows ?? []), [101, 102]);
  assert.equal(parseWmicProcessRows('Node,ParentProcessId,ProcessId\r\n'), null);
  // Single full CIM snapshot form: ProcessId,ParentProcessId.
  const cimRows = parseWmicProcessRows('1,100\r\n100,101\r\n101,102\r\n');
  assert.deepEqual(cimRows, [
    { processId: 100, parentProcessId: 1 },
    { processId: 101, parentProcessId: 100 },
    { processId: 102, parentProcessId: 101 },
  ]);
  assert.deepEqual(descendantPidsFromRows(100, cimRows ?? []), [101, 102]);
});

test('observation and confirmation are separate phases', async () => {
  const observed = await observeWindowsDescendants(4242, {
    probe: { listDescendants: () => [101, 102], kill: () => true },
  });
  assert.deepEqual(observed, [101, 102]);
  assert.equal(await observeWindowsDescendants(4242, {
    probe: { listDescendants: () => null, kill: () => true },
  }), null, 'incomplete observation must stay null');
});

test('confirmation reaps observed survivors by pid without another census', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    try {
      await new Promise<void>((resolve) => child.once('spawn', () => resolve()));
      const result = await confirmWindowsDescendants([child.pid!], {
        kill: (pid) => { try { process.kill(pid); return true; } catch { return false; } },
        timeoutMs: 1_000,
      });
      assert.equal(result.confirmed, true);
      assert.deepEqual(result.remaining, []);
      assert.equal(isProcessAlive(child.pid!), false);
    } finally {
      try { child.kill(); } catch { /* already gone */ }
    }
  },
);

test('confirmation reports survivors when the kill is refused', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    try {
      await new Promise<void>((resolve) => child.once('spawn', () => resolve()));
      const result = await confirmWindowsDescendants([child.pid!], {
        kill: () => false,
        timeoutMs: 250,
        wait: async () => undefined,
      });
      assert.equal(result.confirmed, false);
      assert.deepEqual(result.remaining, [child.pid!]);
    } finally {
      try { child.kill(); } catch { /* already gone */ }
    }
  },
);

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

test('generated descendant fixture publishes its grandchild pid', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-w08-fixture-'));
  const grandchildPidFile = join(root, 'grandchild.pid');
  writeFileSync(join(root, 'grandchild.mjs'), 'setInterval(() => {}, 1000);\n');
  writeFileSync(join(root, 'parent.mjs'), buildParentFixture(root, grandchildPidFile));
  let grandchildPid: number | undefined;
  try {
    const stderr: string[] = [];
    const parent = spawn(process.execPath, [join(root, 'parent.mjs')], {
      cwd: root,
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    parent.stderr.setEncoding('utf8');
    parent.stderr.on('data', (chunk: string) => stderr.push(chunk));
    const exitCode = await new Promise<number | null>((resolve) => parent.once('exit', resolve));
    assert.equal(exitCode, 0, stderr.join(''));
    assert.equal(existsSync(grandchildPidFile), true, stderr.join(''));
    grandchildPid = Number(readFileSync(grandchildPidFile, 'utf8'));
    assert.ok(Number.isSafeInteger(grandchildPid) && grandchildPid > 0);
    assert.equal(isProcessAlive(grandchildPid), true, 'the fixture grandchild must survive its parent');
  } finally {
    if (grandchildPid !== undefined) {
      try { process.kill(grandchildPid); } catch { /* already gone */ }
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  'Windows cancel path observes a grandchild that the leader-only probe cannot see',
  { skip: process.platform !== 'win32' ? 'Windows-only descendant fixture' : false },
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'babel-w08-win-tree-'));
    const grandchildPidFile = join(root, 'grandchild.pid');
    writeFileSync(join(root, 'grandchild.mjs'), 'setInterval(() => {}, 1000);\n');
    writeFileSync(join(root, 'parent.mjs'), buildParentFixture(root, grandchildPidFile));
    let parentStderr = '';
    const parent = spawn(process.execPath, [join(root, 'parent.mjs')], {
      cwd: root,
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    parent.stderr.setEncoding('utf8');
    parent.stderr.on('data', (chunk: string) => {
      if (parentStderr.length < 4_000) parentStderr += chunk;
    });
    // Attach before any await: a fast Windows exit would otherwise be missed
    // and leave this promise pending with an empty event loop.
    const parentExited = new Promise<void>((resolve) => parent.once('exit', () => resolve()));
    try {
      const deadline = Date.now() + 20_000;
      while (!existsSync(grandchildPidFile)) {
        if (parent.exitCode !== null) break;
        if (Date.now() > deadline) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      if (!existsSync(grandchildPidFile)) {
        throw new Error(`grandchild pid was never published (parent exit ${parent.exitCode ?? 'running'}): ${parentStderr.trim() || '<no stderr>'}`);
      }
      const grandchildPid = Number(readFileSync(grandchildPidFile, 'utf8'));
      assert.ok(Number.isSafeInteger(grandchildPid) && grandchildPid > 0);
      await parentExited;
      const settlement = await settleWindowsDescendants(parent.pid!, { rounds: 1, roundDelayMs: 50 });
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
