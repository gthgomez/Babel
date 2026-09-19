import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { describe, test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ChatEngine, type ChatEngineOptions, type ChatEvent, type ChatResult } from '../../agent/chatEngine.js';
import { BabelRepl } from '../BabelRepl.js';
import type { ReplContext } from '../context.js';
import { globalCostTracker } from '../../services/costTracker.js';
import type { AgentTargetContext } from '../../services/targetResolver.js';
import { executeChatTask } from './chat.js';
import { OpenCodeGoApiRunner } from '../../runners/openCodeGoApi.js';
import { babelReviewModelPolicy } from '../../services/babelChatReview.js';

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

function createMockEngine(
  result: ChatResult,
  hooks?: {
    onSubmit?: () => void;
    onCreate?: () => void;
  },
): ChatEngine {
  return {
    submitMessage: async () => {
      hooks?.onSubmit?.();
      return result;
    },
    submitMessageStream: async function* () {
      hooks?.onSubmit?.();
      if (result.status === 'failed') {
        yield { type: 'failed', error: result.answer } as ChatEvent;
        return;
      }
      yield { type: 'done', answer: result.answer, usage: result.usage } as ChatEvent;
    },
    cancel: () => undefined,
    abortTurn: () => undefined,
  } as unknown as ChatEngine;
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
  } as unknown as ReplContext['rl'];
  ctx.turns = [];
  ctx.turnCounter = 0;
  ctx.chatEngine = undefined;
  ctx.lastAssistantAnswer = null;
  ctx.lastAssistantStatus = null;
  ctx.lastResolvedTask = null;
  ctx.lastRunDir = null;
  ctx.lastTargetRoot = null;
  ctx.lastWorkspaceRoot = null;
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

function withStdoutIsTTY<T>(value: boolean, fn: () => Promise<T> | T): Promise<T> {
  const stdout = process.stdout as { isTTY?: boolean };
  const orig = stdout.isTTY;
  stdout.isTTY = value;
  return Promise.resolve(fn()).finally(() => {
    if (orig === undefined) {
      delete stdout.isTTY;
    } else {
      stdout.isTTY = orig;
    }
  });
}

function withEnvUnset<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
  const prev = process.env[key];
  delete process.env[key];
  return Promise.resolve(fn()).finally(() => {
    if (prev === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = prev;
    }
  });
}

const noGitPreflight = async () => undefined;

function sseCompletion(text: string): Response {
  return new Response(
    `data: ${JSON.stringify({
      model: 'mimo-v2.5',
      choices: [{ delta: { content: text }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    })}\n\ndata: [DONE]\n\n`,
    { status: 200 },
  );
}

const testDeps = {
  gatherPreflight: noGitPreflight,
};

describe('executeChatTask integration', { concurrency: 1 }, () => {
test('executeChatTask sets ctx.isRunning true during run and false after', async () => {
  await withStdoutIsTTY(false, async () => {
    await withEnvUnset('CI', async () => {
      const ctx = makeReplContext();
      const target = makeTarget();
      let runningDuringSubmit = false;

      const engineFactory = () =>
        createMockEngine(
          {
            status: 'completed',
            answer: 'done',
            usage: EMPTY_USAGE,
            conversation: [],
          },
          {
            onSubmit: () => {
              runningDuringSubmit = ctx.isRunning;
            },
          },
        );

      await executeChatTask(ctx, 'hello', 'hello', target, undefined, {
        ...testDeps,
        engineFactory,
      });

      assert.equal(runningDuringSubmit, true);
      assert.equal(ctx.isRunning, false);
    });
  });
});

test('executeChatTask reuses ctx.chatEngine on second call', async () => {
  await withStdoutIsTTY(false, async () => {
    await withEnvUnset('CI', async () => {
      const ctx = makeReplContext();
      const target = makeTarget();
      const sharedEngine = createMockEngine({
        status: 'completed',
        answer: 'first',
        usage: EMPTY_USAGE,
        conversation: [],
      });

      let factoryCallCount = 0;
      const engineFactory = (_options: ChatEngineOptions) => {
        factoryCallCount += 1;
        return sharedEngine;
      };

      await executeChatTask(ctx, 'first', 'first', target, undefined, {
        ...testDeps,
        engineFactory,
      });
      assert.equal(factoryCallCount, 1);
      assert.equal(ctx.chatEngine, sharedEngine);

      await executeChatTask(ctx, 'second', 'second', target, undefined, {
        ...testDeps,
        engineFactory,
      });
      assert.equal(factoryCallCount, 1, 'factory should not run when engine already on ctx');
      assert.equal(ctx.chatEngine, sharedEngine);
    });
  });
});

test('executeChatTask creates new engine when ctx.chatEngine is undefined', async () => {
  await withStdoutIsTTY(false, async () => {
    await withEnvUnset('CI', async () => {
      const ctx = makeReplContext();
      const target = makeTarget();
      const created: ChatEngine[] = [];

      const engineFactory = (_options: ChatEngineOptions) => {
        const engine = createMockEngine({
          status: 'completed',
          answer: 'created',
          usage: EMPTY_USAGE,
          conversation: [],
        });
        created.push(engine);
        return engine;
      };

      assert.equal(ctx.chatEngine, undefined);
      await executeChatTask(ctx, 'task', 'task', target, undefined, {
        ...testDeps,
        engineFactory,
      });

      assert.equal(created.length, 1);
      assert.equal(ctx.chatEngine, created[0]);
    });
  });
});

test('executeChatTask forwards the truthful runtime mode into provider-bound prompts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-chat-entry-mode-'));
  const runsDir = join(root, 'runs');
  mkdirSync(runsDir);
  const originalFetch = globalThis.fetch;
  const originalCi = process.env['CI'];
  const originalNoColor = process.env['NO_COLOR'];
  const originalProfile = process.env['BABEL_EXECUTION_PROFILE'];
  const originalReadOnly = process.env['BABEL_READ_ONLY'];
  const stdout = process.stdout as { isTTY?: boolean };
  const originalIsTTY = stdout.isTTY;
  const prompts: string[] = [];
  const factoryModes: string[] = [];
  const ctx = makeReplContext();
  const target = makeTarget(root);

  delete process.env['CI'];
  delete process.env['NO_COLOR'];
  process.env['BABEL_EXECUTION_PROFILE'] = 'read_only_audit';
  process.env['BABEL_READ_ONLY'] = 'true';
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as {
      messages: Array<{ role: string; content: string }>;
    };
    prompts.push(body.messages.find((message) => message.role === 'system')?.content ?? '');
    return sseCompletion('entry mode fixture');
  };

  const run = async (isTTY: boolean) => {
    stdout.isTTY = isTTY;
    await executeChatTask(ctx, 'inspect runtime mode', 'inspect runtime mode', target, undefined, {
      ...testDeps,
      engineFactory: (options) => {
        factoryModes.push(options.runtimeMode ?? 'missing');
        return new ChatEngine({
          ...options,
          providerRunner: new OpenCodeGoApiRunner(
            'mimo-v2.5',
            {},
            { credentialSource: 'explicit-test', explicitCredential: 'fixture-only' },
          ),
          providerPolicy: babelReviewModelPolicy('mimo-v2.5', root),
        });
      },
    });
  };

  try {
    await run(false);
    await run(true);
    assert.deepEqual(factoryModes, ['headless'], 'the second TUI turn must reuse the engine');
    assert.equal(prompts.length, 2);
    assert.match(prompts[0] ?? '', /Runtime mode: headless\./);
    assert.match(prompts[1] ?? '', /Runtime mode: tui\./);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalIsTTY === undefined) delete stdout.isTTY;
    else stdout.isTTY = originalIsTTY;
    for (const [key, value] of [
      ['CI', originalCi],
      ['NO_COLOR', originalNoColor],
      ['BABEL_EXECUTION_PROFILE', originalProfile],
      ['BABEL_READ_ONLY', originalReadOnly],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test('executeChatTask prints answer to stdout in non-TTY mode', async () => {
  await withStdoutIsTTY(false, async () => {
    await withEnvUnset('CI', async () => {
      const ctx = makeReplContext();
      const target = makeTarget();
      const writes: string[] = [];
      const originalLog = console.log;
      console.log = ((line?: unknown) => {
        writes.push(String(line ?? ''));
      }) as typeof console.log;

      try {
        await executeChatTask(ctx, 'ask', 'ask', target, undefined, {
          ...testDeps,
          engineFactory: () =>
            createMockEngine({
              status: 'completed',
              answer: 'visible answer',
              usage: EMPTY_USAGE,
              conversation: [],
            }),
        });
      } finally {
        console.log = originalLog;
      }

      assert.ok(writes.some((line) => line.includes('visible answer')));
    });
  });
});

test('executeChatTask calls appendTurn and updates conversation memory on success', async () => {
  await withStdoutIsTTY(false, async () => {
    await withEnvUnset('CI', async () => {
      const ctx = makeReplContext();
      const target = makeTarget();
      let appendTurnCalls = 0;
      const originalAppendTurn = ctx.appendTurn;
      ctx.appendTurn = (turn) => {
        appendTurnCalls += 1;
        return originalAppendTurn.call(ctx, turn);
      };

      await executeChatTask(ctx, 'summarize', 'summarize', target, undefined, {
        ...testDeps,
        engineFactory: () =>
          createMockEngine({
            status: 'completed',
            answer: 'summary text',
            usage: EMPTY_USAGE,
            conversation: [],
          }),
      });

      assert.equal(appendTurnCalls, 1);
      assert.equal(ctx.lastAssistantAnswer, 'summary text');
      assert.equal(ctx.lastAssistantStatus, 'ANSWER_READY');
      assert.equal(ctx.state.lastRunUserStatus, 'complete');
      assert.equal(ctx.turns.length, 1);
      assert.equal(ctx.turns[0]?.answer, 'summary text');
    });
  });
});

test('executeChatTask sets lastRunUserStatus to failed on engine failure', async () => {
  await withStdoutIsTTY(false, async () => {
    await withEnvUnset('CI', async () => {
      const ctx = makeReplContext();
      const target = makeTarget();

      await executeChatTask(ctx, 'fail task', 'fail task', target, undefined, {
        ...testDeps,
        engineFactory: () =>
          createMockEngine({
            status: 'failed',
            answer: 'model unavailable',
            usage: EMPTY_USAGE,
            conversation: [],
          }),
      });

      assert.equal(ctx.state.lastRunUserStatus, 'failed');
      assert.equal(ctx.lastAssistantStatus, 'NEEDS_MORE_CONTEXT');
      assert.equal(ctx.lastAssistantAnswer, 'model unavailable');
    });
  });
});

// D03 (C1): the production TUI card renderer must receive the structured reason
// from the ChatResult, not just the durable-session projection. Regression for
// the original defect where recovery exhaustion printed
// "Review the blocked capability".
test('executeChatTask renders recovery-exhaustion guidance in the TUI card', async () => {
  await withStdoutIsTTY(false, async () => {
    await withEnvUnset('CI', async () => {
      const ctx = makeReplContext();
      const target = makeTarget();
      const writes: string[] = [];
      const originalLog = console.log;
      console.log = ((line?: unknown) => {
        writes.push(String(line ?? ''));
      }) as typeof console.log;

      const terminalResult: ChatResult = {
        status: 'blocked',
        outcome: 'BLOCKED_POLICY',
        reason_code: 'recovery_exhausted',
        cause_class: 'model',
        answer: 'Repeated no-progress after recovery (8 cycles)',
        usage: EMPTY_USAGE,
        conversation: [],
        blockedReport: {
          schema_version: 1,
          status: 'BLOCKED',
          reason: 'Repeated no-progress after recovery',
          missing: 'Semantic progress',
          reason_code: 'recovery_exhausted',
          cause_class: 'model',
          checked: [{ action: 'progress_terminal', target: 'progress', finding: '8 cycles' }],
        },
      };

      const mockEngine = {
        submitMessage: async () => terminalResult,
        submitMessageStream: async function* () {
          yield {
            type: 'done',
            answer: terminalResult.answer,
            usage: EMPTY_USAGE,
            status: 'blocked',
            outcome: 'BLOCKED_POLICY',
            reason_code: 'recovery_exhausted',
            cause_class: 'model',
            blockedReport: terminalResult.blockedReport,
          } as ChatEvent;
        },
        cancel: () => undefined,
        abortTurn: () => undefined,
      } as unknown as ChatEngine;

      try {
        await executeChatTask(
          ctx,
          'investigate the repo',
          'investigate the repo',
          target,
          undefined,
          { ...testDeps, engineFactory: () => mockEngine },
        );
      } finally {
        console.log = originalLog;
      }

      const rendered = writes.join('\n');
      assert.match(rendered, /No progress after recovery/);
      assert.match(rendered, /Inspect diagnostics/);
      assert.match(rendered, /Narrow scope/);
      assert.doesNotMatch(rendered, /Review the blocked capability/);
      assert.doesNotMatch(rendered, /Review permission/);
    });
  });
});
});
