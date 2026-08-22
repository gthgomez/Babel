/**
 * Unit tests for campaignExecutors.opencode.ts — raw OpenCode CLI arm executor.
 * Fully deterministic: fake spawnImpl, no real binary, no network.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';

import {
  DEFAULT_OPENCODE_MODEL,
  createOpenCodeCliArmExecutor,
} from './campaignExecutors.opencode.js';
import type { ArmExecutionRequest } from './campaignExecutors.js';

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  pid = 4242;
  exitCode: number | null = null;
  signalCode: string | null = null;
  signals: Array<string | undefined> = [];
  /** Signals the fake process refuses to die from (timeout escalation path). */
  ignoreSignals = new Set<string>();

  kill(signal?: string): boolean {
    this.signals.push(signal);
    const sig = signal ?? 'SIGTERM';
    if (this.ignoreSignals.has(sig)) return true;
    // Fake death: emit close on next microtask so handlers observe async flow.
    queueMicrotask(() => {
      this.exitCode = null;
      this.signalCode = sig;
      this.emit('close', null, sig);
    });
    return true;
  }
}

interface SpawnCall {
  file: string;
  args: string[];
  opts: {
    cwd?: string | undefined;
    env?: NodeJS.ProcessEnv | undefined;
    windowsHide?: boolean | undefined;
    shell?: boolean | string | undefined;
  };
  child: FakeChild;
}

function makeFakeSpawn(): {
  spawnImpl: typeof import('node:child_process').spawn;
  calls: SpawnCall[];
} {
  const calls: SpawnCall[] = [];
  const spawnImpl = ((file: string, args: readonly string[], opts: SpawnCall['opts']) => {
    const child = new FakeChild();
    calls.push({ file, args: [...args], opts, child });
    return child as unknown as ChildProcess;
  }) as unknown as typeof import('node:child_process').spawn;
  return { spawnImpl, calls };
}

function baseRequest(
  overrides?: Partial<ArmExecutionRequest>,
): ArmExecutionRequest {
  return {
    arm: 'raw_opencode',
    workspaceRoot: 'C:/tmp/ws-1',
    prompt: 'Fix the flibber widget',
    model: 'm-custom-1',
    provider: 'live',
    env: { OPENCODE_API_KEY: 'k-live-123' },
    timeoutMs: 60_000,
    cliEntry: 'not-used-by-opencode-executor',
    spawnCwd: 'not-used-by-opencode-executor',
    ...overrides,
  };
}

describe('createOpenCodeCliArmExecutor', () => {
  test('constructs argv/cwd/env without shell and passes custom model through', async () => {
    const { spawnImpl, calls } = makeFakeSpawn();
    const exec = createOpenCodeCliArmExecutor({ spawnImpl });
    const pending = exec.execute(baseRequest());
    assert.equal(calls.length, 1);
    calls[0]!.child.emit('close', 0, null);
    const r = await pending;

    const call = calls[0]!;
    assert.equal(call.file, 'opencode');
    assert.deepEqual(call.args, ['run', '--model', 'm-custom-1', 'Fix the flibber widget']);
    assert.equal(call.opts.cwd, 'C:/tmp/ws-1');
    assert.equal(call.opts.windowsHide, true);
    assert.equal(call.opts.shell, undefined);
    assert.equal(call.opts.env?.['OPENCODE_API_KEY'], 'k-live-123');
    assert.equal(r.exitCode, 0);
    assert.equal(r.timedOut, false);
    assert.equal(r.launchError, null);
    assert.equal(r.executorId, 'opencode_cli_raw');
  });

  test('falls back to default model when request.model is null', async () => {
    const { spawnImpl, calls } = makeFakeSpawn();
    const exec = createOpenCodeCliArmExecutor({ spawnImpl });
    const pending = exec.execute(baseRequest({ model: null }));
    calls[0]!.child.emit('close', 0, null);
    await pending;
    assert.deepEqual(calls[0]!.args, [
      'run',
      '--model',
      DEFAULT_OPENCODE_MODEL,
      'Fix the flibber widget',
    ]);
  });

  test('refuses mock provider without spawning (no genuine baseline)', async () => {
    const { spawnImpl, calls } = makeFakeSpawn();
    const exec = createOpenCodeCliArmExecutor({ spawnImpl });
    const r = await exec.execute(baseRequest({ provider: 'mock' }));
    assert.equal(calls.length, 0);
    assert.equal(
      r.launchError,
      'raw_opencode requires live provider (mock produces no genuine baseline)',
    );
    assert.equal(r.exitCode, null);
  });

  test('refuses missing OPENCODE_API_KEY without spawning and never leaks values', async () => {
    const { spawnImpl, calls } = makeFakeSpawn();
    const exec = createOpenCodeCliArmExecutor({ spawnImpl });
    const decoy = 'sk-super-secret-decoy-value';
    const blankKey = await exec.execute(
      baseRequest({ env: { OPENCODE_API_KEY: '   ', OTHER_VAR: decoy } }),
    );
    assert.equal(calls.length, 0);
    assert.match(blankKey.launchError ?? '', /OPENCODE_API_KEY/);
    const absentKey = await exec.execute(baseRequest({ env: {} }));
    assert.equal(calls.length, 0);
    assert.match(absentKey.launchError ?? '', /OPENCODE_API_KEY/);
    for (const r of [blankKey, absentKey]) {
      assert.equal(JSON.stringify(r).includes(decoy), false);
    }
  });

  test('captures stdout/stderr fully and passes nonzero exit code through', async () => {
    const { spawnImpl, calls } = makeFakeSpawn();
    const exec = createOpenCodeCliArmExecutor({ spawnImpl });
    const pending = exec.execute(baseRequest());
    const child = calls[0]!.child;
    child.stdout.emit('data', 'partial out ');
    child.stdout.emit('data', Buffer.from('more out'));
    child.stderr.emit('data', 'warn line\n');
    child.emit('close', 3, null);
    const r = await pending;
    assert.equal(r.exitCode, 3);
    assert.equal(r.timedOut, false);
    assert.equal(r.stdout, 'partial out more out');
    assert.equal(r.stderr, 'warn line\n');
  });

  test('timeout escalates SIGTERM → SIGKILL when child ignores SIGTERM', async (t) => {
    const { spawnImpl, calls } = makeFakeSpawn();
    const exec = createOpenCodeCliArmExecutor({ spawnImpl });
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const pending = exec.execute(baseRequest({ timeoutMs: 1_000 }));
    const child = calls[0]!.child;
    child.ignoreSignals.add('SIGTERM');
    t.mock.timers.tick(1_000);
    assert.deepEqual(child.signals, [undefined], 'first enforcement is plain kill()');
    assert.equal(child.signalCode, null);
    t.mock.timers.tick(5_000);
    const r = await pending;
    assert.equal(child.signals[1], 'SIGKILL');
    assert.equal(r.timedOut, true);
    assert.equal(r.exitCode, null);
    assert.equal(r.launchError, null);
  });

  test('error event yields launchError with null exit code and does not throw', async () => {
    const { spawnImpl, calls } = makeFakeSpawn();
    const exec = createOpenCodeCliArmExecutor({ spawnImpl });
    const pending = exec.execute(baseRequest());
    calls[0]!.child.emit('error', new Error('spawn opencode ENOENT'));
    const r = await pending;
    assert.match(r.launchError ?? '', /ENOENT/);
    assert.equal(r.exitCode, null);
    // Late close must not override the launch failure outcome.
    calls[0]!.child.emit('close', 1, null);
    assert.equal(r.exitCode, null);
  });

  test('supports only raw_opencode', async () => {
    const { spawnImpl, calls } = makeFakeSpawn();
    const exec = createOpenCodeCliArmExecutor({ spawnImpl });
    assert.equal(exec.supports('raw_opencode'), true);
    assert.equal(exec.supports('babel_enforce'), false);
    const r = await exec.execute(baseRequest({ arm: 'babel_enforce' }));
    assert.equal(calls.length, 0);
    assert.match(r.launchError ?? '', /does not support arm "babel_enforce"/);
  });
});
