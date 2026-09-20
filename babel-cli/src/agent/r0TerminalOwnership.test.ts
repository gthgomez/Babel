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
