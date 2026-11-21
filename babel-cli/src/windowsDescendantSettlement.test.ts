/**
 * Windows descendant settlement (SC-10).
 *
 * The contract: a cancelled/timed-out supervisor may only report a settled
 * tree when a complete descendant census observed zero survivors. A failed
 * census is never success. Synthetic pids only outside the Windows-only
 * integration fixture (no-op child processes that exit immediately).
 */
import assert from 'node:assert/strict';
import childProcess, { execFileSync, spawn, type SpawnOptions } from 'node:child_process';
import { isProcessAlive } from './processTree.js';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { ProcessWitness } from './diagnostics/bdns/processWitness.js';
import { awaitPendingProcessTerminations } from './sandboxProcessTermination.js';
import { spawnCommandAsync } from './sandboxSpawnCommandAsync.js';
import { getSafeEnv } from './utils/safeEnv.js';
import {
  descendantPidsFromRows,
  confirmWindowsDescendants,
  listWindowsDescendantPids,
  observeWindowsDescendants,
  parseWmicProcessRows,
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

const windows = process.platform === 'win32'
const windowsRoot = process.env['SystemRoot'] || process.env['WINDIR'] || 'C:\\Windows'
const fixtureEnv = getSafeEnv()

function writeFixture(root: string, detached: boolean, retainOutput: boolean): void {
  writeFileSync(join(root, 'parent.mjs'), `
import { spawn } from 'node:child_process'
import { closeSync, existsSync, openSync } from 'node:fs'
const stderr = openSync('grandchild.stderr', 'w')
const child = spawn(process.execPath, ['grandchild.mjs'], {
  detached: ${detached}, windowsHide: true,
  stdio: ['ignore', ${retainOutput ? "'inherit'" : "'ignore'"}, stderr],
})
closeSync(stderr)
child.once('error', error => {
  console.error('fixture spawn failed:', error.code)
  process.exit(1)
})
child.unref()
setInterval(() => {
  if (existsSync('exit-parent') || existsSync('stop')) process.exit(0)
}, 20)
`)
  writeFileSync(join(root, 'grandchild.mjs'), `
import { existsSync, renameSync, writeFileSync } from 'node:fs'
const ready = JSON.stringify({ pid: process.pid, parentPid: process.ppid })
function publish(name, data) {
  writeFileSync(name + '.tmp', data)
  renameSync(name + '.tmp', name)
}
setInterval(() => {
  if (existsSync('stop')) {
    publish('stopped', ready)
    process.exit(0)
  }
  for (const phase of ['startup', 'survived']) {
    if (existsSync(phase) && !existsSync(phase + '.ack')) publish(phase + '.ack', ready)
  }
}, 20)
publish('ready', ready)
`)
}

interface FixtureIdentity { pid: number; parentPid: number }

async function waitFor<T>(read: () => T | undefined, message: string, timeoutMs = 8_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  do {
    const value = read()
    if (value !== undefined) return value
    await sleep(25)
  } while (Date.now() < deadline)
  throw new Error(message)
}

function readFixtureIdentity(root: string, file: string): FixtureIdentity | undefined {
  const path = join(root, file)
  if (!existsSync(path)) return undefined
  const identity = JSON.parse(readFileSync(path, 'utf8')) as FixtureIdentity
  assert.ok(Number.isSafeInteger(identity.pid) && identity.pid > 0)
  assert.ok(Number.isSafeInteger(identity.parentPid) && identity.parentPid > 0)
  return identity
}

async function confirmFixtureReply(root: string, phase: string, expected: FixtureIdentity): Promise<void> {
  writeFileSync(join(root, phase), '')
  const reply = await waitFor(() => readFixtureIdentity(root, `${phase}.ack`), `grandchild did not acknowledge ${phase}`)
  assert.deepEqual(reply, expected)
}

// Query individual kernel process records independently of WMIC/CIM and
// process.kill(pid, 0). Creation ticks distinguish the original PID generation.
function windowsFixtureProcessTimes({ pid, parentPid }: FixtureIdentity): (string | null)[] {
  const script = `
$ErrorActionPreference = 'Stop'
foreach ($processId in ${parentPid}, ${pid}) {
  try { $process = [Diagnostics.Process]::GetProcessById($processId) }
  catch [ArgumentException] { 'gone'; continue }
  try {
    if ($process.HasExited) { 'gone' }
    else { $process.StartTime.ToUniversalTime().Ticks.ToString() }
  } finally { $process.Dispose() }
}
`
  const powershell = join(windowsRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const output = execFileSync(powershell, [
    '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64'),
  ], { encoding: 'utf8', env: fixtureEnv, windowsHide: true, timeout: 6_000 })
  const records = output.trim().split(/\r?\n/)
  assert.equal(records.length, 2, 'Windows process observer must return both records')
  return records.map(record => {
    if (record === 'gone') return null
    assert.match(record, /^\d+$/, 'Windows process observer must report creation ticks')
    return record
  })
}

function fixtureStderr(root: string, parentStderr: string): { parentStderr: string; grandchildStderr: string } {
  const sanitize = (value: string) => value.replaceAll(root, '<fixture>').replaceAll(process.execPath, '<node>')
    .replace(/[^\x20-\x7e\r\n]/g, '').trim().slice(0, 500)
  const file = join(root, 'grandchild.stderr')
  return {
    parentStderr: sanitize(parentStderr),
    grandchildStderr: existsSync(file) ? sanitize(readFileSync(file, 'utf8')) : '',
  }
}

async function checkFixtureWithoutBabel(t: TestContext, detached: boolean): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'babel-w08-fixture-'))
  writeFixture(root, detached, false)
  const parent = spawn(process.execPath, ['parent.mjs'], {
    cwd: root, env: fixtureEnv, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
  })
  const exited = new Promise<number | null>((resolve, reject) => {
    parent.once('close', resolve)
    parent.once('error', reject)
  })
  void exited.catch(() => {})
  let stderr = ''
  parent.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
  let identity: FixtureIdentity | undefined
  let before: (string | null)[] | undefined
  let after: (string | null)[] | undefined
  try {
    identity = await waitFor(() => readFixtureIdentity(root, 'ready'), 'fixture grandchild never reported ready')
    assert.equal(identity.parentPid, parent.pid)
    before = windows ? windowsFixtureProcessTimes(identity) : undefined
    if (windows) assert.ok(before?.every(Boolean), 'both fixture processes must be present before parent exit')
    await confirmFixtureReply(root, 'startup', identity)
    writeFileSync(join(root, 'exit-parent'), '')
    assert.equal(await exited, 0, 'fixture parent must exit normally')
    if (windows) {
      after = windowsFixtureProcessTimes(identity)
      assert.deepEqual(after, [null, detached ? before![1] : null])
    }
    // A reply to a new request after parent exit is the no-cleanup control.
    if (detached) await confirmFixtureReply(root, 'survived', identity)
  } finally {
    t.diagnostic(JSON.stringify({ detached, identity, before, after, parentExitCode: parent.exitCode, ...fixtureStderr(root, stderr) }))
    writeFileSync(join(root, 'stop'), '')
    await exited
    if (windows && identity && before?.[1]) {
      const owned = identity
      await waitFor(() => windowsFixtureProcessTimes(owned)[1] !== before![1] ? true : undefined,
        'owned control grandchild did not stop')
    } else if (!windows && identity) {
      await waitFor(() => readFixtureIdentity(root, 'stopped'), 'owned control grandchild did not stop')
    }
    rmSync(root, { recursive: true, force: true })
  }
}

test('generated descendant fixture publishes its grandchild pid', async t => {
  if (windows) await checkFixtureWithoutBabel(t, false)
  await checkFixtureWithoutBabel(t, true)
})

function refuseWindowsCensus(t: TestContext): void {
  const launch = childProcess.spawn
  t.mock.method(childProcess, 'spawn', (file: string, args: readonly string[], options: SpawnOptions) => {
    const executable = basename(file).toLowerCase()
    if (executable === 'wmic.exe' || executable === 'powershell.exe') {
      return launch(process.execPath, ['-e', 'process.exit(7)'], options)
    }
    return launch(file, args, options)
  })
  syncBuiltinESMExports()
}

test('Windows cancel path observes a grandchild that the leader-only probe cannot see', {
  skip: !windows ? 'Windows-only descendant fixture' : false,
}, async t => {
  for (const mode of ['cancel', 'timeout', 'unavailable census', 'timeout with unavailable census'] as const) {
    await t.test(mode, async subtest => {
      const root = mkdtempSync(join(tmpdir(), 'babel-w08-win-tree-'))
      const owner = `windows-grandchild-${mode}`
      const hasDeadline = mode.startsWith('timeout')
      const censusUnavailable = mode.includes('unavailable census')
      // The detached fixture holds the real supervisor's output pipe open after
      // its parent exits. The command stays pending until the grandchild exits.
      writeFixture(root, true, true)
      const controller = new AbortController()
      const witness = new ProcessWitness()
      let identity: FixtureIdentity | undefined
      let parentExitCode: number | null | undefined
      let parentPid: number | undefined
      let atDeadline: (string | null)[] | undefined
      let deadlineObservationError: unknown
      const recordStart = witness.started.bind(witness)
      witness.started = (input, id, pid) => {
        parentPid = pid
        recordStart(input, id, pid)
      }
      const recordExit = witness.exited.bind(witness)
      witness.exited = (input, id, exit) => {
        parentExitCode = exit.exitCode
        recordExit(input, id, exit)
      }
      const recordTimeout = witness.timeout.bind(witness)
      witness.timeout = (input, id) => {
        recordTimeout(input, id)
        // The actual deadline has fired, but the supervisor has yet to start its census.
        try { if (identity) atDeadline = windowsFixtureProcessTimes(identity) }
        catch (error) { deadlineObservationError = error }
      }
      const pending = spawnCommandAsync(process.execPath, ['parent.mjs'], {
        cwd: root, env: fixtureEnv, signal: controller.signal, timeoutMs: hasDeadline ? 10_000 : 0,
        processWitness: witness, processContext: { sessionId: owner },
      })
      let result: Awaited<typeof pending> | undefined
      void pending.then(value => { result = value })
      let before: (string | null)[] | undefined
      let after: (string | null)[] | undefined
      let terminationError: unknown
      try {
        identity = await waitFor(() => readFixtureIdentity(root, 'ready'), 'fixture grandchild never reported ready')
        assert.equal(identity.parentPid, parentPid, 'fixture grandchild must belong to the supervised parent')
        const initial = windowsFixtureProcessTimes(identity)
        assert.ok(initial.every(Boolean), 'both fixture processes must be present before parent exit')
        await confirmFixtureReply(root, 'startup', identity)
        if (mode === 'unavailable census') {
          // Keep the leader alive so real taskkill can succeed even when each
          // census executable fails. Taskkill alone cannot certify the tree.
          before = initial
        } else {
          writeFileSync(join(root, 'exit-parent'), '')
          const owned = identity
          before = await waitFor(() => {
            const records = windowsFixtureProcessTimes(owned)
            return records[0] === null ? records : undefined
          }, 'fixture parent did not exit')
          assert.deepEqual(before, [null, initial[1]], 'the same grandchild must outlive its parent')
        }
        assert.equal(result, undefined, 'the real supervisor must still own the pending command')
        if (censusUnavailable) refuseWindowsCensus(subtest)
        if (!hasDeadline) controller.abort()
        const completed = await waitFor(() => result, `${mode} did not return`, 35_000)
        assert.equal(completed.aborted, !hasDeadline)
        assert.equal(completed.timedOut, hasDeadline)
        assert.equal(completed.processStarted, true)
        assert.ok(completed.termination, 'the real supervisor must expose settlement')
        try { await completed.termination } catch (error) { terminationError = error }
        after = windowsFixtureProcessTimes(identity)
        if (hasDeadline) {
          assert.ifError(deadlineObservationError)
          assert.deepEqual(atDeadline, before, 'the same grandchild must be alive at the actual deadline')
        }
        if (censusUnavailable) {
          assert.match(String(terminationError), /census.*unavailable/i)
          if (hasDeadline) {
            assert.match(completed.error?.message ?? '', /census.*unavailable/i)
            assert.deepEqual(after, before, 'the detached survivor must remain alive without a census')
          }
        } else {
          assert.notEqual(after[1], before[1], 'the owned grandchild must be gone before test teardown')
          assert.ifError(terminationError)
          assert.equal(parentExitCode, 0)
          assert.match(completed.error?.message ?? '', hasDeadline ? /ETIMEDOUT/ : /aborted/)
        }
      } finally {
        subtest.mock.restoreAll()
        syncBuiltinESMExports()
        // Only these fixtures read their private stop file. Never signal a PID
        // from a stale fixture record, and never intervene before observation.
        try {
          if (after === undefined && identity) after = windowsFixtureProcessTimes(identity)
        } finally {
          writeFileSync(join(root, 'stop'), '')
          await pending
          try { await awaitPendingProcessTerminations(owner) } catch { /* observed above */ }
          if (identity && before?.[1] && after?.[1] === before[1]) {
            const owned = identity
            await waitFor(() => windowsFixtureProcessTimes(owned)[1] !== before![1] ? true : undefined,
              'owned supervisor fixture did not stop after observation')
          }
          subtest.diagnostic(JSON.stringify({ mode, identity, before, atDeadline, after, parentExitCode,
            termination: terminationError instanceof Error ? terminationError.message.replaceAll(process.execPath, '<node>') : undefined,
            ...fixtureStderr(root, result?.stderr ?? '') }))
          rmSync(root, { recursive: true, force: true })
        }
      }
    })
  }
})
