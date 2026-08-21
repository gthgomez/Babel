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
import type { AgentTargetContext } from '../../services/targetResolver.js';

const roots: string[] = [];
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
    assert.match(out, /50 tok/, `expected per-turn token delta on the card, got:\n${out.slice(-800)}`);
    assert.doesNotMatch(
      out,
      /1550 tok/,
      `session-cumulative tokens must not appear as the card's token figure:\n${out.slice(-800)}`,
    );
  });
});
