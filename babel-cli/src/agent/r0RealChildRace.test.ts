/**
 * R0-7 — real parent/child stale-result race.
 *
 * The existing S07 Scenario 7 coverage attributes child results, child
 * failures, write_scope and the basic stale-attribution helper. It never
 * pauses a real child and lets the parent candidate/submission move while the
 * child is still in flight. This suite drives the real production lifecycle
 * (`ChatEngine.executeOneAction` -> `runMutationAgentLoop` /
 * `runReadOnlyAgentLoop`) with an explicit deferred latch, then releases the
 * child only after the parent has moved.
 *
 * Invariant: a child result produced against an older parent candidate must
 * remain historical evidence. It must not become current verifier authority,
 * satisfy the current completion gate, mint current mutation attribution,
 * spend the current task's budget, or enter the current tool log.
 *
 * Model: babel-cli/src/agent/r0ChildMutationFreshness.test.ts
 */

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ChatEngine, type ChatEvent } from './chatEngine.js';
import type { AgentAction } from './actions.js';
import type { ToolStreamEvent } from '../runners/base.js';

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
  runsRoot = mkdtempSync(join(tmpdir(), 'babel-r0-child-race-runs-'));
  process.env['BABEL_RUNS_DIR'] = runsRoot;
  process.env['BABEL_BENCHMARK_AUTO_APPROVE'] = '1';
  process.env['BABEL_BENCHMARK_MODE'] = '1';
  // This suite drives child lanes directly; an active lease requires a captured
  // session baseline that direct child dispatch does not establish. The
  // existing child-lane qualification uses the same no-lease setup.
  delete process.env['BABEL_AUTONOMY_LEASE'];
  process.env['BABEL_EXECUTION_PROFILE'] = 'dev_local';
  process.env['BABEL_ALLOW_HOST_FALLBACK'] = '1';
  // The injected actionResolver replaces the offline deterministic mock, so the
  // latch is controlled by the test rather than by the mock plan.
  delete process.env['BABEL_LITE_OFFLINE'];
  process.env['BABEL_IMPLEMENT_WORKTREE'] = '0';
});

after(() => {
  for (const key of MANAGED_ENV) {
    const previous = envSnapshot[key];
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
  rmSync(runsRoot, { recursive: true, force: true });
});

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function git(cwd: string, args: string[]): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${(result.stderr || result.stdout || '').trim()}`);
  }
}

function createGitProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'babel-r0-child-race-'));
  git(root, ['init']);
  git(root, ['config', 'user.email', 'babel-test@example.com']);
  git(root, ['config', 'user.name', 'Babel Test']);
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'main.ts'), 'export const n = 1;\n', 'utf-8');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'init']);
  return root;
}

// ── Minimal scripted provider (for the unrelated Task B) ─────────────────────

type Script = Array<ToolStreamEvent[]>;

function installRunner(engine: ChatEngine, script: Script): void {
  let call = 0;
  const runner = {
    async *executeWithToolsStream(): AsyncGenerator<ToolStreamEvent, void, undefined> {
      const index = call;
      call += 1;
      const events = script[index] ?? [
        { type: 'text_delta' as const, text: 'Inventory complete.' },
        { type: 'done' as const, finishReason: 'stop' },
      ];
      for (const event of events) yield event;
    },
    async execute() {
      return { type: 'completion', answer: 'scripted completion' };
    },
    async executeRaw() {
      return 'scripted completion';
    },
    getLastInvocationMetadata() {
      return null;
    },
  };
  const anyEngine = engine as unknown as {
    deliberationRunner: unknown;
    synthesisRunner: unknown;
    shouldUseNativeTools: () => boolean;
  };
  anyEngine.deliberationRunner = runner;
  anyEngine.synthesisRunner = runner;
  anyEngine.shouldUseNativeTools = () => true;
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
  getParityRuntime(): { sessionEvents: { events: Array<{ kind: string; paths?: string[]; turn_id?: string }> } };
}

function internals(engine: ChatEngine): EngineInternals {
  return engine as unknown as EngineInternals;
}

function childToolContext(engine: ChatEngine, root: string) {
  return {
    agentId: 'r0-race-parent',
    runId: 'r0-race-parent',
    runDir: root,
    babelRoot: root,
    projectRoot: root,
    signal: internals(engine).abortController.signal,
  };
}

async function drainB(engine: ChatEngine, task: string): Promise<ChatEvent[]> {
  const events: ChatEvent[] = [];
  for await (const event of engine.submitMessageStream(task)) events.push(event);
  return events;
}

describe('R0-7 real parent/child stale-result race', () => {
  test('a mutation child paused before the parent moves cannot apply to the superseded parent', async () => {
    const root = createGitProject();
    try {
      const childWrote = deferred();
      const childGate = deferred();
      let round = 0;
      const childResolver = async (): Promise<AgentAction[]> => {
        round += 1;
        if (round === 1) {
          return [{ type: 'write_file', path: 'src/child.txt', content: 'child output\n' }];
        }
        // Signal the test that the child has written and is now paused, then
        // block on an explicit latch — no sleeps as an ordering mechanism.
        childWrote.resolve();
        await childGate.promise;
        return [{ type: 'finish', summary: 'child complete', verification: [] }];
      };

      const engine = new ChatEngine({
        task: 'parent task',
        projectRoot: root,
        runId: `r0-race-${Math.random().toString(36).slice(2, 10)}`,
        model: MODEL,
        testChildLaneOverrides: {
          useDeterministicMock: false,
          actionResolver: childResolver,
        },
      });

      // Task A launches a real in-tree mutation child against candidate P0.
      const childPromise = internals(engine).executeOneAction(
        { type: 'sub_agent', task: 'write a child artifact', mutation: true, write_scope: ['src'] },
        childToolContext(engine, root),
        {},
        { index: 0, idempotencyKey: 'call-a-child' },
      );

      // The child has written into the parent candidate and is now paused
      // before publishing completion.
      await childWrote.promise;
      assert.equal(existsSync(join(root, 'src', 'child.txt')), true, 'child write is a real disk effect');

      // Parent moves to P1: an unrelated read-only task B takes ownership of
      // the engine (new submission generation).
      installRunner(engine, [
        [
          { type: 'tool_use', id: 'b-read', name: 'read_file', input: { path: 'src/main.ts' } },
          { type: 'done', finishReason: 'tool_calls' },
        ],
        [{ type: 'text_delta', text: 'Repository inventory complete.' }, { type: 'done', finishReason: 'stop' }],
      ]);
      const bEvents = await drainB(engine, 'Inventory the repository. Do not edit files.');
      const bTerminal = bEvents[bEvents.length - 1] as Extract<ChatEvent, { type: 'done' }>;
      assert.equal(bTerminal.type, 'done', 'task B owns the engine and completes');

      // Release the stale child now that B owns the engine.
      childGate.resolve();
      const childResult = await childPromise;

      // 1. The stale child is returned as historical evidence only.
      assert.match(childResult.observation, /stale_result/, 'stale child is marked, not applied');
      assert.match(childResult.observation, /child_stale_result/);
      assert.doesNotMatch(
        childResult.observation,
        /changed_files:.*child\.txt/,
        'the stale child does not present its change as a current result',
      );

      // 2. The physical child write remains real and historical.
      assert.equal(
        readFileSync(join(root, 'src', 'child.txt'), 'utf8'),
        'child output\n',
        'historical disk state is preserved, not hidden',
      );

      // 3. The stale child did not become current authority on B.
      const engineState = internals(engine);
      assert.equal(engineState.lastVerifierReceipt, null, 'stale child installed no verifier authority');
      assert.equal(engine.getWriteCount(), 0, 'stale child added no current mutation');
      assert.equal(
        engineState.toolCallLog.some((entry) => entry.mutation_paths?.some((p) => p.includes('child.txt'))),
        false,
        'stale child minted no current mutation attribution row',
      );
      assert.equal(
        engineState.toolCallLog.some((entry) => entry.tool === 'sub_agent'),
        false,
        'stale child was not recorded in the current task tool log',
      );
      const mutationBatches = engineState
        .getParityRuntime()
        .sessionEvents.events.filter((event) => event.kind === 'mutation_batch');
      assert.equal(
        mutationBatches.some((batch) => (batch.paths ?? []).some((p) => p.includes('child.txt'))),
        false,
        'stale child minted no current mutation batch for evidence reconstruction',
      );
      assert.notEqual(bTerminal.outcome, 'VERIFIED_COMPLETE', 'task B claims no unearned verification');
    } finally {
      spawnSync('git', ['worktree', 'prune'], { cwd: root, encoding: 'utf-8' });
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('negative control: a mutation child that completes while still current applies normally', async () => {
    const root = createGitProject();
    try {
      const childResolver = async (): Promise<AgentAction[]> => [
        { type: 'write_file', path: 'src/current.txt', content: 'current output\n' },
        { type: 'finish', summary: 'current child complete', verification: [] },
      ];
      const engine = new ChatEngine({
        task: 'parent task',
        projectRoot: root,
        runId: `r0-race-current-${Math.random().toString(36).slice(2, 10)}`,
        model: MODEL,
        testChildLaneOverrides: { useDeterministicMock: false, actionResolver: childResolver },
      });
      // Seed a green receipt in the current (same) submission scope.
      internals(engine).lastVerifierReceipt = {
        command: 'npm test',
        exit_code: 0,
        stale: false,
      } as never;
      internals(engine).executedVerifierLedger = [{ stale: false }];

      const childPromise = internals(engine).executeOneAction(
        { type: 'sub_agent', task: 'write a child artifact', mutation: true, write_scope: ['src'] },
        childToolContext(engine, root),
        {},
        { index: 0, idempotencyKey: 'call-current-child' },
      );
      const childResult = await childPromise;

      assert.doesNotMatch(childResult.observation, /stale_result/, 'a current child is not marked stale');
      assert.match(childResult.observation, /changed_files:.*current\.txt/, 'the current child change is applied');
      const engineState = internals(engine);
      assert.equal(
        engineState.lastVerifierReceipt?.stale,
        true,
        'a current in-tree child still invalidates the parent receipt (R0-11 preserved)',
      );
      assert.ok(
        engineState
          .getParityRuntime()
          .sessionEvents.events.filter((event) => event.kind === 'mutation_batch')
          .some((batch) => (batch.paths ?? []).some((p) => p.includes('current.txt'))),
        'a current child still records its mutation batch',
      );
    } finally {
      spawnSync('git', ['worktree', 'prune'], { cwd: root, encoding: 'utf-8' });
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('negative control: a read-only child whose revision did not move applies normally', async () => {
    const root = createGitProject();
    try {
      const childStarted = deferred();
      const childGate = deferred();
      const childResolver = async (): Promise<AgentAction[]> => {
        childStarted.resolve();
        await childGate.promise;
        return [{ type: 'finish', summary: 'read-only child complete', verification: [] }];
      };
      const engine = new ChatEngine({
        task: 'parent task',
        projectRoot: root,
        runId: `r0-race-readonly-${Math.random().toString(36).slice(2, 10)}`,
        model: MODEL,
        testChildLaneOverrides: { useDeterministicMock: false, actionResolver: childResolver },
      });
      const childPromise = internals(engine).executeOneAction(
        { type: 'sub_agent', task: 'inspect the module', mutation: false },
        childToolContext(engine, root),
        {},
        { index: 0, idempotencyKey: 'call-readonly-current' },
      );
      await childStarted.promise;
      childGate.resolve();
      const childResult = await childPromise;
      assert.doesNotMatch(childResult.observation, /stale_result/, 'an unchanged revision is not stale');
      assert.equal(
        internals(engine).toolCallLog.some((entry) => entry.tool === 'sub_agent'),
        true,
        'a current read-only child is recorded normally',
      );
    } finally {
      spawnSync('git', ['worktree', 'prune'], { cwd: root, encoding: 'utf-8' });
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a read-only child released after the parent candidate revision moved is stale', async () => {
    const root = createGitProject();
    try {
      const childStarted = deferred();
      const childGate = deferred();
      const childResolver = async (): Promise<AgentAction[]> => {
        childStarted.resolve();
        await childGate.promise;
        return [{ type: 'finish', summary: 'read-only child complete', verification: [] }];
      };
      const engine = new ChatEngine({
        task: 'parent task',
        projectRoot: root,
        runId: `r0-race-revision-${Math.random().toString(36).slice(2, 10)}`,
        model: MODEL,
        testChildLaneOverrides: { useDeterministicMock: false, actionResolver: childResolver },
      });
      const childPromise = internals(engine).executeOneAction(
        { type: 'sub_agent', task: 'inspect the module', mutation: false },
        childToolContext(engine, root),
        {},
        { index: 0, idempotencyKey: 'call-readonly-stale' },
      );
      await childStarted.promise;

      // The parent candidate moves while the child is paused (same submission,
      // different revision — the revision binding is what must catch this).
      await internals(engine).executeOneAction(
        {
          type: 'str_replace',
          file_path: 'src/main.ts',
          old_str: 'export const n = 1;',
          new_str: 'export const n = 2;',
        },
        childToolContext(engine, root),
        {},
        { index: 1, idempotencyKey: 'call-parent-write' },
      );

      childGate.resolve();
      const childResult = await childPromise;
      assert.match(
        childResult.observation,
        /stale_result/,
        'a child whose base revision moved must be rejected on revision mismatch',
      );
      assert.equal(
        internals(engine).toolCallLog.some((entry) => entry.tool === 'sub_agent'),
        false,
        'the revision-stale child is not recorded in the current tool log',
      );
    } finally {
      spawnSync('git', ['worktree', 'prune'], { cwd: root, encoding: 'utf-8' });
      rmSync(root, { recursive: true, force: true });
    }
  });
});
