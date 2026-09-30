/**
 * R0-8 — real late Task-A completion after Task B begins.
 *
 * The existing S07 Scenario 8 proves fresh-task *state* resets and injects a
 * late event through a helper. It never lets a genuine asynchronous operation
 * from Task A resolve while Task B owns the engine. This suite drives the real
 * production lifecycle:
 *
 *   Task A (real streaming submission) launches a real child whose executor is
 *   paused on an explicit deferred latch -> Task A is cancelled -> Task B is
 *   submitted and runs to completion as the owner -> the latch is released,
 *   letting A's delayed child completion land after ownership changed.
 *
 * Invariant: obsolete Task-A work cannot alter Task B's ownership, terminal
 * decision, verifier authority, budget, tool-call identity, or working state.
 * Physical effects that happened before cancellation remain real and are not
 * hidden.
 *
 * Model: babel-cli/src/agent/s07OrdinaryLoop.test.ts (Scenario 8)
 */

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ChatEngine, type ChatEvent } from './chatEngine.js';
import type { AgentAction } from './actions.js';
import type { ToolResult } from '../localTools.js';
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
  runsRoot = mkdtempSync(join(tmpdir(), 'babel-r0-late-runs-'));
  process.env['BABEL_RUNS_DIR'] = runsRoot;
  process.env['BABEL_BENCHMARK_AUTO_APPROVE'] = '1';
  process.env['BABEL_BENCHMARK_MODE'] = '1';
  // Direct child dispatch does not establish the session baseline an active
  // lease requires; the child-lane qualification uses the same no-lease setup.
  delete process.env['BABEL_AUTONOMY_LEASE'];
  process.env['BABEL_EXECUTION_PROFILE'] = 'dev_local';
  process.env['BABEL_ALLOW_HOST_FALLBACK'] = '1';
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
  const root = mkdtempSync(join(tmpdir(), 'babel-r0-late-'));
  git(root, ['init']);
  git(root, ['config', 'user.email', 'babel-test@example.com']);
  git(root, ['config', 'user.name', 'Babel Test']);
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'main.ts'), 'export const n = 1;\n', 'utf-8');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'init']);
  return root;
}

/**
 * Deterministic executor whose first call performs a real disk effect and then
 * pauses on an explicit latch. The latch is NOT raced with the abort signal,
 * so cancellation cannot settle it — this is the genuine late completion.
 */
function gatedExecutor(
  root: string,
  gate: { promise: Promise<void> },
  started: { resolve: () => void },
): {
  mapAction(action: AgentAction): Array<{ kind: 'execute' | 'terminal'; request?: unknown }>;
  execute(action: AgentAction): Promise<{ action: AgentAction; terminal: boolean; results: ToolResult[] }>;
} {
  let first = true;
  return {
    mapAction(action) {
      if (action.type === 'finish' || action.type === 'ask_approval') {
        return [{ kind: 'terminal' as const }];
      }
      return [{ kind: 'execute' as const }];
    },
    async execute(action) {
      if (action.type === 'finish' || action.type === 'ask_approval') {
        return { action, terminal: true, results: [] };
      }
      if (first) {
        first = false;
        // A real physical effect that happens before cancellation and must
        // remain visible afterwards.
        writeFileSync(join(root, 'src', 'late-a.txt'), 'task-a late effect\n', 'utf8');
        started.resolve();
        await gate.promise;
      }
      return {
        action,
        terminal: false,
        results: [{ exit_code: 0, stdout: 'inspected', stderr: '' }],
      };
    },
  };
}

// ── Mutable scripted provider ───────────────────────────────────────────────

type Script = Array<ToolStreamEvent[]>;

interface MutableRunner {
  setScript(script: Script): void;
}

function installMutableRunner(engine: ChatEngine): MutableRunner {
  let script: Script = [];
  let base = 0;
  let call = 0;
  const runner = {
    setScript(next: Script) {
      script = next;
      base = call;
    },
    async *executeWithToolsStream(): AsyncGenerator<ToolStreamEvent, void, undefined> {
      const index = call;
      call += 1;
      const events = script[index - base] ?? [
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
  return runner as unknown as MutableRunner;
}

interface EngineInternals {
  toolCallLog: Array<{ tool: string; target: string; mutation_paths?: string[] }>;
  terminatingLimiter: string | null;
  lastVerifierReceipt: unknown;
  _cancelled: boolean;
  getParityRuntime(): { sessionEvents: { events: Array<{ kind: string }> } };
}

function internals(engine: ChatEngine): EngineInternals {
  return engine as unknown as EngineInternals;
}

function terminals(events: ChatEvent[]): ChatEvent[] {
  return events.filter((e) => e.type === 'done' || e.type === 'failed' || e.type === 'cancelled');
}

describe('R0-8 real late Task-A completion after Task B begins', () => {
  test('a cancelled Task A child that completes while Task B is active cannot corrupt B', async () => {
    const root = createGitProject();
    try {
      const childStarted = deferred();
      const childGate = deferred();
      const childResolver = async (): Promise<AgentAction[]> => [
        { type: 'read_file', path: 'src/main.ts' },
      ];

      const engine = new ChatEngine({
        task: 'Task A',
        projectRoot: root,
        runId: `r0-late-${Math.random().toString(36).slice(2, 10)}`,
        model: MODEL,
        testChildLaneOverrides: {
          useDeterministicMock: false,
          actionResolver: childResolver,
          executor: gatedExecutor(root, childGate, {
            resolve: () => childStarted.resolve(),
          }) as never,
        },
      });
      const runner = installMutableRunner(engine);

      // ── Task A: real submission that delegates to a paused child.
      runner.setScript([
        [
          {
            type: 'tool_use',
            id: 'a-child',
            name: 'sub_agent',
            input: { task: 'inspect the module', mutation: false },
          },
          { type: 'done', finishReason: 'tool_calls' },
        ],
        [{ type: 'text_delta', text: 'A concluding.' }, { type: 'done', finishReason: 'stop' }],
      ]);
      const aEvents: ChatEvent[] = [];
      const pumpA = (async () => {
        for await (const event of engine.submitMessageStream('Task A: inspect the module.')) {
          aEvents.push(event);
        }
      })();

      await childStarted.promise;
      assert.equal(existsSync(join(root, 'src', 'late-a.txt')), true, 'A physical effect precedes cancel');

      // ── Cancel Task A and release ownership.
      engine.cancel();

      // ── Task B: unrelated task on the same live engine/session.
      runner.setScript([
        [
          { type: 'tool_use', id: 'b-read', name: 'read_file', input: { path: 'src/main.ts' } },
          { type: 'done', finishReason: 'tool_calls' },
        ],
        [{ type: 'text_delta', text: 'Repository inventory complete.' }, { type: 'done', finishReason: 'stop' }],
      ]);
      const bEvents: ChatEvent[] = [];
      for await (const event of engine.submitMessageStream('Task B: inventory only. Do not edit files.')) {
        bEvents.push(event);
      }
      const bTerminal = bEvents[bEvents.length - 1] as Extract<ChatEvent, { type: 'done' }>;
      assert.equal(bTerminal.type, 'done', 'Task B owns the engine and completes normally');

      // ── Release A's delayed completion now that B is the owner.
      childGate.resolve();
      await pumpA;

      // B's terminal decision is its own and singular.
      assert.equal(bTerminal.outcome !== undefined, true, 'Task B has its own terminal outcome');
      assert.notEqual(bTerminal.outcome, 'VERIFIED_COMPLETE', 'Task B claims no unearned verification');
      assert.equal(terminals(aEvents).length, 0, 'the superseded Task A emits no terminal for Task B');
      assert.equal(
        terminals([...aEvents, ...bEvents]).length,
        1,
        'exactly one terminal result exists across both tasks',
      );

      // B's ownership and authority are untouched by late A work.
      const state = internals(engine);
      assert.equal(state.terminatingLimiter, null, 'late A cannot install a terminal limiter on B');
      assert.equal(state._cancelled, false, 'late A cannot cancel B');
      assert.equal(state.lastVerifierReceipt, null, 'late A installed no verifier authority on B');
      assert.equal(
        state.toolCallLog.some((entry) => entry.tool === 'sub_agent'),
        false,
        'late A child never enters B tool log or tool-call identity',
      );
      assert.equal(
        state
          .getParityRuntime()
          .sessionEvents.events.filter((event) => event.kind === 'mutation_batch')
          .length,
        0,
        'late A mints no current mutation batch',
      );

      // Historical disk state is preserved and distinct from current authority.
      assert.equal(
        readFileSync(join(root, 'src', 'late-a.txt'), 'utf8'),
        'task-a late effect\n',
        'pre-cancel physical effect remains real',
      );
    } finally {
      spawnSync('git', ['worktree', 'prune'], { cwd: root, encoding: 'utf-8' });
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('negative control: a child that completes while its Task is current settles normally', async () => {
    const root = createGitProject();
    try {
      const childStarted = deferred();
      const childGate = deferred();
      const childResolver = async (): Promise<AgentAction[]> => [
        { type: 'read_file', path: 'src/main.ts' },
      ];
      const engine = new ChatEngine({
        task: 'Task A',
        projectRoot: root,
        runId: `r0-late-ctrl-${Math.random().toString(36).slice(2, 10)}`,
        model: MODEL,
        testChildLaneOverrides: {
          useDeterministicMock: false,
          actionResolver: childResolver,
          executor: gatedExecutor(root, childGate, {
            resolve: () => childStarted.resolve(),
          }) as never,
        },
      });
      const runner = installMutableRunner(engine);
      runner.setScript([
        [
          {
            type: 'tool_use',
            id: 'a-child',
            name: 'sub_agent',
            input: { task: 'inspect the module', mutation: false },
          },
          { type: 'done', finishReason: 'tool_calls' },
        ],
        [{ type: 'text_delta', text: 'A concluding.' }, { type: 'done', finishReason: 'stop' }],
      ]);
      const pumpA = (async () => {
        for await (const _event of engine.submitMessageStream('Task A: inspect the module.')) {
          /* drain */
        }
      })();
      await childStarted.promise;
      // Release while Task A is still current: the child appends normally.
      childGate.resolve();
      await pumpA;
      const state = internals(engine);
      assert.equal(state._cancelled, false, 'a normal completion does not cancel the task');
      assert.equal(
        state.toolCallLog.some((entry) => entry.tool === 'sub_agent'),
        true,
        'a current child is recorded normally',
      );
    } finally {
      spawnSync('git', ['worktree', 'prune'], { cwd: root, encoding: 'utf-8' });
      rmSync(root, { recursive: true, force: true });
    }
  });
});
