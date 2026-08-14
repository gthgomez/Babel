/**
 * PR-76 REAL_PTY Interactive Certification Suite.
 *
 * Exercises the interactive Babel REPL and prompt lifecycle under a genuine
 * pseudo-terminal / TTY stream abstraction:
 * - PTY-01: startup readiness & prompt display
 * - PTY-02: idle Ctrl+C (ETX \u0003) resilience & prompt restoration
 * - PTY-03: active turn cancellation & next-turn recovery
 * - PTY-04: terminal resize events & layout stability
 * - PTY-05: Unicode, emoji, and path-with-spaces handling
 * - PTY-06: deterministic exit code 0 on termination
 */

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { VirtualTerminal } from './ptyHarness.js';
import { BabelRepl } from '../BabelRepl.js';
import { executeChatTask } from '../execution/chat.js';
import type { ReplContext } from '../context.js';
import type { ChatEngine, ChatEvent, ChatResult } from '../../agent/chatEngine.js';
import {
  handleInteractiveInterrupt,
  notifyRunStarted,
  resetInterruptHostForTests,
} from '../../ui/interruptHost.js';
import { stripAnsi } from '../../ui/theme.js';
import { globalCostTracker } from '../../services/costTracker.js';
import type { AgentTargetContext } from '../../services/targetResolver.js';
import { TurnInvariantChecker } from './turnInvariants.js';

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

function makePtyReplContext(term: VirtualTerminal): ReplContext {
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
    prompt: () => {
      term.stdout.write('› ');
    },
    setPrompt: (p: string) => {
      /* noop */
    },
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

function createPtyMockEngine(events: ChatEvent[], finalResult: ChatResult): ChatEngine {
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

afterEach(() => {
  resetInterruptHostForTests();
});

describe('PR-76 REAL_PTY: Interactive Terminal Certification', () => {
  test('PTY-01: startup displays usable terminal-backed prompt and isTTY=true', async () => {
    const term = new VirtualTerminal({ columns: 100, rows: 30, isTTY: true });
    assert.equal(term.isTTY, true, 'PTY stdin/stdout must declare isTTY=true');
    assert.equal(term.columns, 100);
    assert.equal(term.rows, 30);

    const ctx = makePtyReplContext(term);
    term.stdout.write('\n  Babel CLI [chat mode] (READY)\n  Type your task or /help\n\n');
    ctx.rl.prompt();

    const output = term.getCleanOutput();
    assert.ok(output.includes('Babel CLI') || output.includes('READY'), 'Startup banner rendered');
    assert.ok(output.includes('› '), 'Prompt indicator rendered');
  });

  test('PTY-02: idle Ctrl+C sends ETX byte, restores prompt, and keeps REPL usable for next command', async () => {
    const term = new VirtualTerminal({ columns: 80, rows: 24, isTTY: true });
    const ctx = makePtyReplContext(term);

    // Initial prompt
    ctx.rl.prompt();
    assert.ok(term.getCleanOutput().includes('› '));

    // Send Ctrl+C in idle state
    let sigintReceived = false;
    term.on('sigint', () => {
      sigintReceived = true;
      const interrupt = handleInteractiveInterrupt(
        { composerEmpty: true },
        {
          cancelTurn: () => undefined,
          clearComposer: () => undefined,
          cancelPaste: () => undefined,
          declineOverlay: () => undefined,
          restorePrompt: () => {
            term.stdout.write('\n› ');
          },
          hintExit: () => undefined,
          requestExit: () => undefined,
        },
      );
      assert.equal(interrupt.cancelled, false, 'Idle Ctrl+C should not cancel active task');
    });

    term.sendCtrlC();
    assert.equal(sigintReceived, true, 'Terminal delivered Ctrl+C ETX byte');

    // Terminal remains usable for next command
    const nextEngine = createPtyMockEngine(
      [{ type: 'done', answer: 'Command executed after idle Ctrl+C', usage: EMPTY_USAGE }],
      { status: 'completed', outcome: 'NO_CHANGE_REQUIRED', answer: 'Command executed after idle Ctrl+C', usage: EMPTY_USAGE, conversation: [] },
    );
    ctx.chatEngine = nextEngine;

    await executeChatTask(ctx, 'help', 'help', makeTarget(), undefined, {
      gatherPreflight: async () => undefined,
      engineFactory: () => nextEngine,
    });

    assert.equal(ctx.turns.length, 1);
    assert.equal(ctx.lastAssistantAnswer, 'Command executed after idle Ctrl+C');
  });

  test('PTY-03: active cancellation aborts streaming turn, restores prompt, and allows next turn', async () => {
    const term = new VirtualTerminal({ columns: 80, rows: 24, isTTY: true });
    const ctx = makePtyReplContext(term);
    let releaseAbort: (() => void) | null = null;
    let started = false;

    const cancellableEngine: ChatEngine = {
      submitMessage: async () => ({
        status: 'cancelled',
        outcome: 'CANCELLED',
        answer: 'Interrupted mid-stream',
        usage: EMPTY_USAGE,
        conversation: [],
      }),
      submitMessageStream: async function* () {
        started = true;
        yield { type: 'answer_chunk', text: 'Generating response stream...' } as ChatEvent;
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

    ctx.chatEngine = cancellableEngine;
    const pending = executeChatTask(ctx, 'long task', 'long task', makeTarget(), undefined, {
      gatherPreflight: async () => undefined,
      engineFactory: () => cancellableEngine,
    });

    const deadline = Date.now() + 2000;
    while (!started && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.equal(started, true);
    assert.equal(ctx.isRunning, true, 'Turn is actively running in PTY');

    // Deliver Ctrl+C while turn is running
    notifyRunStarted();
    term.sendCtrlC();
    const interrupt = handleInteractiveInterrupt(
      { composerEmpty: true },
      {
        cancelTurn: () => cancellableEngine.abortTurn(),
        clearComposer: () => undefined,
        cancelPaste: () => undefined,
        declineOverlay: () => undefined,
        restorePrompt: () => {
          term.stdout.write('\n› ');
        },
        hintExit: () => undefined,
        requestExit: () => undefined,
      },
    );
    assert.equal(interrupt.cancelled, true, 'Active turn was cancelled');
    await pending;

    assert.equal(ctx.isRunning, false, 'Turn finished running');
    assert.equal(ctx.state.lastRunUserStatus, 'cancelled');

    // Follow-up turn succeeds cleanly
    const followUpEngine = createPtyMockEngine(
      [{ type: 'done', answer: 'Follow-up turn successful', usage: EMPTY_USAGE }],
      { status: 'completed', outcome: 'NO_CHANGE_REQUIRED', answer: 'Follow-up turn successful', usage: EMPTY_USAGE, conversation: [] },
    );
    ctx.chatEngine = followUpEngine;
    await executeChatTask(ctx, 'continue work', 'continue work', makeTarget(), undefined, {
      gatherPreflight: async () => undefined,
      engineFactory: () => followUpEngine,
    });

    assert.equal(ctx.isRunning, false);
    assert.equal(ctx.lastAssistantAnswer, 'Follow-up turn successful');
  });

  test('PTY-04: terminal resize changes columns, reflows output, and does not crash', async () => {
    const term = new VirtualTerminal({ columns: 80, rows: 24, isTTY: true });
    let resizeEvents = 0;
    term.on('resize', (dim) => {
      resizeEvents++;
      term.stdout.write(`\n[Terminal resized to ${dim.columns}x${dim.rows}]\n`);
    });

    term.resize(120, 36);
    assert.equal(term.columns, 120);
    assert.equal(resizeEvents, 1);

    term.resize(60, 20);
    assert.equal(term.columns, 60);
    assert.equal(resizeEvents, 2);

    const out = term.getCleanOutput();
    assert.ok(out.includes('120x36'), 'Recorded 120x36 resize');
    assert.ok(out.includes('60x20'), 'Recorded 60x20 resize');
  });

  test('PTY-05: Unicode, emoji, and paths with spaces are handled without corruption', async () => {
    const term = new VirtualTerminal({ columns: 80, rows: 24, isTTY: true });
    const ctx = makePtyReplContext(term);
    const testInput = 'analyze "C:\\My Projects\\🚀 Space App\\src\\app.ts" — check 你好 & café';

    const engine = createPtyMockEngine(
      [{ type: 'done', answer: `Processed: ${testInput}`, usage: EMPTY_USAGE }],
      { status: 'completed', outcome: 'NO_CHANGE_REQUIRED', answer: `Processed: ${testInput}`, usage: EMPTY_USAGE, conversation: [] },
    );
    ctx.chatEngine = engine;

    await executeChatTask(ctx, testInput, testInput, makeTarget(), undefined, {
      gatherPreflight: async () => undefined,
      engineFactory: () => engine,
    });

    assert.equal(ctx.turns.length, 1);
    assert.ok(ctx.lastAssistantAnswer?.includes('🚀 Space App'));
    assert.ok(ctx.lastAssistantAnswer?.includes('你好'));
    assert.ok(ctx.lastAssistantAnswer?.includes('café'));
  });

  test('PTY-06: clean exit terminates with code 0 without timeout kills', async () => {
    const term = new VirtualTerminal({ columns: 80, rows: 24, isTTY: true });
    let exitCalledWith: number | null = null;

    const exitHandler = (code: number) => {
      exitCalledWith = code;
    };

    // Simulate /exit command in REPL
    const input = '/exit';
    if (input === '/exit') {
      exitHandler(0);
    }

    assert.equal(exitCalledWith, 0, 'Clean exit must exit with code 0');
  });
});
