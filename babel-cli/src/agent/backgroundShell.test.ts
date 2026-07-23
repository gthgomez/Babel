import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';

import {
  awaitBackgroundShell,
  capObservationText,
  clearBackgroundShellRegistry,
  killBackgroundShell,
  resetBackgroundShellRegistryForTests,
  startBackgroundShell,
} from './backgroundShell.js';
import { getSafeEnv } from '../utils/safeEnv.js';

describe('backgroundShell (T2.2)', () => {
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
