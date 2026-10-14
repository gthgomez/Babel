/**
 * R0-11 — child mutation vs parent verifier freshness.
 *
 * An in-tree mutation child writes directly into the PARENT candidate. A prior
 * green parent verifier receipt is revision-bound to the parent's earlier
 * mutation scope; once the child's change is part of the candidate, that
 * receipt must not remain current. The worktree child is deliberately
 * different: its diff is never promoted into the parent tree, so a parent
 * receipt stays valid for the unchanged parent candidate.
 *
 * This drives the real production seam (`ChatEngine.executeOneAction` ->
 * `runMutationAgentLoop`) with the deterministic offline child, not a helper.
 */

import assert from 'node:assert/strict';
import { after, before, describe, test, mock } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ChatEngine } from './chatEngine.js';
import { WorkspaceTransactionManager } from '../services/workspaceTransactions.js';
import { hasAnyWrites, currentTurnHasMutation } from './chatEngineCriticBudget.js';
import { getChatTaskTune, type ChatTaskClass } from '../config/chatTaskClass.js';

const MODEL = 'deepseek-v4-flash';

const MANAGED_ENV = [
  'BABEL_RUNS_DIR',
  'BABEL_BENCHMARK_AUTO_APPROVE',
  'BABEL_BENCHMARK_MODE',
  'BABEL_AUTONOMY_LEASE',
  'BABEL_EXECUTION_PROFILE',
  'BABEL_ALLOW_HOST_FALLBACK',
  'BABEL_LITE_OFFLINE',
  'BABEL_IMPLEMENT_WORKTREE',
  'BABEL_DRY_RUN',
  'BABEL_DRY_RUN_SOURCE',
] as const;

let envSnapshot: Record<string, string | undefined> = {};
let runsRoot = '';

before(() => {
  envSnapshot = Object.fromEntries(MANAGED_ENV.map((key) => [key, process.env[key]]));
  runsRoot = mkdtempSync(join(tmpdir(), 'babel-r0-child-runs-'));
  process.env['BABEL_RUNS_DIR'] = runsRoot;
  process.env['BABEL_BENCHMARK_AUTO_APPROVE'] = '1';
  process.env['BABEL_BENCHMARK_MODE'] = '1';
  process.env['BABEL_AUTONOMY_LEASE'] = JSON.stringify({
    version: 2,
    leaseId: 'r0-child-freshness-lease',
    scope: { repository: 'r0-child-fixture', objective: 'child mutation freshness' },
    allowedCapabilities: [
      'inspect_repository',
      'search_repository',
      'run_arbitrary_code',
      'run_local_command',
      'run_tests',
      'edit_task_files',
    ],
  });
  process.env['BABEL_EXECUTION_PROFILE'] = 'dev_local';
  process.env['BABEL_ALLOW_HOST_FALLBACK'] = '1';
  process.env['BABEL_LITE_OFFLINE'] = '1';
  process.env['BABEL_DRY_RUN'] = 'false';
  process.env['BABEL_DRY_RUN_SOURCE'] = 'session';
});

after(() => {
  for (const key of MANAGED_ENV) {
    const previous = envSnapshot[key];
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
  rmSync(runsRoot, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${(result.stderr || result.stdout || '').trim()}`);
  }
}

function createGitProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'babel-r0-child-'));
  git(root, ['init']);
  git(root, ['config', 'user.email', 'babel-test@example.com']);
  git(root, ['config', 'user.name', 'Babel Test']);
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'main.ts'), 'export const n = 1;\n', 'utf-8');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'init']);
  return root;
}

interface EngineInternals {
  lastVerifierReceipt: { command: string; exit_code: number; stale?: boolean; staleReason?: string } | null;
  executedVerifierLedger: Array<{ command?: string; exit_code?: number; summary?: string; stale?: boolean; staleReason?: string }>;
  abortController: AbortController;
  toolCallLog: Array<{ tool: string; mutation_paths?: string[]; effect_status?: string }>;
  executeOneAction: (
    action: unknown,
    toolContext: unknown,
    callbacks: unknown,
    meta: unknown,
  ) => Promise<{ index: number; observation: string }>;
  getParityRuntime(): { sessionEvents: { events: Array<{ kind: string; paths?: string[] }> } };
}

function seedGreenReceipt(engine: ChatEngine): void {
  const internals = engine as unknown as EngineInternals;
  internals.lastVerifierReceipt = {
    command: 'npm test',
    exit_code: 0,
    stale: false,
  } as never;
  internals.executedVerifierLedger = [{ command: 'npm test', exit_code: 0, summary: 'fixture historical receipt', stale: false }];
}

async function dispatchMutationChild(
  engine: ChatEngine,
  root: string,
  callbacks: { onSubAgentStart?: () => void } = {},
): Promise<{ observation: string }> {
  const internals = engine as unknown as EngineInternals;
  const result = await internals.executeOneAction(
    { type: 'sub_agent', task: 'Write a result under src', mutation: true, write_scope: ['src'] },
    {
      agentId: 'r0-child-parent',
      runId: 'r0-child-parent',
      runDir: root,
      babelRoot: root,
      projectRoot: root,
      signal: internals.abortController.signal,
    },
    callbacks,
    { index: 0, idempotencyKey: 'call-0' },
  );
  return { observation: result.observation };
}

describe('R0-11 child mutation vs parent verifier freshness', () => {
  test('inline child mutation renews a parent read exhausted at the full-read limit', async () => {
    const root = createGitProject();
    process.env['BABEL_IMPLEMENT_WORKTREE'] = '0';
    try {
      writeFileSync(join(root, 'src/result.txt'), 'OLD_CHILD_CONTENT\n');
      for (const args of [['add', 'src/result.txt'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'seed read target']]) {
        assert.equal(spawnSync('git', args, { cwd: root, encoding: 'utf8' }).status, 0);
      }
      const engine = new ChatEngine({ task: 'Update the result under src', projectRoot: root, model: MODEL });
      const internals = engine as unknown as EngineInternals & { taskClass: ChatTaskClass; readCache: { clear(): void } };
      const context = { agentId: 'parent', runId: 'parent', runDir: root, babelRoot: root, projectRoot: root, signal: internals.abortController.signal };
      const read = () => internals.executeOneAction({ type: 'read_file', path: 'src/result.txt' }, context, {}, { index: 1 });
      for (let index = 0; index < getChatTaskTune(internals.taskClass).maxFullReadsPerFile; index++) {
        internals.readCache.clear(); // Exercise real reads after cache eviction.
        assert.match((await read()).observation, /OLD_CHILD_CONTENT/);
      }
      assert.match((await read()).observation, /read limit|full.read|already.*read/i);
      await dispatchMutationChild(engine, root);
      const expected = readFileSync(join(root, 'src/result.txt'), 'utf8');
      assert.notEqual(expected, 'OLD_CHILD_CONTENT\n');
      const refreshed = await read();
      assert.ok(refreshed.observation.includes(expected.trim()), 'changed parent bytes must reach the next read');
      assert.doesNotMatch(refreshed.observation, /read limit|already.*read/i);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test('changed isolated child is historical after parent revision moves', async () => {
    const root = createGitProject();
    process.env['BABEL_IMPLEMENT_WORKTREE'] = '1';
    try {
      const engine = new ChatEngine({ task: 'parent task', projectRoot: root, model: MODEL });
      const internals = engine as unknown as EngineInternals;
      await internals.executeOneAction({ type: 'write_file', path: 'src/main.ts', content: 'export const n = 2;\n' },
        { agentId: 'parent', runId: 'parent', runDir: root, babelRoot: root, projectRoot: root, signal: internals.abortController.signal }, {}, { index: 1, idempotencyKey: 'seed-parent' });
      const { observation } = await dispatchMutationChild(engine, root, {
        onSubAgentStart: () => writeFileSync(join(root, 'src/main.ts'), 'export const n = 3;\n'),
      });
      assert.match(observation, /superseded|stale/i);
      assert.equal(internals.toolCallLog.filter(row => (row as {effect_scope?: string}).effect_scope === 'isolated_child').length, 0);
      assert.equal(readFileSync(join(root, 'src/main.ts'), 'utf8'), 'export const n = 3;\n');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test('dirty parent dispatch revision is distinct from actual committed child base', async () => {
    const root = createGitProject();
    process.env['BABEL_IMPLEMENT_WORKTREE'] = '1';
    try {
      const base = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
      assert.equal(base.status, 0);
      const engine = new ChatEngine({ task: 'parent task', projectRoot: root, model: MODEL });
      const internals = engine as unknown as EngineInternals;
      await internals.executeOneAction({ type: 'write_file', path: 'src/main.ts', content: 'export const n = 2;\n' },
        { agentId: 'parent', runId: 'parent', runDir: root, babelRoot: root, projectRoot: root, signal: internals.abortController.signal }, {}, { index: 1, idempotencyKey: 'seed-parent' });
      const { observation } = await dispatchMutationChild(engine, root);
      assert.match(observation, /parent_dispatch_revision: [0-9a-f]+/);
      assert.ok(observation.includes(`child_base_sha: ${base.stdout.trim()}`));
      assert.doesNotMatch(observation, /parent_base_revision:/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test('isolated artifact application is a separately authorized parent transaction requiring fresh verification', async () => {
    const root = createGitProject();
    process.env['BABEL_IMPLEMENT_WORKTREE'] = '1';
    try {
      const engine = new ChatEngine({ task: 'Apply the result to src and run node --test fixture.test.mjs before completing', projectRoot: root, model: MODEL });
      seedGreenReceipt(engine);
      const { observation } = await dispatchMutationChild(engine, root);
      const worktree = observation.match(/^worktree: (.+)$/m)?.[1];
      assert.ok(worktree, 'the child reports its unapplied artifact workspace');
      const content = readFileSync(join(worktree, 'src/result.txt'), 'utf8');
      const internals = engine as unknown as EngineInternals;
      assert.equal(hasAnyWrites(internals.toolCallLog as never), false);
      assert.equal(internals.lastVerifierReceipt?.stale, false);
      const context = { agentId: 'parent', runId: 'parent-promotion', runDir: root, babelRoot: root, projectRoot: root, signal: internals.abortController.signal };
      await internals.executeOneAction({ type: 'write_file', path: 'src/result.txt', content }, context, {}, { index: 1, idempotencyKey: 'parent-apply' });
      assert.equal(readFileSync(join(root, 'src/result.txt'), 'utf8'), content);
      assert.equal(internals.lastVerifierReceipt?.stale, true);
      assert.equal(hasAnyWrites(internals.toolCallLog as never), true);
      writeFileSync(join(root, 'fixture.test.mjs'), `import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs'; assert.equal(readFileSync('src/result.txt', 'utf8'), ${JSON.stringify(content)});`);
      const verification = await internals.executeOneAction({ type: 'run_command', command: 'node --test fixture.test.mjs' }, context, {}, { index: 2, idempotencyKey: 'parent-verify' });
      assert.equal(internals.lastVerifierReceipt?.command, 'node --test fixture.test.mjs', verification.observation);
      assert.equal(internals.lastVerifierReceipt?.exit_code, 0);
      assert.equal(internals.lastVerifierReceipt?.stale ?? false, false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test('an unresolved failed child write invalidates parent verification without confirmed-change evidence', async () => {
    const root = createGitProject();
    process.env['BABEL_IMPLEMENT_WORKTREE'] = '0';
    process.env['BABEL_LITE_OFFLINE'] = '0';
    process.env['BABEL_SIMULATE_ROLLBACK_FAILURE_FOR'] = 'src/uncertain.txt';
    const undo = mock.method(WorkspaceTransactionManager, 'undoLastMutationBatch', async () => {
      throw new Error('Fixture transaction rollback unavailable');
    });
    try {
      const engine = new ChatEngine({
        task: 'parent task', projectRoot: root, model: MODEL,
        testChildLaneOverrides: {
          actionResolver: async () => [
            { type: 'write_file', path: 'src/uncertain.txt', content: 'partial' },
            { type: 'finish', summary: 'done', verification: [] },
          ],
          executor: {
            mapAction: () => [],
            execute: async action => {
              writeFileSync(join(root, 'src/uncertain.txt'), 'partial');
              return { action, terminal: false, results: [{ exit_code: 1, stdout: '', stderr: 'Fixture partial write' }] };
            },
          },
        },
      });
      seedGreenReceipt(engine);
      const { observation } = await dispatchMutationChild(engine, root);
      assert.match(observation, /indeterminate_paths: src\/uncertain.txt/);
      const internals = engine as unknown as EngineInternals;
      assert.equal(internals.lastVerifierReceipt?.stale, true);
      assert.equal(internals.toolCallLog.at(-1)?.effect_status, 'indeterminate');
      assert.deepEqual(internals.toolCallLog.at(-1)?.mutation_paths, ['src/uncertain.txt']);
    } finally {
      undo.mock.restore();
      delete process.env['BABEL_SIMULATE_ROLLBACK_FAILURE_FOR'];
      process.env['BABEL_LITE_OFFLINE'] = '1';
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('the production parent forwards its permitted host verification envelope', async () => {
    const root = createGitProject();
    process.env['BABEL_IMPLEMENT_WORKTREE'] = '0';
    process.env['BABEL_LITE_OFFLINE'] = '0';
    let verifierDispatched = false;
    try {
      const engine = new ChatEngine({
        task: 'parent task', projectRoot: root, model: MODEL,
        testChildLaneOverrides: {
          actionResolver: async () => [
            { type: 'test_run', command: 'npm test' },
            { type: 'finish', summary: 'done', verification: [] },
          ],
          executor: {
            mapAction: () => [],
            execute: async action => {
              verifierDispatched = action.type === 'test_run';
              return { action, terminal: false, results: [{ exit_code: 0, stdout: 'fixture', stderr: '' }] };
            },
          },
        },
      });
      await dispatchMutationChild(engine, root);
      assert.equal(verifierDispatched, true);
    } finally {
      process.env['BABEL_LITE_OFFLINE'] = '1';
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('an in-tree mutation child invalidates a prior green parent receipt', async () => {
    const root = createGitProject();
    process.env['BABEL_IMPLEMENT_WORKTREE'] = '0';
    try {
      const engine = new ChatEngine({
        task: 'parent task',
        projectRoot: root,
        runId: `r0-child-${Math.random().toString(36).slice(2, 10)}`,
        model: MODEL,
      });
      seedGreenReceipt(engine);

      const { observation } = await dispatchMutationChild(engine, root);
      // The in-tree lane reports the child's confirmed change as part of the
      // parent candidate (changed_files: src/result.txt).
      assert.match(observation, /changed_files:.*result\.txt/, 'the child changed the parent candidate');

      const internals = engine as unknown as EngineInternals;
      assert.equal(
        internals.lastVerifierReceipt?.stale,
        true,
        'a prior green parent receipt is stale after the child changed the candidate',
      );
      assert.match(
        internals.lastVerifierReceipt?.staleReason ?? '',
        /child mutation/,
      );
      assert.ok(
        internals.executedVerifierLedger.every((entry) => entry.stale === true),
        'the executed verifier ledger is invalidated too',
      );

      const batches = internals
        .getParityRuntime()
        .sessionEvents.events.filter((e) => e.kind === 'mutation_batch');
      assert.ok(
        batches.some((b) => (b.paths ?? []).some((p) => p.includes('result.txt'))),
        'the child change is recorded as a mutation batch for evidence reconstruction',
      );
    } finally {
      spawnSync('git', ['worktree', 'prune'], { cwd: root, encoding: 'utf-8' });
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a worktree mutation child leaves the parent candidate (and receipt) unchanged', async () => {
    const root = createGitProject();
    process.env['BABEL_IMPLEMENT_WORKTREE'] = '1';
    try {
      const engine = new ChatEngine({
        task: 'parent task',
        projectRoot: root,
        runId: `r0-child-wt-${Math.random().toString(36).slice(2, 10)}`,
        model: MODEL,
      });
      seedGreenReceipt(engine);

      await dispatchMutationChild(engine, root);
      const internals = engine as unknown as EngineInternals;
      assert.equal(hasAnyWrites(internals.toolCallLog as never), false, 'isolated effects are not parent writes');
      assert.equal(currentTurnHasMutation(internals.toolCallLog as never, 0), false, 'isolated effects are not parent progress');
      assert.equal((internals.toolCallLog.at(-1) as any)?.effect_scope, 'isolated_child');
      assert.equal(internals.getParityRuntime().sessionEvents.events.filter(e => e.kind === 'mutation_batch').length, 0);
      assert.equal(
        internals.lastVerifierReceipt?.stale ?? false,
        false,
        'the worktree child never promotes into the parent tree, so the parent receipt stays current',
      );
      assert.equal(
        readFileSync(join(root, 'src', 'main.ts'), 'utf8'),
        'export const n = 1;\n',
        'the parent tree is physically unchanged by the worktree child',
      );
    } finally {
      spawnSync('git', ['worktree', 'prune'], { cwd: root, encoding: 'utf-8' });
      rmSync(root, { recursive: true, force: true });
    }
  });
});
