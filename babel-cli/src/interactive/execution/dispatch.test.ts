/**
 * dispatch.test.ts — Routing switch tests for executeTask()
 *
 * Asserts every branch in dispatch.ts:79–99 routes to the correct execution
 * engine. The CLAUDE.md routing invariants require:
 *   - chat mode → executeChatTask (never v9 orchestrator)
 *   - chat mode + "babel deep" → executeGovernedTask
 *   - plan mode → executePlanTask
 *   - deep mode → executeGovernedTask
 *   - ambiguous_confirmation lane → handleAmbiguousConfirmation
 *   - empty task → blocked (no execution engine called)
 *   - non-chat/non-plan/non-deep → legacy executeGovernedTask (fallthrough)
 *
 * These tests mock at the execute*Task boundary via dependency injection
 * (ExecuteTaskDeps), mirroring the pattern from ExecuteChatTaskDeps.
 * The real dispatch.ts routing logic is driven through executeTask().
 *
 * Mutation check: deliberately inverting any routing branch MUST cause a
 * test failure.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { ReplContext } from '../context.js';
import type { AgentTargetContext } from '../../services/targetResolver.js';

// ─── Test doubles ─────────────────────────────────────────────────────────────

interface CallRecord {
  name: 'chat' | 'plan' | 'governed';
  task: string;
  mode: string;
  variant?: string | undefined;
}

const calls: CallRecord[] = [];

function resetCalls() {
  calls.length = 0;
}

function makeExecuteChatTask() {
  return async (
    _ctx: ReplContext,
    _input: string,
    task: string,
    _target: AgentTargetContext,
  ) => {
    calls.push({ name: 'chat', task, mode: String(_ctx.state.mode) });
  };
}

function makeExecutePlanTask() {
  return async (
    _ctx: ReplContext,
    _input: string,
    task: string,
    _target: AgentTargetContext,
  ) => {
    calls.push({ name: 'plan', task, mode: String(_ctx.state.mode) });
  };
}

function makeExecuteGovernedTask() {
  return async (
    _ctx: ReplContext,
    _input: string,
    task: string,
    _target: AgentTargetContext,
    variant?: string,
  ) => {
    calls.push({ name: 'governed', task, variant, mode: String(_ctx.state.mode) });
  };
}

function makeLoadSessionIdentity() {
  return async () => '# Babel — test session identity';
}

// ─── ReplContext factory ──────────────────────────────────────────────────────

function makeTarget(root = process.cwd()): AgentTargetContext {
  return {
    targetRoot: root,
    workspaceRoot: null,
    project: null,
    source: 'cwd' as const,
    cwd: root,
  };
}

interface MakeContextOptions {
  mode?: string;
  lastAssistantAnswer?: string | null;
  lastAssistantStatus?: string | null;
  lastResolvedTask?: string | null;
  lastTargetRoot?: string | null;
  lastWorkspaceRoot?: string | null;
  targetOverrideRoot?: string | null;
  project?: string;
}

function makeContext(opts: MakeContextOptions = {}): ReplContext {
  const ctx = Object.create(null) as ReplContext;

  ctx.state = {
    mode: (opts.mode as 'chat' | 'chat-headless' | 'plan' | 'deep') ?? 'chat',
    router: 'v9' as const,
    project: (opts.project ?? undefined) as unknown as string,
    costTotals: {
      totalCostUSD: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalTokens: 0,
    },
    turnCount: 0,
  };

  ctx.isRunning = false;
  ctx.verboseMode = false;
  ctx.projectSettingsApplied = false;
  ctx.lastRunDir = null;
  ctx.lastRunTranscript = null;
  ctx.currentStageIdx = 0;

  ctx.interactiveSessionId = 'test-session-1';
  ctx.interactiveSessionDir = '/tmp/babel-test-sessions/session-1';
  ctx.interactiveTranscriptPath = '/tmp/babel-test-sessions/session-1/transcript.json';

  ctx.turnCounter = 0;
  ctx.turns = [];
  ctx.lastAssistantAnswer = opts.lastAssistantAnswer ?? null;
  ctx.lastAssistantNext = null;
  ctx.lastAssistantStatus = opts.lastAssistantStatus ?? null;
  ctx.lastResolvedTask = opts.lastResolvedTask ?? null;
  ctx.lastSessionRunDir = null;

  ctx.lastTargetRoot = opts.lastTargetRoot ?? null;
  ctx.lastWorkspaceRoot = opts.lastWorkspaceRoot ?? null;
  ctx.targetOverrideRoot = opts.targetOverrideRoot ?? null;

  ctx.warmedIndexRoots = new Set();
  ctx.sessionIdentity = null;
  ctx.sessionIdentityRoot = null;

  ctx.logBuffer = [];
  ctx.pasteBuffer = [];
  ctx.inPaste = false;

  ctx.chatEngine = undefined;
  ctx.screenManager = undefined;

  ctx.rl = {
    pause: () => undefined,
    resume: () => undefined,
    prompt: () => undefined,
    on: () => undefined,
    once: () => undefined,
    off: () => undefined,
    removeAllListeners: () => undefined,
    listeners: () => [],
    listenerCount: () => 0,
    eventNames: () => [],
    rawListeners: () => [],
    getMaxListeners: () => 10,
    setMaxListeners: () => undefined,
    prependListener: () => undefined,
    prependOnceListener: () => undefined,
  } as unknown as ReplContext['rl'];

  ctx.printIdleHeader = () => {};
  ctx.renderTurnStatusBar = () => {};
  ctx.saveSessionState = () => {};
  ctx.resolveSessionModel = () => {};
  ctx.appendTurn = (_turn) => {
    ctx.turnCounter++;
    ctx.turns.push({
      schema_version: 1,
      turn_id: ctx.turnCounter,
      ts: new Date().toISOString(),
      role: _turn.role,
      ...(_turn.input !== undefined ? { input: _turn.input } : {}),
      answer: _turn.answer ?? '',
      run_dir: _turn.run_dir ?? null,
      target_root: _turn.target_root ?? null,
      workspace_root: _turn.workspace_root ?? null,
    });
    return ctx.turns[ctx.turns.length - 1]!;
  };
  ctx.resolveCurrentTarget = () => makeTarget();
  ctx.scheduleIndexWarmup = () => {};
  ctx.exit = () => {};

  return ctx;
}

// ─── Test deps ────────────────────────────────────────────────────────────────

const testDeps = {
  executeChatTask: makeExecuteChatTask(),
  executePlanTask: makeExecutePlanTask(),
  executeGovernedTask: makeExecuteGovernedTask(),
  loadSessionIdentity: makeLoadSessionIdentity(),
};

// ─── Module under test ────────────────────────────────────────────────────────

let executeTask!: typeof import('./dispatch.js').executeTask;
let handleAmbiguousConfirmation!: typeof import('./dispatch.js').handleAmbiguousConfirmation;

async function loadDispatch() {
  const mod = await import('./dispatch.js');
  executeTask = mod.executeTask;
  handleAmbiguousConfirmation = mod.handleAmbiguousConfirmation;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('executeTask dispatch routing', { concurrency: 1 }, () => {
  test.beforeEach(async () => {
    resetCalls();
    await loadDispatch();
  });

  // ── Chat mode ─────────────────────────────────────────────────────────────

  test('chat mode routes plain input to executeChatTask', async () => {
    const ctx = makeContext({ mode: 'chat' });
    await executeTask(ctx, 'what is git status?', testDeps);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.name, 'chat');
    assert.equal(calls[0]?.task, 'what is git status?');
    assert.equal(calls[0]?.mode, 'chat');
  });

  test('chat mode routes follow-up input to executeChatTask', async () => {
    const ctx = makeContext({
      mode: 'chat',
      lastAssistantAnswer: 'The sky is blue.',
      lastAssistantStatus: 'ANSWER_READY',
    });
    await executeTask(ctx, 'explain further', testDeps);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.name, 'chat');
  });

  test('chat mode + "babel deep" routes to executeGovernedTask with variant=deep', async () => {
    const ctx = makeContext({ mode: 'chat' });
    await executeTask(ctx, 'babel deep refactor the auth module', testDeps);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.name, 'governed');
    assert.equal(calls[0]?.variant, 'deep');
  });

  // ── Chat-headless mode ─────────────────────────────────────────────────────

  test('chat-headless mode routes plain input to executeChatTask', async () => {
    const ctx = makeContext({ mode: 'chat-headless' });
    await executeTask(ctx, 'run benchmark', testDeps);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.name, 'chat');
    assert.equal(calls[0]?.task, 'run benchmark');
    assert.equal(calls[0]?.mode, 'chat-headless');
  });

  test('chat-headless mode + "babel deep" routes to executeGovernedTask with variant=deep', async () => {
    const ctx = makeContext({ mode: 'chat-headless' });
    await executeTask(ctx, 'babel deep refactor the auth module', testDeps);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.name, 'governed');
    assert.equal(calls[0]?.variant, 'deep');
  });

  // ── Plan mode ─────────────────────────────────────────────────────────────

  test('plan mode routes to executePlanTask', async () => {
    const ctx = makeContext({ mode: 'plan' });
    await executeTask(ctx, 'add a logout button', testDeps);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.name, 'plan');
    assert.equal(calls[0]?.task, 'add a logout button');
  });

  test('plan mode + "babel deep" routes to executeGovernedTask (lane check precedes mode check)', async () => {
    // The lane check at dispatch.ts:79 ('deep') precedes the mode check at :84 ('plan').
    // An explicit daily command "babel deep ..." sets lane='deep', which routes to
    // executeGovernedTask before the plan-mode guard is reached. This is correct:
    // the user explicitly asked for the deep pipeline.
    const ctx = makeContext({ mode: 'plan' });
    await executeTask(ctx, 'babel deep restructure the database', testDeps);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.name, 'governed');
    assert.equal(calls[0]?.variant, 'deep');
  });

  // ── Deep mode ─────────────────────────────────────────────────────────────

  test('deep mode routes to executeGovernedTask', async () => {
    const ctx = makeContext({ mode: 'deep' });
    await executeTask(ctx, 'build the authentication system', testDeps);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.name, 'governed');
  });

  test('deep mode + "babel deep" routes to executeGovernedTask with variant=deep', async () => {
    const ctx = makeContext({ mode: 'deep' });
    await executeTask(ctx, 'babel deep optimize the query', testDeps);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.name, 'governed');
    assert.equal(calls[0]?.variant, 'deep');
  });

  // ── Ambiguous confirmation ────────────────────────────────────────────────

  test('ambiguous_confirmation lane blocks with no execution engine called', async () => {
    const ctx = makeContext({
      mode: 'chat',
      lastAssistantAnswer: 'I can help with that.',
      lastAssistantStatus: 'ANSWER_READY',
    });
    // "yes" with prior answer + ANSWER_READY status (not in APPROVAL_READY_STATUSES)
    // → classifyInteractiveLane returns 'ambiguous_confirmation'
    await executeTask(ctx, 'yes', testDeps);

    assert.equal(calls.length, 0, 'no execution engine should be called');
    assert.equal(ctx.state.lastRunUserStatus, 'blocked');
  });

  // ── Empty task guard ──────────────────────────────────────────────────────

  test('empty task prints help and sets blocked status', async () => {
    const ctx = makeContext({ mode: 'chat' });
    const writes: string[] = [];
    const origLog = console.log;
    console.log = ((line?: unknown) => {
      writes.push(String(line ?? ''));
    }) as typeof console.log;
    try {
      await executeTask(ctx, '', testDeps);
      assert.equal(ctx.state.lastRunUserStatus, 'blocked');
      assert.ok(
        writes.some((l) => l.includes('babel') && l.includes('task text')),
        'should print help message referencing babel task text',
      );
      assert.equal(calls.length, 0);
    } finally {
      console.log = origLog;
    }
  });

  // ── Fallthrough legacy governed ───────────────────────────────────────────

  test('unknown mode fallthrough to executeGovernedTask', async () => {
    const ctx = makeContext();
    (ctx.state as unknown as Record<string, unknown>).mode = 'unknown';
    await executeTask(ctx, 'some task', testDeps);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.name, 'governed');
    assert.equal(calls[0]?.variant, undefined);
  });

  // ── Turn tracking ─────────────────────────────────────────────────────────

  test('appends user turn before routing', async () => {
    const ctx = makeContext({ mode: 'chat' });
    assert.equal(ctx.turns.length, 0);
    await executeTask(ctx, 'hello world', testDeps);
    assert.equal(ctx.turns.length, 1);
    assert.equal(ctx.turns[0]?.role, 'user');
    assert.equal(ctx.turns[0]?.input, 'hello world');
  });

  test('appends turn with task and target_root fields', async () => {
    const ctx = makeContext({ mode: 'chat' });
    await executeTask(ctx, 'explain this code', testDeps);
    assert.equal(ctx.turns.length, 1);
    assert.equal(ctx.turns[0]?.target_root, process.cwd());
  });

  // ── saveSessionState in finally ───────────────────────────────────────────

  test('calls saveSessionState in finally (success path)', async () => {
    let saved = false;
    const ctx = makeContext({ mode: 'chat' });
    ctx.saveSessionState = () => { saved = true; };
    await executeTask(ctx, 'test', testDeps);
    assert.equal(saved, true);
  });

  test('calls saveSessionState in finally (error path)', async () => {
    let saved = false;
    const ctx = makeContext({ mode: 'chat' });
    ctx.saveSessionState = () => { saved = true; };
    ctx.resolveCurrentTarget = () => {
      throw new Error('target resolution failure');
    };
    try {
      await executeTask(ctx, 'test', testDeps);
    } catch {
      // expected — target resolution throws
    }
    assert.equal(saved, true);
  });
});

// ─── handleAmbiguousConfirmation ──────────────────────────────────────────────

describe('handleAmbiguousConfirmation', () => {
  test('sets lastRunUserStatus to blocked', async () => {
    await loadDispatch();
    const ctx = makeContext({ mode: 'chat' });
    const target = makeTarget();
    const writes: string[] = [];
    const origLog = console.log;
    console.log = ((line?: unknown) => { writes.push(String(line ?? '')); }) as typeof console.log;
    try {
      handleAmbiguousConfirmation(ctx, 'yes', target);
      assert.equal(ctx.state.lastRunUserStatus, 'blocked');
      assert.ok(
        writes.some((l) => l.includes('babel')),
        'should output message referencing babel',
      );
    } finally {
      console.log = origLog;
    }
  });

  test('appends assistant turn with blocked message', async () => {
    await loadDispatch();
    const ctx = makeContext({ mode: 'chat' });
    const target = makeTarget();
    handleAmbiguousConfirmation(ctx, 'ok', target);
    const assistantTurn = ctx.turns.find((t) => t.role === 'assistant');
    assert.ok(assistantTurn, 'should append an assistant turn');
    assert.ok(
      assistantTurn?.answer?.includes('babel'),
      'answer should include babel reference',
    );
  });
});
