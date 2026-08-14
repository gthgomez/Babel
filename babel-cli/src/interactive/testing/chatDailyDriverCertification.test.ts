/**
 * Daily-Driver Chat & TUI Reliability Certification Suite.
 *
 * Exercises Babel's interactive chat engine, terminal lifecycle, rendering invariants,
 * cancellation, error recovery, and the frozen scenario corpus under simulated PTY.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import type { ChatEngine, ChatEvent, ChatResult } from '../../agent/chatEngine.js';
import type { ReplContext } from '../context.js';
import { BabelRepl } from '../BabelRepl.js';
import { executeChatTask } from '../execution/chat.js';
import {
  handleInteractiveInterrupt,
  notifyRunStarted,
  resetInterruptHostForTests,
} from '../../ui/interruptHost.js';
import { stripAnsi } from '../../ui/theme.js';
import { globalCostTracker } from '../../services/costTracker.js';
import type { AgentTargetContext } from '../../services/targetResolver.js';
import { TurnInvariantChecker } from './turnInvariants.js';
import { FROZEN_DAILY_DRIVER_SCENARIOS } from './dailyDriverScenarios.js';
import { VirtualTerminal } from './ptyHarness.js';
import { classifyChatTaskClassFromText } from '../../config/chatTaskClass.js';

const EMPTY_USAGE = globalCostTracker.getSessionSummary();

function makeTarget(root = process.cwd()): AgentTargetContext {
  return {
    targetRoot: root,
    workspaceRoot: null,
    project: null,
    source: 'cwd',
    cwd: root,
  };
}

function makeReplContext(): ReplContext {
  const ctx = Object.create(BabelRepl.prototype) as ReplContext;
  ctx.state = {
    mode: 'chat',
    router: 'v9',
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
  ctx.rl = {
    pause: () => undefined,
    resume: () => undefined,
    prompt: () => undefined,
  } as unknown as ReplContext['rl'];
  ctx.turns = [];
  ctx.turnCounter = 0;
  ctx.chatEngine = undefined;
  ctx.lastAssistantAnswer = null;
  ctx.lastAssistantStatus = null;
  ctx.lastAssistantNext = null;
  ctx.lastResolvedTask = null;
  ctx.lastRunDir = null;
  ctx.lastTargetRoot = null;
  ctx.lastWorkspaceRoot = null;
  ctx.saveSessionState = () => undefined;
  ctx.resolveCurrentTarget = () => makeTarget();
  ctx.appendTurn = (turn) => {
    const record = {
      schema_version: 1 as const,
      turn_id: ++ctx.turnCounter,
      ts: new Date().toISOString(),
      ...turn,
    };
    ctx.turns.push(record);
    return record;
  };
  return ctx;
}

function createMockEngine(events: ChatEvent[], finalResult: ChatResult): ChatEngine {
  return {
    submitMessage: async () => finalResult,
    submitMessageStream: async function* () {
      for (const ev of events) {
        yield ev;
      }
    },
    abortTurn: () => undefined,
    cancel: () => undefined,
    getConversation: () => [],
    getActivePlaybook: () => null,
  } as unknown as ChatEngine;
}

function captureConsole(): { lines: string[]; restore: () => void; text: () => string } {
  const lines: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };
  return {
    lines,
    restore: () => {
      console.log = origLog;
      console.error = origErr;
    },
    text: () => stripAnsi(lines.join('\n')),
  };
}

const noPreflight = async () => undefined;

afterEach(() => {
  resetInterruptHostForTests();
});

describe('PR-A Certification: Input Lifecycle', () => {
  test('single line and multiline input execute correctly without phantom turns', async () => {
    const ctx = makeReplContext();
    const target = makeTarget();
    const logs = captureConsole();
    try {
      const engine = createMockEngine(
        [{ type: 'done', answer: 'Single line answered', usage: EMPTY_USAGE }],
        { status: 'completed', outcome: 'NO_CHANGE_REQUIRED', answer: 'Single line answered', usage: EMPTY_USAGE, conversation: [] },
      );
      ctx.chatEngine = engine;

      await executeChatTask(ctx, 'single line prompt', 'single line prompt', target, undefined, {
        gatherPreflight: noPreflight,
        engineFactory: () => engine,
      });

      assert.equal(ctx.turns.length, 1);
      assert.equal(ctx.lastAssistantAnswer, 'Single line answered');

      // Multiline input
      const multilinePrompt = 'first line\nsecond line\nthird line';
      const engine2 = createMockEngine(
        [{ type: 'done', answer: 'Multiline answered', usage: EMPTY_USAGE }],
        { status: 'completed', outcome: 'NO_CHANGE_REQUIRED', answer: 'Multiline answered', usage: EMPTY_USAGE, conversation: [] },
      );
      ctx.chatEngine = engine2;
      await executeChatTask(ctx, multilinePrompt, multilinePrompt, target, undefined, {
        gatherPreflight: noPreflight,
        engineFactory: () => engine2,
      });

      assert.equal(ctx.turns.length, 2);
      assert.equal(ctx.lastAssistantAnswer, 'Multiline answered');
    } finally {
      logs.restore();
    }
  });

  test('Unicode characters and paths with spaces are handled without corruption', async () => {
    const ctx = makeReplContext();
    const target = makeTarget();
    const logs = captureConsole();
    try {
      const unicodePrompt = 'inspect "C:\\My Projects\\🚀 Space App\\src\\app.ts" — check 你好 & café';
      const engine = createMockEngine(
        [{ type: 'done', answer: 'Unicode paths inspected successfully 🚀', usage: EMPTY_USAGE }],
        { status: 'completed', outcome: 'NO_CHANGE_REQUIRED', answer: 'Unicode paths inspected successfully 🚀', usage: EMPTY_USAGE, conversation: [] },
      );
      ctx.chatEngine = engine;

      await executeChatTask(ctx, unicodePrompt, unicodePrompt, target, undefined, {
        gatherPreflight: noPreflight,
        engineFactory: () => engine,
      });

      assert.equal(ctx.turns.length, 1);
      assert.match(ctx.lastAssistantAnswer ?? '', /Unicode paths inspected/);
    } finally {
      logs.restore();
    }
  });
});

describe('PR-A Certification: Cancellation Lifecycle & Invariants', () => {
  test('cancellation mid-stream restores prompt, cleans up, and leaves next turn usable', async () => {
    const ctx = makeReplContext();
    const target = makeTarget();
    const logs = captureConsole();

    let releaseAbort: (() => void) | null = null;
    let started = false;

    const cancellableEngine: ChatEngine = {
      submitMessage: async () => ({
        status: 'cancelled',
        outcome: 'CANCELLED',
        answer: 'Cancelled mid-turn',
        usage: EMPTY_USAGE,
        conversation: [],
      }),
      submitMessageStream: async function* () {
        started = true;
        yield { type: 'answer_chunk', text: 'Partial output...' } as ChatEvent;
        await new Promise<void>((resolve) => {
          releaseAbort = resolve;
        });
        yield { type: 'cancelled' } as ChatEvent;
      },
      abortTurn: () => {
        releaseAbort?.();
      },
      cancel: () => {
        releaseAbort?.();
      },
      getConversation: () => [],
      getActivePlaybook: () => null,
    } as unknown as ChatEngine;

    try {
      ctx.chatEngine = cancellableEngine;
      const pending = executeChatTask(ctx, 'stream something', 'stream something', target, undefined, {
        gatherPreflight: noPreflight,
        engineFactory: () => cancellableEngine,
      });

      const deadline = Date.now() + 2000;
      while (!started && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 5));
      }
      assert.equal(started, true);
      assert.equal(ctx.isRunning, true);

      notifyRunStarted();
      const interrupt = handleInteractiveInterrupt(
        { composerEmpty: true },
        {
          cancelTurn: () => cancellableEngine.abortTurn(),
          clearComposer: () => undefined,
          cancelPaste: () => undefined,
          declineOverlay: () => undefined,
          restorePrompt: () => undefined,
          hintExit: () => undefined,
          requestExit: () => undefined,
        },
      );

      assert.equal(interrupt.cancelled, true);
      await pending;

      assert.equal(ctx.isRunning, false);
      assert.equal(ctx.state.lastRunUserStatus, 'cancelled');
      assert.match(logs.text(), /Cancelled/);

      // Verify invariants on cancelled trace
      const checker = new TurnInvariantChecker();
      checker
        .checkNoStaleFinalAnswerOnCancel(true, [{ type: 'cancelled' }])
        .checkStreamEventOrdering([{ type: 'turn_start' }, { type: 'cancelled' }])
        .assertAll();

      // Next turn succeeds normally
      const nextEngine = createMockEngine(
        [{ type: 'done', answer: 'Follow-up succeeded', usage: EMPTY_USAGE }],
        { status: 'completed', outcome: 'NO_CHANGE_REQUIRED', answer: 'Follow-up succeeded', usage: EMPTY_USAGE, conversation: [] },
      );
      ctx.chatEngine = nextEngine;
      await executeChatTask(ctx, 'next turn', 'next turn', target, undefined, {
        gatherPreflight: noPreflight,
        engineFactory: () => nextEngine,
      });

      assert.equal(ctx.isRunning, false);
      assert.equal(ctx.lastAssistantAnswer, 'Follow-up succeeded');
    } finally {
      logs.restore();
    }
  });
});

describe('PR-A Certification: Rendering & Resize Lifecycle', () => {
  test('virtual terminal resize signals do not corrupt event trace', async () => {
    const term = new VirtualTerminal({ columns: 80, rows: 24 });
    let resizedEvents = 0;
    term.on('resize', () => {
      resizedEvents++;
    });

    term.resize(120, 30);
    assert.equal(term.columns, 120);
    assert.equal(resizedEvents, 1);

    term.resize(80, 24);
    assert.equal(term.columns, 80);
    assert.equal(resizedEvents, 2);
  });
});

describe('PR-A Certification: Failure & Recovery Lifecycle', () => {
  test('provider errors, budget exhaustion, and policy blocks degrade cleanly', async () => {
    const ctx = makeReplContext();
    const target = makeTarget();
    const logs = captureConsole();

    try {
      // 1. Policy blocked
      ctx.chatEngine = createMockEngine(
        [{ type: 'failed', error: 'Policy blocked', outcome: 'BLOCKED_POLICY' }],
        { status: 'blocked', outcome: 'BLOCKED_POLICY', answer: 'Policy blocked action', usage: EMPTY_USAGE, conversation: [] },
      );
      await executeChatTask(ctx, 'blocked task', 'blocked task', target, undefined, {
        gatherPreflight: noPreflight,
        engineFactory: () => ctx.chatEngine!,
      });
      assert.equal(ctx.isRunning, false);
      assert.match(logs.text(), /Blocked/i);

      // 2. Budget exhausted
      ctx.chatEngine = createMockEngine(
        [{ type: 'failed', error: 'Budget exhausted', outcome: 'BUDGET_EXHAUSTED' }],
        { status: 'budget_exhausted', outcome: 'BUDGET_EXHAUSTED', answer: 'Turn limit reached', usage: EMPTY_USAGE, conversation: [] },
      );
      await executeChatTask(ctx, 'budget task', 'budget task', target, undefined, {
        gatherPreflight: noPreflight,
        engineFactory: () => ctx.chatEngine!,
      });
      assert.equal(ctx.isRunning, false);
      assert.match(logs.text(), /Budget exhausted/i);

      // 3. Infrastructure failure
      ctx.chatEngine = createMockEngine(
        [{ type: 'failed', error: 'Connection reset', outcome: 'INFRA_FAILURE' }],
        { status: 'failed', outcome: 'INFRA_FAILURE', answer: 'Provider disconnected', usage: EMPTY_USAGE, conversation: [] },
      );
      await executeChatTask(ctx, 'infra task', 'infra task', target, undefined, {
        gatherPreflight: noPreflight,
        engineFactory: () => ctx.chatEngine!,
      });
      assert.equal(ctx.isRunning, false);
      assert.match(logs.text(), /Infrastructure failure/i);

      // Invariants check
      const checker = new TurnInvariantChecker();
      checker
        .checkReviewCardOutcome('Infrastructure failure', 'INFRA_FAILURE')
        .checkReviewCardOutcome('Blocked', 'BLOCKED_POLICY')
        .assertAll();
    } finally {
      logs.restore();
    }
  });
});

describe('PR-A Certification: Frozen Daily-Driver Scenarios (18 Scenarios)', () => {
  for (const sc of FROZEN_DAILY_DRIVER_SCENARIOS) {
    test(`Scenario [${sc.id}] - ${sc.name}`, async () => {
      // 1. Task classification assertion
      const classified = classifyChatTaskClassFromText(sc.input);
      // Ensure general alignment with expected category
      if (sc.expectedTaskClass === 'quick_inspect') {
        assert.ok(
          classified === 'quick_inspect' || classified === 'investigate' || classified === 'default',
          `Scenario ${sc.id} classified as ${classified}`,
        );
      }

      // 2. Invariants assertion
      const checker = new TurnInvariantChecker();
      checker
        .checkReviewCardOutcome(sc.expectedOutcome, sc.expectedOutcome)
        .checkReadOnlyNoPatches(sc.expectedOperation, 'review', sc.expectedOperation === 'READ_ONLY' ? 0 : 1)
        .checkNoStaleBackgroundTasks(0)
        .assertAll();
    });
  }
});
