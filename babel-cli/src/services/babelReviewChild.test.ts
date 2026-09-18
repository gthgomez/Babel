import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { babelReviewChildEnv, launchBabelReviewChild, reviewChildProcessTimeoutMs } from './babelReviewChild.js';
import {
  createReviewAuthoritySupervisor,
  followReviewAuthorityLifetime,
  type ReviewAuthorityCandidate,
  type ReviewTaskAllowance,
} from './reviewSupervisor.js';
import { resolveChatTaskClass } from '../config/chatTaskClass.js';
import { resolvePolicyMode, resolveStallShadowMode } from '../agent/policyShadow.js';

test('review child strips publication credentials, preload hooks and ambient overrides while enforcing read-only sandbox', () => {
  const env = babelReviewChildEnv({ source: '/source', trustedRoot: '/trusted', output: '/state/out', runs: '/state/runs', model: 'mimo-v2.5' }, {
    PATH: '/bin', GH_TOKEN: 'synthetic', GITHUB_TOKEN: 'synthetic', NODE_OPTIONS: '--require malicious',
    OPENAI_API_KEY: 'synthetic', BABEL_EXECUTION_PROFILE: 'dev_local', BABEL_ALLOWED_TOOLS: '["shell_exec"]',
  });
  assert.equal(env['GH_TOKEN'], undefined); assert.equal(env['GITHUB_TOKEN'], undefined);
  assert.equal(env['OPENAI_API_KEY'], undefined); assert.equal(env['NODE_OPTIONS'], undefined);
  assert.equal(env['BABEL_CHAT_MAX_COST'], 'unlimited');
  assert.equal(env['BABEL_EXECUTION_PROFILE'], 'read_only_audit');
  assert.equal(env['BABEL_READ_ONLY'], 'true');
  // Compaction is not forced off in dogfood review
  assert.notEqual(env['BABEL_COMPACTION'], 'off');
  assert.equal(env['BABEL_ALLOWED_TOOLS'], JSON.stringify(['file_read', 'directory_list', 'grep', 'glob']));
  assert.equal(env['BABEL_DISALLOWED_TOOLS'], JSON.stringify(['shell_exec', 'test_run', 'file_write', 'mcp_request', 'memory_query', 'memory_store', 'semantic_search']));
  // Bounded budget defaults prevent runaway costs while allowing parent overrides
  assert.equal(env['BABEL_CHAT_MAX_WALL_MS'], '1200000');
  assert.equal(env['BABEL_CHAT_MAX_TURNS'], '36');
  assert.equal(env['BABEL_CHAT_STALL_TURNS'], '15');
  assert.equal(env['BABEL_CHAT_TASK_CLASS'], 'investigate');
  assert.equal(env['BABEL_POLICY_MODE_STALL_KILL'], 'shadow');
  assert.equal(resolvePolicyMode('stall_kill', 'investigate', env), 'shadow');
  assert.equal(resolveStallShadowMode('investigate', env), true);
  assert.equal(
    resolveChatTaskClass({
      env,
      taskText: 'Review untrusted security regression evidence without editing files.',
      autoClassify: true,
    }),
    'investigate',
  );
  assert.equal(env['BABEL_READ_ONLY_NO_INDEX_WRITE'], '1');
});

test('repair children keep generous repair budget and respect parent overrides', () => {
  const env = babelReviewChildEnv({ source: '/source', trustedRoot: '/trusted', output: '/state/out', runs: '/state/runs', model: 'deepseek-v4-flash', purpose: 'repair_proposal' });
  assert.equal(env['BABEL_CHAT_MAX_WALL_MS'], '3000000');
  assert.equal(env['BABEL_CHAT_MAX_TURNS'], '100');
  assert.equal(env['BABEL_CHAT_STALL_TURNS'], '5');
  assert.equal(env['BABEL_CHAT_TASK_CLASS'], 'investigate');
  assert.equal(env['BABEL_POLICY_MODE_STALL_KILL'], undefined);

  const overridden = babelReviewChildEnv(
    { source: '/source', trustedRoot: '/trusted', output: '/state/out', runs: '/state/runs', model: 'deepseek-v4-flash', purpose: 'repair_proposal' },
    { BABEL_CHAT_MAX_WALL_MS: '5000000', BABEL_CHAT_MAX_TURNS: '200' }
  );
  assert.equal(overridden['BABEL_CHAT_MAX_WALL_MS'], '5000000');
  assert.equal(overridden['BABEL_CHAT_MAX_TURNS'], '200');
});

test('normal investigate sessions keep enforce-mode stall policy outside trusted review children', () => {
  const env = { BABEL_CHAT_TASK_CLASS: 'investigate' };
  assert.equal(resolvePolicyMode('stall_kill', 'investigate', env), 'enforce');
  assert.equal(resolveStallShadowMode('investigate', env), false);
});

test('review child forwards the documented non-secret credential helper override', () => {
  const helperPath = '/opt/babel/override-get-auth-token.js';
  const env = babelReviewChildEnv(
    { source: '/source', trustedRoot: '/trusted', output: '/state/out', runs: '/state/runs', model: 'mimo-v2.5' },
    { PATH: '/bin', BABEL_OPENCODE_GO_HELPER: helperPath },
  );
  assert.equal(env['BABEL_OPENCODE_GO_HELPER'], helperPath);
  // Never invent an override that the parent did not set.
  const absent = babelReviewChildEnv(
    { source: '/source', trustedRoot: '/trusted', output: '/state/out', runs: '/state/runs', model: 'mimo-v2.5' },
    { PATH: '/bin' },
  );
  assert.equal(absent['BABEL_OPENCODE_GO_HELPER'], undefined);
});

test('controller process-timeout override remains finite and purpose-bounded', () => {
  assert.equal(reviewChildProcessTimeoutMs('review', {}), 1260000);
  assert.equal(reviewChildProcessTimeoutMs('repair_proposal', {}), 3050000);
  assert.equal(reviewChildProcessTimeoutMs('review', { BABEL_REVIEW_CHILD_TIMEOUT_MS: '1260000' }), 1260000);
  assert.equal(reviewChildProcessTimeoutMs('review', { BABEL_REVIEW_CHILD_TIMEOUT_MS: '0' }), 1260000);
  assert.equal(reviewChildProcessTimeoutMs('review', { BABEL_REVIEW_CHILD_TIMEOUT_MS: '1800001' }), 1260000);
  assert.equal(reviewChildProcessTimeoutMs('review', { BABEL_REVIEW_CHILD_TIMEOUT_MS: 'not-a-duration' }), 1260000);
});

function workerFixture() {
  const source = mkdtempSync(join(tmpdir(), 'babel child process '));
  const output = join(source, 'result.json');
  const worker = join(source, 'worker.mts');
  writeFileSync(worker, `import { writeFileSync } from 'node:fs';
const pid: number = process.pid;
writeFileSync(process.env.BABEL_REVIEW_OUTPUT!, JSON.stringify({ pid }));
if (process.env.BABEL_REVIEW_PURPOSE === 'repair_proposal') setInterval(() => {}, 100);
if (process.env.BABEL_REVIEW_PURPOSE === 'repair_proposal') process.on('SIGTERM', () => {});
`);
  return { source, output, worker, trustedRoot: source, runs: join(source, 'runs'), model: 'mimo-v2.5', tsx: resolve(fileURLToPath(new URL('../..', import.meta.url)), 'node_modules/tsx/dist/cli.mjs') };
}

test('actual TypeScript worker PID is the leased process, including paths with spaces', async () => {
  const fixture = workerFixture();
  let trackedPid = 0;
  let exitObserved = false;
  const result = await launchBabelReviewChild({ ...fixture, timeoutMs: 10000,
    onSpawn: pid => { trackedPid = pid; },
    onExit: () => { exitObserved = true; },
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.equal(result.artifact?.['pid'], trackedPid);
  assert.ok(exitObserved);
});

test('timeout force-kills an unresponsive actual worker before clearing its lease', async () => {
  const fixture = workerFixture();
  let trackedPid = 0;
  let clearedAfterExit = false;
  const result = await launchBabelReviewChild({ ...fixture, purpose: 'repair_proposal', timeoutMs: 3000,
    onSpawn: pid => { trackedPid = pid; },
    onExit: () => {
      assert.equal(JSON.parse(readFileSync(fixture.output, 'utf8')).pid, trackedPid);
      assert.throws(() => process.kill(trackedPid, 0), (error: unknown) => (error as NodeJS.ErrnoException).code === 'ESRCH');
      clearedAfterExit = true;
    },
  });
  assert.equal(result.timedOut, true);
  assert.equal(result.artifact?.['pid'], trackedPid);
  assert.ok(clearedAfterExit);
});

const authorityCandidate: ReviewAuthorityCandidate = {
  repository: 'gthgomez/Babel',
  prNumber: 201,
  baseSha: 'a'.repeat(40),
  headSha: 'b'.repeat(40),
  candidateDigest: 'c'.repeat(64),
};

const authorityAllowance: ReviewTaskAllowance = {
  allowanceId: 'allowance-review-child',
  taskId: 'task-review-child',
  executionId: 'execution-review-child',
  startedAt: '2026-09-18T05:00:00.000Z',
  elapsedLimitMs: 50,
  evidenceLineage: ['candidate-collected'],
};

function authorityFixture(root: string, expiresInMs = 5_000) {
  const now = Date.now();
  return createReviewAuthoritySupervisor({
    statePath: join(root, 'authority.json'),
    candidate: authorityCandidate,
    allowance: authorityAllowance,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + expiresInMs).toISOString(),
  });
}

async function waitForJson(path: string, timeoutMs = 5_000): Promise<Record<string, unknown>> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (existsSync(path)) {
      try {
        return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      } catch {
        // Atomicity is not required for the fixture's first write; retry partial reads.
      }
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  throw new Error(`Timed out waiting for ${path}`);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function waitUntilDead(pid: number, timeoutMs = 5_000): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!isAlive(pid)) return true;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  return !isAlive(pid);
}

test('follow-authority host lifetime survives the former finite timeout without a huge timer', async () => {
  const fixture = workerFixture();
  const authority = authorityFixture(fixture.source);
  writeFileSync(fixture.worker, `import { writeFileSync } from 'node:fs';
await new Promise(resolve => setTimeout(resolve, 180));
writeFileSync(process.env.BABEL_REVIEW_OUTPUT!, JSON.stringify({ completed: true }));
`);
  const started = Date.now();
  const result = await launchBabelReviewChild({
    ...fixture,
    hostLifetime: followReviewAuthorityLifetime({ pollIntervalMs: 20, cleanupTimeoutMs: 1_000 }),
    authority: authority.monitor,
    candidate: authorityCandidate,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.equal(result.artifact?.['completed'], true);
  assert.ok(Date.now() - started >= 150, 'worker must outlive the former 50ms task allowance');
  assert.equal(result.terminalCause, 'worker_exit');
});

test('controller authority loss aborts and contains a real descendant process tree', async () => {
  const fixture = workerFixture();
  const authority = authorityFixture(fixture.source);
  const marker = join(fixture.source, 'late-descendant-write.txt');
  const grandchild = join(fixture.source, 'review-grandchild.cjs');
  writeFileSync(grandchild, `const { writeFileSync } = require('node:fs');
setTimeout(() => writeFileSync(${JSON.stringify(marker)}, 'escaped'), 1200);
setInterval(() => {}, 100);
`);
  writeFileSync(fixture.worker, `import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const child = spawn(process.execPath, [${JSON.stringify(grandchild)}], { stdio: 'ignore', windowsHide: true });
writeFileSync(process.env.BABEL_REVIEW_OUTPUT!, JSON.stringify({ pid: process.pid, grandchildPid: child.pid }));
setInterval(() => {}, 100);
`);

  let grandchildPid = 0;
  try {
    const running = launchBabelReviewChild({
      ...fixture,
      // Legacy fallback keeps the pre-implementation RED run bounded. The
      // typed follow-authority lifetime takes precedence once implemented.
      timeoutMs: 2_000,
      hostLifetime: followReviewAuthorityLifetime({ pollIntervalMs: 20, cleanupTimeoutMs: 2_000 }),
      authority: authority.monitor,
      candidate: authorityCandidate,
    });
    const started = await waitForJson(fixture.output);
    grandchildPid = Number(started['grandchildPid']);
    assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 0);

    authority.controller.stop('controller_lost');
    const result = await running;
    assert.equal(result.terminalCause, 'controller_lost');
    assert.equal(result.timedOut, false);
    assert.ok(await waitUntilDead(grandchildPid), 'descendant must be dead before cleanup completes');
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_400));
    assert.equal(existsSync(marker), false, 'descendant must not escape authority-loss cleanup');
    if (process.platform === 'win32') {
      assert.equal(result.containment, 'windows_job_object', result.containmentError);
    }
    else assert.equal(result.containment, 'posix_process_group');
    assert.equal(authority.monitor.snapshot().terminalCause, 'controller_lost');
  } finally {
    if (grandchildPid > 0 && isAlive(grandchildPid)) {
      try { process.kill(grandchildPid, 'SIGKILL'); } catch { /* already exited */ }
    }
    rmSync(fixture.source, { recursive: true, force: true });
  }
});
