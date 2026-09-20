/**
 * R0-8 — superseded in-turn terminal ownership.
 *
 * The child-lane race in `r0LateTaskRace.test.ts` proves a late child result
 * cannot apply to the new task. This suite covers the other half of the same
 * invariant: a superseded Task A whose provider stream is still suspended must
 * not emit a terminal or finalize the task that now owns the engine.
 *
 * Ordering is explicit (deferred latches, no sleeps):
 *   A starts and blocks inside its provider stream
 *   -> engine.cancel()
 *   -> Task B starts and blocks mid-turn (B's parity turn is open)
 *   -> A's aborted provider rejects while B is still mid-turn
 *   -> B is released
 *
 * Before the repair, A's catch reached `emitCancelledIfOperatorAbort` ->
 * `streamCancelled` -> `finalizeParityCancel` against the *live* parity (B),
 * so B's durable `turn_ended` was recorded CANCELLED even though B returned a
 * normal `done`. This test drives that exact production path.
 */

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ChatEngine, type ChatEvent } from './chatEngine.js';
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
  'BABEL_DIFF_CRITIC',
] as const;

let envSnapshot: Record<string, string | undefined> = {};
let runsRoot = '';

before(() => {
  envSnapshot = Object.fromEntries(MANAGED_ENV.map((key) => [key, process.env[key]]));
  runsRoot = mkdtempSync(join(tmpdir(), 'babel-r0-terminal-owner-runs-'));
  process.env['BABEL_RUNS_DIR'] = runsRoot;
  process.env['BABEL_BENCHMARK_AUTO_APPROVE'] = '1';
  process.env['BABEL_BENCHMARK_MODE'] = '1';
  delete process.env['BABEL_AUTONOMY_LEASE'];
  process.env['BABEL_EXECUTION_PROFILE'] = 'dev_local';
  process.env['BABEL_ALLOW_HOST_FALLBACK'] = '1';
  delete process.env['BABEL_LITE_OFFLINE'];
  process.env['BABEL_IMPLEMENT_WORKTREE'] = '0';
  // Enable the last-chance diff critic so the budget-kill suspension point is
  // reachable deterministically (the critic itself is stubbed per test).
  process.env['BABEL_DIFF_CRITIC'] = '1';
});

after(() => {
  for (const key of MANAGED_ENV) {
    const previous = envSnapshot[key];
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
  rmSync(runsRoot, { recursive: true, force: true });
});

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function git(cwd: string, args: string[]): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${(result.stderr || result.stdout || '').trim()}`);
  }
}

function createGitProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'babel-r0-terminal-owner-'));
  git(root, ['init']);
  git(root, ['config', 'user.email', 'babel-test@example.com']);
  git(root, ['config', 'user.name', 'Babel Test']);
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'main.ts'), 'export const n = 1;\n', 'utf-8');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'init']);
  return root;
}

interface ScriptedRunner {
  executeWithToolsStream: (...args: unknown[]) => AsyncGenerator<ToolStreamEvent, void, undefined>;
  execute: () => Promise<{ type: string; answer: string }>;
  executeRaw: () => Promise<string>;
  getLastInvocationMetadata: () => null;
}

function installRunner(engine: ChatEngine, runner: ScriptedRunner): void {
  const box = engine as unknown as {
    deliberationRunner: unknown;
    synthesisRunner: unknown;
    shouldUseNativeTools: () => boolean;
  };
  box.deliberationRunner = runner;
  box.synthesisRunner = runner;
  box.shouldUseNativeTools = () => true;
}

function terminals(events: ChatEvent[]): ChatEvent[] {
  return events.filter((event) => event.type === 'done' || event.type === 'failed' || event.type === 'cancelled');
}

test('a superseded Task A provider abort cannot finalize Task B', async () => {
  const root = createGitProject();
  const startedA = deferred();
  const gateA = deferred();
  const startedB = deferred();
  const gateB = deferred();
  let call = 0;
  const runner: ScriptedRunner = {
    async *executeWithToolsStream(...args: unknown[]) {
      const index = call;
      call += 1;
      const signal = args[3] as AbortSignal | undefined;
      if (index === 0) {
        startedA.resolve();
        await gateA.promise;
        void signal;
        const error = new Error('operation was aborted');
        (error as { name?: string }).name = 'AbortError';
        throw error;
      }
      startedB.resolve();
      await gateB.promise;
      yield { type: 'text_delta' as const, text: 'B final answer' };
      yield { type: 'done' as const, finishReason: 'stop' };
    },
    async execute() {
      return { type: 'completion', answer: 'scripted' };
    },
    async executeRaw() {
      return 'scripted';
    },
    getLastInvocationMetadata() {
      return null;
    },
  };

  try {
    const engine = new ChatEngine({
      task: 'Task A',
      projectRoot: root,
      runId: `r0-terminal-owner-${Math.random().toString(36).slice(2, 10)}`,
      model: MODEL,
    });
    installRunner(engine, runner);

    const aEvents: ChatEvent[] = [];
    const pumpA = (async () => {
      for await (const event of engine.submitMessageStream('Task A: do a thing.')) {
        aEvents.push(event);
      }
    })();
    await startedA.promise;

    // Cancel A while its provider stream is still suspended.
    engine.cancel();

    // Task B starts and blocks mid-turn, so B's parity turn is open.
    const bEvents: ChatEvent[] = [];
    const pumpB = (async () => {
      for await (const event of engine.submitMessageStream('Task B: inventory only.')) {
        bEvents.push(event);
      }
    })();
    await startedB.promise;

    // Release A's aborted provider while B is still mid-turn.
    gateA.resolve();
    await pumpA;

    // Release B.
    gateB.resolve();
    await pumpB;

    const bTerminal = bEvents[bEvents.length - 1] as Extract<ChatEvent, { type: 'done' }>;
    assert.equal(bTerminal.type, 'done', 'Task B completes normally');
    assert.notEqual(bTerminal.outcome, 'CANCELLED', 'Task B is not spuriously cancelled by late Task A');
    assert.equal(terminals(aEvents).length, 0, 'the superseded Task A emits no terminal of its own');
    assert.equal(
      terminals([...aEvents, ...bEvents]).length,
      1,
      'exactly one terminal result exists across both tasks',
    );

    // B's durable turn must record B's own outcome, not A's cancel.
    const bTurnId = (
      bTerminal as unknown as { turnTelemetry?: { turnId?: string } }
    ).turnTelemetry?.turnId;
    assert.ok(bTurnId, 'Task B terminal carries its turn id');
    const bTurnEnded = engine
      .getParityEventLog()
      .events.filter((event) => event.kind === 'turn_ended' && event.turn_id === bTurnId);
    assert.equal(bTurnEnded.length, 1, 'Task B ends its own turn exactly once');
    assert.notEqual(
      (bTurnEnded[0] as { outcome?: string }).outcome,
      'CANCELLED',
      'Task B durable turn outcome is its own, not a stale Task A cancel',
    );
    assert.equal(
      (engine as unknown as { _cancelled: boolean })._cancelled,
      false,
      'a superseded cancel does not leave the engine cancelled for Task B',
    );
  } finally {
    spawnSync('git', ['worktree', 'prune'], { cwd: root, encoding: 'utf-8' });
    rmSync(root, { recursive: true, force: true });
  }
});

test('a superseded non-stream Task A cannot finalize streaming Task B', async () => {
  const root = createGitProject();
  const gateA = deferred();
  const startedA = deferred();
  const gateB = deferred();
  const startedB = deferred();
  let call = 0;
  const runner: ScriptedRunner = {
    async *executeWithToolsStream() {
      const index = call;
      call += 1;
      if (index === 0) {
        startedA.resolve();
        await gateA.promise;
        yield { type: 'text_delta' as const, text: 'A final answer' };
        yield { type: 'done' as const, finishReason: 'stop' };
        return;
      }
      startedB.resolve();
      await gateB.promise;
      yield { type: 'text_delta' as const, text: 'B final answer' };
      yield { type: 'done' as const, finishReason: 'stop' };
    },
    async execute() {
      return { type: 'completion', answer: 'scripted' };
    },
    async executeRaw() {
      return 'scripted';
    },
    getLastInvocationMetadata() {
      return null;
    },
  };

  try {
    const engine = new ChatEngine({
      task: 'Task A',
      projectRoot: root,
      runId: `r0-nonstream-owner-${Math.random().toString(36).slice(2, 10)}`,
      model: MODEL,
    });
    installRunner(engine, runner);

    // Task A through the non-stream adapter.
    const aPromise = engine.submitMessage('Task A: do a thing.', {});
    await startedA.promise;

    // Task B streaming starts while A is suspended in its provider.
    const bEvents: ChatEvent[] = [];
    const pumpB = (async () => {
      for await (const event of engine.submitMessageStream('Task B: inventory only.')) {
        bEvents.push(event);
      }
    })();
    await startedB.promise;

    // Release A. Its generator is superseded and returns with no terminal, so
    // the adapter must not finalize Task B as a "stream ended" failure.
    gateA.resolve();
    await aPromise;

    gateB.resolve();
    await pumpB;

    const bTerminal = bEvents[bEvents.length - 1] as Extract<ChatEvent, { type: 'done' }>;
    assert.equal(bTerminal.type, 'done', 'Task B completes normally');
    assert.equal(bTerminal.status, 'completed', 'Task B status is its own, not a stale failure');
    const bTurnId = (bTerminal as unknown as { turnTelemetry?: { turnId?: string } }).turnTelemetry
      ?.turnId;
    assert.ok(bTurnId, 'Task B terminal carries its turn id');
    const bTurnEnded = engine
      .getParityEventLog()
      .events.filter((event) => event.kind === 'turn_ended' && event.turn_id === bTurnId);
    assert.equal(bTurnEnded.length, 1, 'Task B ends its own turn exactly once');
    assert.equal(
      (bTurnEnded[0] as { status?: string }).status,
      'completed',
      'Task B durable turn status is its own, not a stale stream-without-terminal failure',
    );
  } finally {
    spawnSync('git', ['worktree', 'prune'], { cwd: root, encoding: 'utf-8' });
    rmSync(root, { recursive: true, force: true });
  }
});

/** Fixture with an uncommitted change so the last-chance diff critic sees a patch. */
function createModifiedGitProject(): string {
  const root = createGitProject();
  writeFileSync(
    join(root, 'src', 'main.ts'),
    'export const n = 1;\nexport function helper(x: number): number {\n  return x + 1;\n}\n',
    'utf-8',
  );
  return root;
}

test('a superseded Task A handleBudgetKill cannot finalize Task B', async () => {
  const root = createModifiedGitProject();
  const criticStarted = deferred();
  const gateCritic = deferred();
  const gateB = deferred();
  const startedB = deferred();
  let call = 0;
  const runner: ScriptedRunner = {
    async *executeWithToolsStream() {
      const index = call;
      call += 1;
      if (index > 0) throw new Error('unexpected extra provider stream');
      startedB.resolve();
      await gateB.promise;
      yield { type: 'text_delta' as const, text: 'B final answer' };
      yield { type: 'done' as const, finishReason: 'stop' };
    },
    async execute() {
      return { type: 'completion', answer: 'scripted' };
    },
    async executeRaw() {
      return 'scripted';
    },
    getLastInvocationMetadata() {
      return null;
    },
  };

  try {
    const engine = new ChatEngine({
      task: 'Task A',
      projectRoot: root,
      runId: `r0-budget-owner-${Math.random().toString(36).slice(2, 10)}`,
      model: MODEL,
    });
    const box = engine as unknown as {
      deliberationRunner: unknown;
      synthesisRunner: unknown;
      shouldUseNativeTools: () => boolean;
      checkBudgets: () => { ok: boolean; reason?: string; limiter?: string };
      toolCallLog: Array<Record<string, unknown>>;
      runAsymmetricDiffCritic: () => Promise<'allow' | 'reject' | 'block'>;
    };
    box.deliberationRunner = runner;
    box.synthesisRunner = runner;
    box.shouldUseNativeTools = () => true;

    // Stand-in for the real async last-chance critic; it suspends
    // handleBudgetKill at its only await so the race ordering is explicit.
    box.runAsymmetricDiffCritic = async () => {
      criticStarted.resolve();
      await gateCritic.promise;
      return 'allow';
    };

    // Force Task A's first budget check to fail with a confirmed mutation so
    // the last-chance critic runs; allow every later check (Task B).
    let checks = 0;
    box.checkBudgets = function (this: unknown) {
      checks += 1;
      if (checks === 1) {
        box.toolCallLog.push({
          tool: 'sub_agent',
          target: 'src/main.ts',
          index: 0,
          effect_status: 'confirmed_change',
          mutation_paths: ['src/main.ts'],
        });
        return { ok: false, reason: 'r0 budget kill', limiter: 'cost' };
      }
      return { ok: true };
    };

    const aEvents: ChatEvent[] = [];
    const pumpA = (async () => {
      for await (const event of engine.submitMessageStream('Task A: mutate.')) {
        aEvents.push(event);
      }
    })();

    // Wait until A is suspended inside handleBudgetKill -> critic.
    const reachedCritic = await Promise.race([
      criticStarted.promise.then(() => 'critic' as const),
      pumpA.then(() => 'a-done' as const),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 4000)),
    ]);
    assert.equal(reachedCritic, 'critic', 'Task A reached the last-chance critic');

    // Task B starts and blocks mid-turn.
    const bEvents: ChatEvent[] = [];
    const pumpB = (async () => {
      for await (const event of engine.submitMessageStream('Task B: inventory only.')) {
        bEvents.push(event);
      }
    })();
    await startedB.promise;

    // Release A's critic while B is still mid-turn.
    gateCritic.resolve();
    await pumpA;

    gateB.resolve();
    await pumpB;

    const bTerminal = bEvents[bEvents.length - 1] as Extract<ChatEvent, { type: 'done' }>;
    assert.equal(bTerminal.type, 'done', 'Task B completes normally');
    assert.notEqual(bTerminal.outcome, 'BUDGET_EXHAUSTED', 'Task B is not budget-killed by late Task A');
    const bTurnId = (bTerminal as unknown as { turnTelemetry?: { turnId?: string } }).turnTelemetry
      ?.turnId;
    assert.ok(bTurnId, 'Task B terminal carries its turn id');
    const bTurnEnded = engine
      .getParityEventLog()
      .events.filter((event) => event.kind === 'turn_ended' && event.turn_id === bTurnId);
    assert.equal(bTurnEnded.length, 1, 'Task B ends its own turn exactly once');
    assert.notEqual(
      (bTurnEnded[0] as { outcome?: string }).outcome,
      'BUDGET_EXHAUSTED',
      'Task B durable turn outcome is its own, not a stale Task A budget kill',
    );
    assert.equal(terminals(aEvents).length, 0, 'the superseded Task A emits no terminal of its own');
  } finally {
    spawnSync('git', ['worktree', 'prune'], { cwd: root, encoding: 'utf-8' });
    rmSync(root, { recursive: true, force: true });
  }
});

test('an obsolete Task A throwing ordinary action cannot write Task B tool log', async () => {
  const root = createGitProject();
  const aDispatched = deferred();
  const aGate = deferred();
  const bStarted = deferred();
  const bGate = deferred();
  try {
    const engine = new ChatEngine({
      task: 'Task A',
      projectRoot: root,
      runId: `r0-ordinary-read-${Math.random().toString(36).slice(2, 10)}`,
      model: MODEL,
    });

    // Mutable runner with a per-call provider block latch.
    let script: Array<ToolStreamEvent[]> = [];
    let base = 0;
    let call = 0;
    let block: (() => Promise<void>) | null = null;
    const runner: ScriptedRunner & {
      setScript(next: Array<ToolStreamEvent[]>): void;
      onProviderBlock(fn: () => Promise<void>): void;
    } = {
      setScript(next) {
        script = next;
        base = call;
      },
      onProviderBlock(fn) {
        block = fn;
      },
      async *executeWithToolsStream() {
        const index = call;
        call += 1;
        if (block) {
          const current = block;
          block = null;
          await current();
        }
        const events = script[index - base] ?? [
          { type: 'text_delta' as const, text: 'Inventory complete.' },
          { type: 'done' as const, finishReason: 'stop' },
        ];
        for (const event of events) yield event;
      },
      async execute() {
        return { type: 'completion', answer: 'scripted' };
      },
      async executeRaw() {
        return 'scripted';
      },
      getLastInvocationMetadata() {
        return null;
      },
    };
    installRunner(engine, runner);

    // Suspend A inside an ordinary read's hashFilePath (a production await),
    // then reject it after B owns the engine.
    const box = engine as unknown as {
      hashFilePath(path: string): Promise<string | null>;
      toolCallLog: Array<{ tool: string; target: string; error?: string; detail?: string }>;
    };
    const originalHash = box.hashFilePath.bind(engine);
    let firstHash = true;
    box.hashFilePath = async (path: string) => {
      if (firstHash) {
        firstHash = false;
        aDispatched.resolve();
        await aGate.promise;
        throw new Error('r0 injected ordinary read failure');
      }
      return originalHash(path);
    };

    runner.setScript([
      [
        { type: 'tool_use', id: 'a-read', name: 'read_file', input: { path: 'src/main.ts' } },
        { type: 'done', finishReason: 'tool_calls' },
      ],
      [{ type: 'text_delta', text: 'A concluding.' }, { type: 'done', finishReason: 'stop' }],
    ]);
    const aEvents: ChatEvent[] = [];
    const pumpA = (async () => {
      for await (const event of engine.submitMessageStream('Task A: inspect src/main.ts.')) {
        aEvents.push(event);
      }
    })();
    await aDispatched.promise;

    // Task B starts and blocks inside its provider before executing any tool.
    runner.setScript([
      [
        { type: 'tool_use', id: 'b-read', name: 'read_file', input: { path: 'src/main.ts' } },
        { type: 'done', finishReason: 'tool_calls' },
      ],
      [{ type: 'text_delta', text: 'Inventory complete.' }, { type: 'done', finishReason: 'stop' }],
    ]);
    runner.onProviderBlock(async () => {
      bStarted.resolve();
      await bGate.promise;
    });
    const bEvents: ChatEvent[] = [];
    const pumpB = (async () => {
      for await (const event of engine.submitMessageStream('Task B: inventory only.')) {
        bEvents.push(event);
      }
    })();
    await bStarted.promise;

    const logBeforeA = box.toolCallLog.length;
    aGate.resolve();
    await pumpA;
    assert.equal(box.toolCallLog.length, logBeforeA, 'obsolete A appended no row to the live log');

    bGate.resolve();
    await pumpB;

    const bTerminal = bEvents[bEvents.length - 1] as Extract<ChatEvent, { type: 'done' }>;
    assert.equal(bTerminal.type, 'done', 'Task B completes normally');
    assert.equal(terminals(aEvents).length, 0, 'the superseded Task A emits no terminal of its own');
    assert.equal(
      box.toolCallLog.filter((row) => row.error === 'error').length,
      0,
      'obsolete A must not append an error row to Task B tool log',
    );
  } finally {
    spawnSync('git', ['worktree', 'prune'], { cwd: root, encoding: 'utf-8' });
    rmSync(root, { recursive: true, force: true });
  }
});

test('a superseded Task A fallback completion cannot spend Task B budget', async () => {
  const root = createGitProject();
  const fallbackStarted = deferred();
  const fallbackGate = deferred();
  const bSecondStarted = deferred();
  const bSecondGate = deferred();

  // Primary provider: A's first call fails (generic, non-abort); B succeeds.
  let primaryCall = 0;
  const primary: ScriptedRunner & {
    executeRawStream: () => AsyncGenerator<string, void, undefined>;
  } = {
    async *executeWithToolsStream() {
      const index = primaryCall;
      primaryCall += 1;
      if (index === 0) throw new Error('primary provider exploded for task A');
      if (index === 1) {
        yield {
          type: 'tool_use' as const,
          id: 'b-read',
          name: 'read_file',
          input: { path: 'src/main.ts' },
        };
        yield { type: 'done' as const, finishReason: 'tool_calls' };
        return;
      }
      bSecondStarted.resolve();
      await bSecondGate.promise;
      yield { type: 'text_delta' as const, text: 'B final answer' };
      yield { type: 'done' as const, finishReason: 'stop' };
    },
    async *executeRawStream() {
      throw new Error('unused raw stream');
    },
    async execute() {
      return { type: 'completion', answer: 'scripted' };
    },
    async executeRaw() {
      return 'scripted';
    },
    getLastInvocationMetadata() {
      return null;
    },
  };

  // Fallback provider: blocks until released, then reports large usage.
  const fallback = {
    async *executeWithToolsStream() {
      fallbackStarted.resolve();
      await fallbackGate.promise;
      yield { type: 'text_delta' as const, text: 'A fallback answer' };
      yield { type: 'done' as const, finishReason: 'stop' };
    },
    async *executeRawStream() {
      fallbackStarted.resolve();
      await fallbackGate.promise;
      yield 'A fallback answer';
    },
    async execute() {
      return { type: 'completion', answer: 'scripted' };
    },
    async executeRaw() {
      return 'scripted';
    },
    getLastInvocationMetadata() {
      return {
        provider_model_id: 'fallback-model',
        prompt_tokens: 100_000,
        completion_tokens: 100_000,
        prompt_cache_hit_tokens: 0,
        prompt_cache_miss_tokens: 0,
        estimated_cost_usd: 0,
      };
    },
  };

  try {
    const engine = new ChatEngine({
      task: 'Task A',
      projectRoot: root,
      runId: `r0-fb-sibling-${Math.random().toString(36).slice(2, 10)}`,
      model: MODEL,
      maxTokensPerRound: 100,
      providerRunner: fallback as never,
    });
    installRunner(engine, primary);
    const box = engine as unknown as {
      runAsymmetricDiffCritic: () => Promise<'allow' | 'reject' | 'block'>;
      apiTokenCount: number;
      lastRequestModelId: string | null;
    };
    box.runAsymmetricDiffCritic = async () => 'allow';

    // Task A: primary fails, the fallback stream suspends.
    const aEvents: ChatEvent[] = [];
    const pumpA = (async () => {
      for await (const event of engine.submitMessageStream('Task A: do a thing.')) {
        aEvents.push(event);
      }
    })();
    await fallbackStarted.promise;

    // Task B: one read turn, then blocks inside its second provider call.
    const bEvents: ChatEvent[] = [];
    const pumpB = (async () => {
      for await (const event of engine.submitMessageStream('Task B: inventory only.')) {
        bEvents.push(event);
      }
    })();
    await bSecondStarted.promise;

    const tokensBeforeA = box.apiTokenCount;

    // Release A's fallback while B is mid-turn; A is superseded.
    fallbackGate.resolve();
    await pumpA;

    assert.equal(
      box.apiTokenCount,
      tokensBeforeA,
      'superseded Task A fallback must not add tokens to Task B apiTokenCount',
    );
    assert.notEqual(
      box.lastRequestModelId,
      'fallback-model',
      'superseded Task A fallback must not overwrite Task B request model identity',
    );

    bSecondGate.resolve();
    await pumpB;

    const bTerminal = bEvents[bEvents.length - 1] as Extract<ChatEvent, { type: 'done' }>;
    assert.equal(bTerminal.type, 'done', 'Task B completes normally');
    assert.notEqual(
      bTerminal.outcome,
      'BUDGET_EXHAUSTED',
      'Task B is not token-explosion killed by late Task A fallback usage',
    );
    assert.equal(terminals(aEvents).length, 0, 'the superseded Task A emits no terminal of its own');
  } finally {
    spawnSync('git', ['worktree', 'prune'], { cwd: root, encoding: 'utf-8' });
    rmSync(root, { recursive: true, force: true });
  }
});
