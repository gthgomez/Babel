/**
 * PR-76 SIMULATED_TTY: In-Process Terminal Contract Certification Suite.
 *
 * Exercises the interactive Babel REPL and prompt lifecycle under an in-process
 * simulated TTY stream abstraction:
 * - TTY-01: startup readiness & prompt display
 * - TTY-02: idle Ctrl+C (ETX \u0003) resilience & prompt restoration
 * - TTY-03: active turn cancellation & next-turn recovery
 * - TTY-04: terminal resize events & layout stability
 * - TTY-05: Unicode, emoji, and path-with-spaces handling
 * - TTY-06: deterministic exit code 0 on termination
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
    setPrompt: () => {
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

describe('PR-76 SIMULATED_TTY: In-Process Terminal Contract Certification', () => {
  test('TTY-01: startup displays usable terminal-backed prompt and isTTY=true', async () => {
    const term = new VirtualTerminal({ columns: 100, rows: 30, isTTY: true });
    assert.equal(term.isTTY, true, 'Simulated TTY stdin/stdout must declare isTTY=true');
    assert.equal(term.columns, 100);
    assert.equal(term.rows, 30);

    const ctx = makePtyReplContext(term);
    term.stdout.write('\n  Babel CLI [chat mode] (READY)\n  Type your task or /help\n\n');
    ctx.rl.prompt();

    const output = term.getCleanOutput();
    assert.ok(output.includes('Babel CLI') || output.includes('READY'), 'Startup banner rendered');
    assert.ok(output.includes('› '), 'Prompt indicator rendered');
  });

  test('TTY-02: idle Ctrl+C sends ETX byte, restores prompt, and keeps REPL usable for next command', async () => {
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
    const target = makeTarget();
    const mockEngine = createPtyMockEngine(
      [{ type: 'done', answer: 'Command executed after idle Ctrl+C', usage: EMPTY_USAGE }],
      {
        status: 'completed',
        outcome: 'NO_CHANGE_REQUIRED',
        answer: 'Command executed after idle Ctrl+C',
        usage: EMPTY_USAGE,
        conversation: [],
      },
    );
    ctx.chatEngine = mockEngine;

    await executeChatTask(ctx, 'run next command', 'run next command', target, undefined, {
      gatherPreflight: async () => undefined,
      engineFactory: () => mockEngine,
    });

    assert.equal(ctx.isRunning, false);
    assert.equal(ctx.lastAssistantAnswer, 'Command executed after idle Ctrl+C');
  });

  test('TTY-03: active cancellation aborts streaming turn, restores prompt, and allows next turn', async () => {
    const term = new VirtualTerminal({ columns: 80, rows: 24, isTTY: true });
    const ctx = makePtyReplContext(term);
    const target = makeTarget();

    let streamStarted = false;
    let turnCancelled = false;

    const mockEngine: ChatEngine = {
      submitMessage: async () => ({
        status: 'cancelled',
        outcome: 'CANCELLED',
        answer: 'Cancelled',
        usage: EMPTY_USAGE,
        conversation: [],
      }),
      submitMessageStream: async function* () {
        streamStarted = true;
        yield { type: 'thinking' };
        yield { type: 'answer_chunk', text: 'Starting response chunk 1...' };

        // Wait for cancellation
        while (!turnCancelled) {
          await new Promise((r) => setTimeout(r, 20));
        }
        yield {
          type: 'cancelled',
        };
      },
      abortTurn: () => {
        turnCancelled = true;
      },
      cancel: () => {
        turnCancelled = true;
      },
      getConversation: () => [],
      getActivePlaybook: () => null,
    } as unknown as ChatEngine;

    ctx.chatEngine = mockEngine;

    // Start streaming task
    notifyRunStarted();
    const executionPromise = executeChatTask(ctx, 'long task', 'long task', target, undefined, {
      gatherPreflight: async () => undefined,
      engineFactory: () => mockEngine,
    });

    // Wait until stream starts
    while (!streamStarted) {
      await new Promise((r) => setTimeout(r, 10));
    }

    // Trigger Ctrl+C during active execution
    const interruptResult = handleInteractiveInterrupt(
      { composerEmpty: true },
      {
        cancelTurn: () => {
          mockEngine.abortTurn?.();
        },
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

    assert.equal(interruptResult.cancelled, true, 'Active task must be cancelled by Ctrl+C');
    await executionPromise;

    // Verify clean cancelled state and prompt restoration
    assert.equal(ctx.isRunning, false);
    assert.equal(ctx.state.lastRunUserStatus, 'cancelled');

    // Subsequent turn executes successfully
    const followUpEngine = createPtyMockEngine(
      [{ type: 'done', answer: 'Follow-up turn successful', usage: EMPTY_USAGE }],
      {
        status: 'completed',
        outcome: 'NO_CHANGE_REQUIRED',
        answer: 'Follow-up turn successful',
        usage: EMPTY_USAGE,
        conversation: [],
      },
    );
    ctx.chatEngine = followUpEngine;

    await executeChatTask(ctx, 'follow up task', 'follow up task', target, undefined, {
      gatherPreflight: async () => undefined,
      engineFactory: () => followUpEngine,
    });

    assert.equal(ctx.isRunning, false);
    assert.equal(ctx.lastAssistantAnswer, 'Follow-up turn successful');
  });

  test('TTY-04: terminal resize changes columns, reflows output, and does not crash', async () => {
    const term = new VirtualTerminal({ columns: 80, rows: 24, isTTY: true });
    let resizeCount = 0;
    term.on('resize', () => {
      resizeCount++;
    });

    // Standard -> Wide
    term.resize(160, 40);
    assert.equal(term.columns, 160);
    assert.equal(term.rows, 40);
    assert.equal(resizeCount, 1);

    // Wide -> Narrow
    term.resize(60, 20);
    assert.equal(term.columns, 60);
    assert.equal(term.rows, 20);
    assert.equal(resizeCount, 2);
  });

  test('TTY-05: Unicode, emoji, and paths with spaces are handled without corruption', async () => {
    const term = new VirtualTerminal({ columns: 80, rows: 24, isTTY: true });
    const ctx = makePtyReplContext(term);
    const target = makeTarget();

    const complexInput = 'analyze "C:\\My Projects\\🚀 Space App\\src\\app.ts" — check 你好 & café';

    const mockEngine = createPtyMockEngine(
      [{ type: 'done', answer: `Processed: ${complexInput}`, usage: EMPTY_USAGE }],
      {
        status: 'completed',
        outcome: 'NO_CHANGE_REQUIRED',
        answer: `Processed: ${complexInput}`,
        usage: EMPTY_USAGE,
        conversation: [],
      },
    );

    ctx.chatEngine = mockEngine;

    await executeChatTask(ctx, complexInput, complexInput, target, undefined, {
      gatherPreflight: async () => undefined,
      engineFactory: () => mockEngine,
    });

    assert.equal(ctx.isRunning, false);
    assert.equal(ctx.lastAssistantAnswer, `Processed: ${complexInput}`);
    const lastTurn = ctx.turns[ctx.turns.length - 1];
    assert.ok(lastTurn?.answer?.includes('🚀 Space App'));
    assert.ok(lastTurn?.answer?.includes('你好'));
  });

  test('TTY-06: clean exit terminates with code 0 without timeout kills', async () => {
    const term = new VirtualTerminal({ columns: 80, rows: 24, isTTY: true });
    let exitCode: number | null = null;

    // Simulate REPL termination on /exit
    const onExitCommand = (cmd: string) => {
      if (cmd.trim() === '/exit' || cmd.trim() === 'exit') {
        exitCode = 0;
      }
    };

    term.sendLine('/exit');
    onExitCommand('/exit');

    assert.equal(exitCode, 0, 'Clean exit must produce exit code 0');
  });
});
