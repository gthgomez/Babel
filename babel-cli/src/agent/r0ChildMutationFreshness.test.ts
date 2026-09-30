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
import { after, before, describe, test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ChatEngine } from './chatEngine.js';

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
  executedVerifierLedger: Array<{ stale?: boolean; staleReason?: string }>;
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
  internals.executedVerifierLedger = [{ stale: false }];
}

async function dispatchMutationChild(
  engine: ChatEngine,
  root: string,
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
    {},
    { index: 0, idempotencyKey: 'call-0' },
  );
  return { observation: result.observation };
}

describe('R0-11 child mutation vs parent verifier freshness', () => {
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
