import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { babelReviewChildEnv, launchBabelReviewChild } from './babelReviewChild.js';

test('review child strips publication credentials, preload hooks and ambient overrides', () => {
  const env = babelReviewChildEnv({ source: '/source', trustedRoot: '/trusted', output: '/state/out', runs: '/state/runs', model: 'mimo-v2.5' }, {
    PATH: '/bin', GH_TOKEN: 'synthetic', GITHUB_TOKEN: 'synthetic', NODE_OPTIONS: '--require malicious',
    OPENAI_API_KEY: 'synthetic', BABEL_EXECUTION_PROFILE: 'dev_local', BABEL_ALLOWED_TOOLS: '["shell_exec"]',
  });
  assert.equal(env['GH_TOKEN'], undefined); assert.equal(env['GITHUB_TOKEN'], undefined);
  assert.equal(env['OPENAI_API_KEY'], undefined); assert.equal(env['NODE_OPTIONS'], undefined);
  assert.equal(env['BABEL_CHAT_MAX_COST'], 'unlimited');
  assert.equal(env['BABEL_EXECUTION_PROFILE'], 'read_only_audit');
  // A bounded review: parallel children converge quickly instead of running the
  // 120-turn / 50-minute investigate ceiling.
  assert.equal(env['BABEL_CHAT_MAX_WALL_MS'], '720000');
  assert.equal(env['BABEL_CHAT_MAX_TURNS'], '24');
  assert.equal(env['BABEL_CHAT_STALL_TURNS'], '5');
  assert.ok(!env['BABEL_ALLOWED_TOOLS']!.includes('shell_exec'));
  assert.ok(!env['BABEL_ALLOWED_TOOLS']!.includes('semantic_search'));
  assert.equal(env['BABEL_READ_ONLY_NO_INDEX_WRITE'], '1');
});

test('repair children keep the generous research budget', () => {
  const env = babelReviewChildEnv({ source: '/source', trustedRoot: '/trusted', output: '/state/out', runs: '/state/runs', model: 'deepseek-v4-flash', purpose: 'repair_proposal' });
  assert.equal(env['BABEL_CHAT_MAX_WALL_MS'], '3000000');
  assert.equal(env['BABEL_CHAT_MAX_TURNS'], undefined);
  assert.equal(env['BABEL_CHAT_STALL_TURNS'], undefined);
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
