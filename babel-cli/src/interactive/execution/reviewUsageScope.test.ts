/**
 * Regression: the terminal review card must present cost and tokens in the
 * SAME scope. Before the fix it mixed a per-run cost delta with
 * session-cumulative tokens (result.usage.totalTokens), producing cards like
 * "Cost $0.0013  44682 tok" where only the dollars meant this turn.
 */

import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatEngine as ChatEngineType, ChatEvent } from '../../agent/chatEngine.js';
import type { ReplContext } from '../context.js';
import { BabelRepl } from '../BabelRepl.js';
import { executeChatTask } from './chat.js';
import { stripAnsi } from '../../ui/theme.js';
import { globalCostTracker } from '../../services/costTracker.js';
import { updateCostTotals, restoreSessionState } from '../session.js';
import type { AgentTargetContext } from '../../services/targetResolver.js';

const roots: string[] = [];
test('session projection and restored banner preserve known charges separately from estimates', t => {
  const summary = { totalCostUSD: 0.01, knownCostUSD: 0, estimatedCostUSD: 0.01, completeCostUSD: null,
    costComplete: false, unknownChargeCount: 0, totalTokens: 10, totalInputTokens: 10, totalOutputTokens: 0, modelBreakdown: {} };
  t.mock.method(globalCostTracker, 'getSessionSummary', () => summary);
  t.mock.method(globalCostTracker, 'restoreSessionCost', () => undefined);
  const logs: string[] = [];
  t.mock.method(console, 'log', (text: string) => logs.push(text));
  const ctx = makeReplContext();
  updateCostTotals(ctx);
  assert.equal(ctx.state.costTotals.knownCostUSD, 0);
  assert.equal(ctx.state.costTotals.estimatedCostUSD, 0.01);
  restoreSessionState(ctx, ctx.state);
  assert.match(logs.join('\n'), /0.0000 known subtotal/);
  assert.match(logs.join('\n'), /0.0100 usage estimate/);
  assert.doesNotMatch(logs.join('\n'), /0.0100 known subtotal/);
});
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function makeTarget(root: string): AgentTargetContext {
  return { targetRoot: root, workspaceRoot: null, project: null, source: 'cwd', cwd: root };
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
  ctx.rl = { pause: () => undefined, resume: () => undefined, prompt: () => undefined } as unknown as ReplContext['rl'];
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
  return ctx;
}

describe('review card usage scope', () => {
  test('card tokens are per-turn deltas, not session cumulative', async () => {
    const root = mkdtempSync(join(tmpdir(), 'babel-review-scope-'));
    roots.push(root);
    const target = makeTarget(root);

    // Session already consumed 1000 in / 500 out before this turn.
    globalCostTracker.trackUsage('test-model', 1000, 500);

    let streamedDone = false;
    const mockEngine = {
      getTaskAllowanceSnapshot: () => null,
      submitMessageStream: async function* (): AsyncGenerator<ChatEvent> {
        yield { type: 'thinking' } as ChatEvent;
        if (!streamedDone) {
          // This turn consumes 30 in / 20 out.
          globalCostTracker.trackUsage('test-model', 30, 20);
          streamedDone = true;
        }
        const summary = globalCostTracker.getSessionSummary();
        yield {
          type: 'done',
          answer: 'Answered.',
          usage: summary,
          outcome: 'NO_CHANGE_REQUIRED',
        } as ChatEvent;
      },
      abortTurn: () => undefined,
      cancel: () => undefined,
    };

    const ctx = makeReplContext();
    const logs: string[] = [];
    const originalLog = console.log.bind(console);
    const originalError = console.error.bind(console);
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    };
    console.error = (...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    };
    try {
      await executeChatTask(ctx, 'quick question', 'quick question', target, undefined, {
        gatherPreflight: async () => undefined,
        engineFactory: () => mockEngine as unknown as ChatEngineType,
      });
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }

    const out = stripAnsi(logs.join('\n'));
    assert.match(out, /50 cumulative tokens this turn/, `expected per-turn token delta on the card, got:\n${out.slice(-800)}`);
    assert.doesNotMatch(
      out,
      /1,550 cumulative tokens this turn/,
      `session-cumulative tokens must not appear as the card's token figure:\n${out.slice(-800)}`,
    );
  });

  test('conversational no-change card does not echo the assistant answer as Summary', async () => {
    const root = mkdtempSync(join(tmpdir(), 'babel-review-summary-'));
    roots.push(root);
    const target = makeTarget(root);
    const answer =
      "I'm ready to help. What would you like me to work on? I can investigate code.";

    const mockEngine = {
      getTaskAllowanceSnapshot: () => null,
      submitMessageStream: async function* (): AsyncGenerator<ChatEvent> {
        yield { type: 'thinking' } as ChatEvent;
        yield { type: 'answer_chunk', text: answer } as ChatEvent;
        globalCostTracker.trackUsage('test-model', 30, 20);
        const summary = globalCostTracker.getSessionSummary();
        yield {
          type: 'done',
          answer,
          usage: summary,
          outcome: 'NO_CHANGE_REQUIRED',
        } as ChatEvent;
      },
      abortTurn: () => undefined,
      cancel: () => undefined,
    };

    const ctx = makeReplContext();
    const logs: string[] = [];
    const originalLog = console.log.bind(console);
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    };
    try {
      await executeChatTask(ctx, '?', '?', target, undefined, {
        gatherPreflight: async () => undefined,
        engineFactory: () => mockEngine as unknown as ChatEngineType,
      });
    } finally {
      console.log = originalLog;
    }

    const out = stripAnsi(logs.join('\n'));
    assert.doesNotMatch(out, /\nSummary\n/);
    assert.match(out, /this turn/);
  });
});
