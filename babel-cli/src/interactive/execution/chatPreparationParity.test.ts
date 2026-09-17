/**
 * F2: TUI / headless / direct Chat preparation parity.
 *
 * Captures the actual provider-bound POST body from:
 *   1. fresh headless Chat (runChatEngineOnce factory path)
 *   2. reused interactive/TUI Chat engine (supplied engine, no factory)
 *   3. equivalently configured direct ChatEngine
 *
 * Normalize only generated IDs/timestamps/temp paths. Do not fabricate the
 * expected wire payload — the three production paths must agree with each other
 * and the request must contain the compiled stack + intent plan.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ChatEngine } from '../../agent/chatEngine.js';
import { resolveChatEngineLimits } from '../../config/chatEngineLimits.js';
import { resolveChatTaskClass } from '../../config/chatTaskClass.js';
import { OpenCodeGoApiRunner } from '../../runners/openCodeGoApi.js';
import { babelReviewModelPolicy } from '../../services/babelChatReview.js';
import type { AgentTargetContext } from '../../services/targetResolver.js';
import {
  compileChatStackForRun,
  compileIntentPlanUserMessage,
  runChatEngineOnce,
} from './chatCore.js';

type WireMessage = {
  role: string;
  content: string;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
  name?: string;
};

type CapturedRequest = {
  model: string;
  messages: WireMessage[];
  toolNames: string[];
  toolChoice: unknown;
  maxTokens: unknown;
};

function sseCompletion(text: string): Response {
  return new Response(
    `data: ${JSON.stringify({
      model: 'mimo-v2.5',
      choices: [{ delta: { content: text }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
    })}\n\ndata: [DONE]\n\n`,
    { status: 200 },
  );
}

function makeTarget(root: string): AgentTargetContext {
  return {
    targetRoot: root,
    workspaceRoot: null,
    project: null,
    source: 'cwd',
    cwd: root,
  };
}

function normalizeText(value: string, root: string): string {
  const rootPosix = root.replace(/\\/g, '/');
  return value
    .split(root).join('<ROOT>')
    .split(rootPosix).join('<ROOT>')
    .replace(/\\/g, '/')
    .replace(/Runtime mode: (?:tui|headless|direct)\./g, 'Runtime mode: <MODE>.')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi, '<ID>')
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.Z+-]+/g, '<TS>');
}

function normalizeValue(value: unknown, root: string): unknown {
  if (typeof value === 'string') return normalizeText(value, root);
  if (Array.isArray(value)) return value.map((entry) => normalizeValue(entry, root));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = normalizeValue(entry, root);
    }
    return out;
  }
  return value;
}

describe('chat preparation parity (actual provider-bound request)', () => {
  it('clears omitted optional state when a reused engine changes roots', () => {
    const firstRoot = mkdtempSync(join(tmpdir(), 'babel-prep-first-'));
    const secondRoot = mkdtempSync(join(tmpdir(), 'babel-prep-second-'));
    try {
      const engine = new ChatEngine({
        task: 'previous task',
        instructionRoot: firstRoot,
        projectRoot: firstRoot,
        systemContext: 'old system context',
        appendSystemPrompt: 'old append prompt',
        preflightContext: 'old preflight',
        model: 'mimo-v2.5',
        executionProfile: 'chat',
        runtimeMode: 'tui',
        providerRunner: new OpenCodeGoApiRunner(
          'mimo-v2.5',
          {},
          { credentialSource: 'explicit-test', explicitCredential: 'fixture-only' },
        ),
        providerPolicy: babelReviewModelPolicy('mimo-v2.5', firstRoot),
      });

      engine.applyTurnPreparation({
        task: 'new task',
        projectRoot: secondRoot,
      });

      const options = (engine as unknown as {
        options: Record<string, unknown>;
      }).options;
      assert.equal(options.projectRoot, secondRoot);
      assert.equal(options.instructionRoot, undefined);
      assert.equal(options.systemContext, undefined);
      assert.equal(options.appendSystemPrompt, undefined);
      assert.equal(options.preflightContext, undefined);
      assert.equal(options.model, undefined);
      assert.equal(options.executionProfile, undefined);
      assert.equal(options.runtimeMode, undefined);
    } finally {
      rmSync(firstRoot, { recursive: true, force: true });
      rmSync(secondRoot, { recursive: true, force: true });
    }
  });

  it('achieves 100% parity on system prompt, intent plan, limits, tools, and wire payload', async () => {
    const root = mkdtempSync(join(tmpdir(), 'babel-prep-parity-'));
    const source = join(root, 'source');
    mkdirSync(source);
    writeFileSync(join(source, 'src-chart.ts'), 'export function density() { return 0 }\n');
    const runsDir = join(root, 'runs');
    mkdirSync(runsDir);

    const task = 'Fix the histogram density range calculation in src-chart.ts';
    const systemContext = 'FROZEN_SESSION_IDENTITY';
    const preflightContext = 'FROZEN_PREFLIGHT';
    const target = makeTarget(source);

    const envKeys: Record<string, string> = {
      BABEL_EXECUTION_PROFILE: 'read_only_audit',
      BABEL_READ_ONLY: 'true',
      BABEL_PROJECT_ROOT: source,
      BABEL_RUNS_DIR: runsDir,
      BABEL_COMPACTION: 'off',
      BABEL_MEMORY_WRITEBACK: '0',
    };
    const previous = Object.fromEntries(Object.keys(envKeys).map((key) => [key, process.env[key]]));
    Object.assign(process.env, envKeys);

    const captures: CapturedRequest[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as {
        model: string;
        messages: WireMessage[];
        tools?: Array<{ function: { name: string } }>;
        tool_choice?: unknown;
        max_tokens?: unknown;
      };
      captures.push({
        model: body.model,
        messages: body.messages,
        toolNames: (body.tools ?? []).map((tool) => tool.function.name).sort(),
        toolChoice: body.tool_choice ?? null,
        maxTokens: body.max_tokens ?? null,
      });
      return sseCompletion('Parity fixture complete.');
    };

    const runner = new OpenCodeGoApiRunner(
      'mimo-v2.5',
      {},
      { credentialSource: 'explicit-test', explicitCredential: 'fixture-only' },
    );
    const providerPolicy = babelReviewModelPolicy('mimo-v2.5', source);
    const embed = { providerRunner: runner, providerPolicy };

    try {
      const firstCapture = async (run: () => Promise<unknown>, label: string): Promise<CapturedRequest> => {
        const start = captures.length;
        await run();
        const captured = captures[start];
        assert.ok(captured, `${label} must issue a provider request`);
        return captured;
      };

      let headlessEngine: ChatEngine | undefined;
      const headless = await firstCapture(
        () =>
          runChatEngineOnce({
            task,
            target,
            systemContext,
            preflightContext,
            runtimeMode: 'headless',
            useStreaming: true,
            engineFactory: (options) => {
              headlessEngine = new ChatEngine({ ...options, ...embed });
              return headlessEngine;
            },
          }),
        'headless Chat',
      );

      const reusedEngine = new ChatEngine({
        task: 'previous investigate: explain the repo layout',
        projectRoot: source,
        ...embed,
      });
      const tui = await firstCapture(
        () =>
          runChatEngineOnce({
            task,
            target,
            systemContext,
            preflightContext,
            runtimeMode: 'tui',
            engine: reusedEngine,
            useStreaming: true,
            engineFactory: () => {
              throw new Error('Factory must not run when a TUI engine is supplied');
            },
          }),
        'reused TUI Chat',
      );
      const tuiSecondTurn = await firstCapture(
        () =>
          runChatEngineOnce({
            task,
            target,
            runtimeMode: 'tui',
            engine: reusedEngine,
            useStreaming: true,
          }),
        'reused second TUI turn',
      );
      assert.match(
        tuiSecondTurn.messages.find((message) => message.role === 'system')?.content ?? '',
        /Runtime mode: tui\./,
      );

      const intentClass = resolveChatTaskClass({ taskText: task, autoClassify: false });
      const limitsClass = resolveChatTaskClass({ taskText: task, autoClassify: true });
      const limits = resolveChatEngineLimits({}, undefined, {
        taskClass: limitsClass,
        taskText: task,
      });
      const chatStack = compileChatStackForRun({ projectRoot: source, task });
      const stackSystemContext = [systemContext, chatStack.system_context]
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        .join('\n\n');
      const intentPlanUserMessage = compileIntentPlanUserMessage(task, intentClass);
      const directEngine = new ChatEngine({
        task,
        projectRoot: source,
        ...(stackSystemContext ? { systemContext: stackSystemContext } : {}),
        preflightContext,
        ...(intentPlanUserMessage ? { intentPlanUserMessage } : {}),
        maxTurns: limits.maxTurns,
        maxConversationMessages: limits.maxConversationMessages,
        maxEstimatedTokens: limits.maxEstimatedTokens,
        runtimeMode: 'direct',
        ...embed,
      });
      const direct = await firstCapture(async () => {
        for await (const event of directEngine.submitMessageStream(task)) {
          if (event.type === 'done' || event.type === 'failed' || event.type === 'cancelled') break;
        }
      }, 'direct ChatEngine');

      const normHeadless = normalizeValue(headless, source);
      const normTui = normalizeValue(tui, source);
      const normDirect = normalizeValue(direct, source);

      const headlessSystemPrompt = headless.messages.find((message) => message.role === 'system')?.content ?? '';
      const tuiSystemPrompt = tui.messages.find((message) => message.role === 'system')?.content ?? '';
      const directSystemPrompt = direct.messages.find((message) => message.role === 'system')?.content ?? '';
      assert.match(headlessSystemPrompt, /Runtime mode: headless\./);
      assert.match(tuiSystemPrompt, /Runtime mode: tui\./);
      assert.match(directSystemPrompt, /Runtime mode: direct\./);

      assert.deepEqual(
        normTui,
        normHeadless,
        'TUI reused engine provider POST must match fresh headless Chat',
      );
      assert.deepEqual(
        normDirect,
        normHeadless,
        'direct ChatEngine provider POST must match fresh headless Chat',
      );

      const systemPrompt = headlessSystemPrompt;
      assert.match(systemPrompt, /FROZEN_SESSION_IDENTITY/);
      if (chatStack.system_context.trim()) {
        assert.ok(
          systemPrompt.includes(chatStack.system_context.slice(0, Math.min(80, chatStack.system_context.length))),
          'compiled chat stack must appear in the actual system prompt',
        );
      }
      assert.match(systemPrompt, /FROZEN_PREFLIGHT/);

      const userContents = headless.messages
        .filter((message) => message.role === 'user')
        .map((message) => message.content)
        .join('\n');
      assert.match(userContents, /histogram density range/);
      assert.ok(intentPlanUserMessage, 'frozen execute task must compile an intent plan');
      assert.match(userContents, /## Intent Plan/);
      assert.ok(
        userContents.includes(intentPlanUserMessage!),
        'actual provider request must contain the intent-plan user message',
      );

      assert.equal(headless.model, 'mimo-v2.5');
      assert.ok(headless.toolNames.length > 0, 'native request must declare tools');
      assert.deepEqual(tui.toolNames, headless.toolNames);
      assert.deepEqual(direct.toolNames, headless.toolNames);

      const headlessLimits = (headlessEngine as unknown as { limits: typeof limits }).limits;
      const tuiLimits = (reusedEngine as unknown as { limits: typeof limits }).limits;
      const directLimits = (directEngine as unknown as { limits: typeof limits }).limits;
      assert.equal(headlessLimits.maxTurns, limits.maxTurns);
      assert.equal(tuiLimits.maxTurns, limits.maxTurns);
      assert.equal(directLimits.maxTurns, limits.maxTurns);
      assert.equal(headlessLimits.maxEstimatedTokens, tuiLimits.maxEstimatedTokens);
      assert.equal(headlessLimits.maxConversationMessages, tuiLimits.maxConversationMessages);

      const tuiIntent = (reusedEngine as unknown as { options: { intentPlanUserMessage?: string } }).options
        .intentPlanUserMessage;
      assert.ok(tuiIntent);
      assert.match(tuiIntent!, /## Intent Plan/);
    } finally {
      globalThis.fetch = originalFetch;
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
});
