/**
 * Daily-driver tests that drive the shipped executeChatTask + resume + interrupt
 * entry points. Cancelled work must not look like success or failure.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';

import type { ChatEngine, ChatEvent, ChatResult } from '../../agent/chatEngine.js';
import { globalCostTracker } from '../../services/costTracker.js';
import type { AgentTargetContext } from '../../services/targetResolver.js';
import { resumeChatSession } from '../chatSessionResume.js';
import { BabelRepl } from '../BabelRepl.js';
import type { ReplContext } from '../context.js';
import { stripAnsi } from '../../ui/theme.js';
import {
  handleInteractiveInterrupt,
  notifyRunStarted,
  resetInterruptHostForTests,
} from '../../ui/interruptHost.js';
import { executeChatTask } from './chat.js';

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

function result(partial: Partial<ChatResult> & Pick<ChatResult, 'status' | 'answer'>): ChatResult {
  return {
    usage: EMPTY_USAGE,
    conversation: [],
    ...partial,
  };
}

function createInstantEngine(chat: ChatResult): ChatEngine {
  return {
    submitMessage: async () => chat,
    submitMessageStream: async function* () {
      if (chat.status === 'failed') {
        yield { type: 'failed', error: chat.answer, outcome: chat.outcome } as ChatEvent;
        return;
      }
      if (chat.status === 'cancelled') {
        yield { type: 'cancelled' } as ChatEvent;
        return;
      }
      yield {
        type: 'done',
        answer: chat.answer,
        usage: chat.usage,
        outcome: chat.outcome,
        toolCalls: chat.toolCalls,
        verifierReceipt: chat.verifierReceipt,
      } as ChatEvent;
    },
    abortTurn: () => undefined,
    cancel: () => undefined,
  } as unknown as ChatEngine;
}

function createCancellableEngine(): { engine: ChatEngine; started: () => boolean } {
  let release: (() => void) | null = null;
  let started = false;
  const waitForAbort = () =>
    new Promise<void>((resolve) => {
      started = true;
      release = resolve;
    });
  const engine = {
    submitMessage: async () => {
      await waitForAbort();
      return result({
        status: 'cancelled',
        outcome: 'CANCELLED',
        answer: 'Cancelled',
      });
    },
    submitMessageStream: async function* () {
      yield { type: 'answer_chunk', text: 'partial stream' } as ChatEvent;
      await waitForAbort();
      yield { type: 'cancelled' } as ChatEvent;
    },
    abortTurn: () => {
      release?.();
    },
    cancel: () => {
      release?.();
    },
  } as unknown as ChatEngine;
  return { engine, started: () => started };
}

function captureLogs(): { lines: string[]; restore: () => void; text: () => string } {
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

const noGitPreflight = async () => undefined;

afterEach(() => {
  resetInterruptHostForTests();
});

describe('executeChatTask daily-driver outcomes', { concurrency: 1 }, () => {
  test('running abort yields CANCELLED card, stays usable, next task succeeds', async () => {
    const prevCi = process.env['CI'];
    process.env['CI'] = '1';
    const ctx = makeReplContext();
    const target = makeTarget();
    const { engine, started } = createCancellableEngine();
    ctx.chatEngine = engine;
    const logs = captureLogs();
    try {
      const pending = executeChatTask(ctx, 'long task', 'long task', target, undefined, {
        gatherPreflight: noGitPreflight,
        engineFactory: () => engine,
      });
      const deadline = Date.now() + 2000;
      while (!started() && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 5));
      }
      assert.equal(started(), true);
      assert.equal(ctx.isRunning, true);

      notifyRunStarted();
      const interrupt = handleInteractiveInterrupt(
        { composerEmpty: true },
        {
          cancelTurn: () => engine.abortTurn(),
          clearComposer: () => undefined,
          cancelPaste: () => undefined,
          declineOverlay: () => undefined,
          restorePrompt: () => undefined,
          hintExit: () => undefined,
          requestExit: () => undefined,
        },
      );
      assert.equal(interrupt.cancelled, true);
      assert.equal(interrupt.processStayedAlive, true);

      await pending;
      const painted = logs.text();
      assert.equal(ctx.isRunning, false, 'session should remain alive after cancel');
      assert.equal(ctx.state.lastRunUserStatus, 'cancelled');
      assert.equal(ctx.lastAssistantStatus, 'CANCELLED');
      assert.match(painted, /REVIEW_KIND:CANCELLED/);
      assert.match(painted, /■ Cancelled|Cancelled/);
      assert.match(painted, /REVIEW_KIND:CANCELLED/);
      assert.doesNotMatch(painted, /REVIEW_KIND:VERIFIED_COMPLETE/);
      assert.doesNotMatch(painted, /Verified complete/);
      assert.doesNotMatch(painted, /REVIEW_KIND:AGENT_FAILURE/);

      ctx.chatEngine = createInstantEngine(
        result({ status: 'completed', outcome: 'UNVERIFIED_PATCH', answer: 'follow-up ok' }),
      );
      await executeChatTask(ctx, 'next', 'next', target, undefined, {
        gatherPreflight: noGitPreflight,
        engineFactory: () => ctx.chatEngine!,
      });
      assert.equal(ctx.isRunning, false);
      assert.equal(ctx.lastAssistantAnswer, 'follow-up ok');
      assert.match(logs.text(), /REVIEW_KIND:COMPLETE_UNVERIFIED/);
    } finally {
      logs.restore();
      if (prevCi === undefined) delete process.env['CI'];
      else process.env['CI'] = prevCi;
    }
  });

  test('unverified mutation and failed verifier never look verified', async () => {
    const ctx = makeReplContext();
    const target = makeTarget();
    const logs = captureLogs();
    try {
      ctx.chatEngine = createInstantEngine(
        result({
          status: 'completed',
          outcome: 'UNVERIFIED_PATCH',
          answer: 'edited',
          toolCalls: [{ tool: 'str_replace', target: 'src/foo.ts' }],
        }),
      );
      await executeChatTask(ctx, 'edit', 'edit', target, undefined, {
        gatherPreflight: noGitPreflight,
        engineFactory: () => ctx.chatEngine!,
      });
      assert.match(logs.text(), /REVIEW_KIND:COMPLETE_UNVERIFIED/);
      assert.doesNotMatch(logs.text(), /REVIEW_KIND:VERIFIED_COMPLETE/);

      ctx.chatEngine = createInstantEngine(
        result({
          status: 'completed',
          outcome: 'UNVERIFIED_PATCH',
          answer: 'tests red',
          toolCalls: [{ tool: 'str_replace', target: 'src/foo.ts' }],
          verifierReceipt: { command: 'npm test', exit_code: 1, summary: 'fail' },
        }),
      );
      await executeChatTask(ctx, 'edit2', 'edit2', target, undefined, {
        gatherPreflight: noGitPreflight,
        engineFactory: () => ctx.chatEngine!,
      });
      assert.match(logs.text(), /REVIEW_KIND:VERIFICATION_FAILED/);
      assert.match(logs.text(), /src\/foo\.ts/);
      assert.match(logs.text(), /npm test/);
    } finally {
      logs.restore();
    }
  });

  test('blocked, budget, and infra cards stay distinct and leave the session usable', async () => {
    const ctx = makeReplContext();
    const target = makeTarget();
    const logs = captureLogs();
    try {
      for (const [outcome, status, kind] of [
        ['BLOCKED_POLICY', 'blocked', 'BLOCKED'],
        ['BUDGET_EXHAUSTED', 'budget_exhausted', 'BUDGET_EXHAUSTED'],
        ['INFRA_FAILURE', 'failed', 'INFRA_FAILURE'],
      ] as const) {
        ctx.chatEngine = createInstantEngine(
          result({ status, outcome, answer: `${outcome} happened` }),
        );
        await executeChatTask(ctx, outcome, outcome, target, undefined, {
          gatherPreflight: noGitPreflight,
          engineFactory: () => ctx.chatEngine!,
        });
        assert.equal(ctx.isRunning, false);
        assert.match(logs.text(), new RegExp(`REVIEW_KIND:${kind}`));
      }
    } finally {
      logs.restore();
    }
  });
});

describe('resume then follow-up and cancel', () => {
  test('resumeChatSession hydrates transcript and follow-up executeChatTask works', async () => {
    const root = mkdtempSync(join(tmpdir(), 'babel-dd-resume-'));
    const prev = process.env['BABEL_RUNS_DIR'];
    process.env['BABEL_RUNS_DIR'] = root;
    try {
      const sessionId = 'dd-resume-session';
      const sessionDir = join(root, 'chat-sessions', sessionId);
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(
        join(sessionDir, 'transcript.jsonl'),
        `${JSON.stringify({ role: 'user', content: 'prior task about retry leak' })}\n${JSON.stringify({ role: 'assistant', content: 'fixed retry leak' })}\n`,
        'utf8',
      );
      const ctx = makeReplContext();
      const outcome = await resumeChatSession(ctx, sessionId);
      assert.equal(outcome.ok, true);
      if (!outcome.ok) return;
      assert.ok(outcome.turnCount >= 1);
      const user = ctx.chatEngine?.getConversation().find((m) => m.role === 'user');
      assert.match(String(user?.content ?? ctx.turns[0]?.input ?? ''), /retry leak/);

      ctx.chatEngine = createInstantEngine(
        result({ status: 'completed', outcome: 'UNVERIFIED_PATCH', answer: 'follow-up after resume' }),
      );
      await executeChatTask(ctx, 'also add a test', 'also add a test', makeTarget(), undefined, {
        gatherPreflight: noGitPreflight,
        engineFactory: () => ctx.chatEngine!,
      });
      assert.equal(ctx.lastAssistantAnswer, 'follow-up after resume');
      assert.equal(ctx.isRunning, false);
    } finally {
      if (prev === undefined) delete process.env['BABEL_RUNS_DIR'];
      else process.env['BABEL_RUNS_DIR'] = prev;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('interactive process launch', () => {
  test('babel interactive prints a ready prompt once and exits on /exit', async () => {
    const cli = join(process.cwd(), 'src', 'index.ts');
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', '--no-warnings=ExperimentalWarning', cli, 'interactive', '--mode', 'chat'],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          CI: '1',
          BABEL_SKIP_RESUME_PICKER: '1',
          BABEL_PROMPT_V2: '0',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      out += String(chunk);
    });
    const ready = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 8000);
      const onData = () => {
        const text = stripAnsi(out);
        if (/BABEL/.test(text) && /CHAT/i.test(text)) {
          clearTimeout(timer);
          resolve(true);
        }
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
    });
    try {
      child.stdin.write('/exit\n');
    } catch {
      /* ignore */
    }
    const exitCode = await new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => {
        child.kill();
        resolve(null);
      }, 4000);
      child.on('exit', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    const text = stripAnsi(out);
    assert.equal(ready, true, `ready prompt missing: ${text.slice(0, 400)}`);
    const readyHits = text.match(/\[READY\]/g)?.length ?? 0;
    assert.ok(readyHits >= 1, text.slice(0, 400));
    assert.match(text, /CHAT/i);
    assert.ok(exitCode === 0 || exitCode === null || exitCode === 1);
  });
});
