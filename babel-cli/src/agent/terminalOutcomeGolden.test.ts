/**
 * P0-D B4 — cross-surface TerminalOutcome goldens.
 *
 * One terminal truth must hold across:
 *   ChatResult.outcome  ↔  disk turn_ended.outcome  ↔  JSON payload.terminal_outcome
 *   ↔  user_status  ↔  exit code
 *
 * Also: budget kills never report status completed; cancel/fail retain prior tools.
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ChatEngine, type ChatEvent, type ChatResult } from './chatEngine.js';
import { buildChatRunPayload, consumeChatStream } from '../interactive/execution/chatCore.js';
import {
  exitCodeFromOutcome,
  userFacingStatusFromOutcome,
} from '../cli/userFacingStatus.js';
import {
  loadThreadEventLogFromDir,
  type ThreadEventLog,
} from './threadEventLog.js';
import { chatSessionDir } from '../cli/runsLayout.js';
import { parityOnUserTurn, parityRecordToolBatch } from './chatEngineParityBridge.js';
import type { TerminalOutcome } from '../schemas/agentContracts.js';
import type { ToolStreamEvent } from '../runners/base.js';
import { createEngineFromEventLog } from '../services/threadStore/conversationSync.js';

async function waitForThreadEventLog(
  sessionDir: string,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<ThreadEventLog> {
  const timeoutMs = opts.timeoutMs ?? 3000;
  const intervalMs = opts.intervalMs ?? 25;
  const deadline = Date.now() + timeoutMs;
  let last: ThreadEventLog | null = null;
  while (Date.now() < deadline) {
    last = loadThreadEventLogFromDir(sessionDir);
    if (last?.events.some((e) => e.kind === 'turn_ended')) {
      return last;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  assert.ok(last, `loadThreadEventLogFromDir timed out (dir=${sessionDir})`);
  assert.ok(
    last!.events.some((e) => e.kind === 'turn_ended'),
    `missing turn_ended; kinds=${last!.events.map((e) => e.kind).join(',')}`,
  );
  return last!;
}

function installMockRunner(
  engine: ChatEngine,
  runner: {
    executeWithToolsStream: (
      ...args: unknown[]
    ) => AsyncGenerator<ToolStreamEvent, void, undefined>;
    execute: () => Promise<{ type: string; answer: string }>;
    getLastInvocationMetadata: () => null;
  },
): void {
  const anyEngine = engine as unknown as {
    deliberationRunner: unknown;
    synthesisRunner: unknown;
    shouldUseNativeTools: () => boolean;
  };
  anyEngine.deliberationRunner = runner;
  anyEngine.synthesisRunner = runner;
  anyEngine.shouldUseNativeTools = () => true;
}

function assertCrossSurface(
  label: string,
  result: ChatResult,
  diskOutcome: TerminalOutcome | undefined,
): void {
  assert.ok(result.outcome, `${label}: ChatResult.outcome required`);
  assert.equal(result.outcome, diskOutcome, `${label}: ChatResult vs disk turn_ended`);

  const payload = buildChatRunPayload(result, {
    task: label,
    projectRoot: '/tmp/golden',
  });
  assert.equal(
    payload['terminal_outcome'],
    result.outcome,
    `${label}: payload.terminal_outcome`,
  );
  assert.equal(
    payload['user_status'],
    userFacingStatusFromOutcome(result.outcome!),
    `${label}: user_status from outcome`,
  );
  assert.equal(
    exitCodeFromOutcome(result.outcome!),
    result.outcome === 'VERIFIED_COMPLETE' || result.outcome === 'UNVERIFIED_PATCH' ? 0 : 1,
    `${label}: exit code`,
  );

  if (
    result.outcome === 'BLOCKED_EXTERNAL' ||
    result.outcome === 'BLOCKED_POLICY' ||
    result.outcome === 'CANCELLED' ||
    result.outcome === 'BUDGET_EXHAUSTED' ||
    result.outcome === 'AGENT_FAILURE' ||
    result.outcome === 'INFRA_FAILURE'
  ) {
    assert.notEqual(payload['user_status'], 'success', `${label}: no false success`);
    assert.notEqual(result.status, 'completed', `${label}: status not completed`);
  }
}

describe('P0-D B4 TerminalOutcome cross-surface goldens', () => {
  let projectRoot: string;

  before(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'babel-p0d-b4-'));
    writeFileSync(join(projectRoot, 'hello.txt'), 'hello golden\n', 'utf-8');
    process.env['BABEL_BENCHMARK_AUTO_APPROVE'] = '1';
  });

  after(() => {
    rmSync(projectRoot, { recursive: true, force: true });
    delete process.env['BABEL_BENCHMARK_AUTO_APPROVE'];
  });

  test('complete stream: ChatResult + disk + payload share UNVERIFIED_PATCH', async () => {
    // tools_then_complete: one read then stop — avoids execute-task text-loop / turn-limit
    // (pure text stop often auto-continues under zero-write gates).
    const engine = new ChatEngine({
      task: 'inspect hello.txt then stop',
      projectRoot,
      model: 'deepseek-v4-flash',
      maxTurns: 6,
    });
    let call = 0;
    installMockRunner(engine, {
      executeWithToolsStream: async function* () {
        call += 1;
        if (call === 1) {
          yield {
            type: 'tool_use',
            id: 'c1',
            name: 'read_file',
            input: { path: 'hello.txt' },
          };
          yield { type: 'done', finishReason: 'tool_calls' };
          return;
        }
        yield { type: 'text_delta', text: 'Task complete.' };
        yield { type: 'done', finishReason: 'stop' };
      },
      execute: async () => ({ type: 'completion', answer: 'Task complete.' }),
      getLastInvocationMetadata: () => null,
    });

    const result = await consumeChatStream(
      engine.submitMessageStream('Read hello.txt then finish'),
      null,
    );
    const loaded = await waitForThreadEventLog(chatSessionDir(engine.getEngineRunId()));
    const diskOutcome = loaded.events.filter((e) => e.kind === 'turn_ended').at(-1)?.outcome;

    assert.ok(
      result.outcome === 'UNVERIFIED_PATCH' || result.outcome === 'VERIFIED_COMPLETE',
      `expected complete-family outcome, got ${result.outcome}; answer=${result.answer?.slice(0, 120)}`,
    );
    assert.equal(result.status, 'completed');
    assertCrossSurface('complete', result, diskOutcome);
  });

  test('failed stream retains tool_result and AGENT_FAILURE across surfaces', async () => {
    const engine = new ChatEngine({
      task: 'fail after tool',
      projectRoot,
      model: 'deepseek-v4-flash',
      maxTurns: 4,
    });
    let call = 0;
    installMockRunner(engine, {
      executeWithToolsStream: async function* () {
        call += 1;
        if (call === 1) {
          yield {
            type: 'tool_use',
            id: 'g1',
            name: 'read_file',
            input: { path: 'hello.txt' },
          };
          yield { type: 'done', finishReason: 'tool_calls' };
          return;
        }
        yield { type: 'error', message: 'provider hard failure 500' };
      },
      execute: async () => ({ type: 'completion', answer: 'x' }),
      getLastInvocationMetadata: () => null,
    });

    const result = await consumeChatStream(engine.submitMessageStream('read then fail'), null);
    const loaded = await waitForThreadEventLog(chatSessionDir(engine.getEngineRunId()));
    const ended = loaded.events.filter((e) => e.kind === 'turn_ended').at(-1);
    const tools = loaded.events.filter((e) => e.kind === 'tool_result');

    assert.equal(result.outcome, 'AGENT_FAILURE');
    assert.equal(result.status, 'failed');
    assert.ok(tools.length >= 1, 'prior tool_result must persist');
    assertCrossSurface('failed', result, ended?.outcome);

    const resumed = createEngineFromEventLog(
      { task: 'fail after tool', projectRoot, model: 'deepseek-v4-flash' },
      loaded,
    );
    assert.ok(
      resumed.getProviderConversation().some((m) => m.role === 'tool'),
      'resume must keep tool messages',
    );
  });

  test('cancel retains pre-cancel tool observation + CANCELLED everywhere', async () => {
    const engine = new ChatEngine({
      task: 'cancel mid',
      projectRoot,
      model: 'deepseek-v4-flash',
      maxTurns: 4,
    });
    parityOnUserTurn(engine.getParityRuntime(), {
      task: 'cancel mid',
      model: 'deepseek-v4-flash',
      provider: 'deepseek',
      projectRoot,
    });
    parityRecordToolBatch(engine.getParityRuntime(), {
      at_turn: 0,
      toolCalls: [
        {
          id: 'pre_cancel',
          type: 'function',
          function: { name: 'read_file', arguments: '{}' },
        },
      ],
      results: [
        {
          tool_call_id: 'pre_cancel',
          tool_name: 'read_file',
          content: 'observation-before-cancel',
          target: 'hello.txt',
          contentHash: 'h-cancel',
        },
      ],
    });
    engine.cancel();

    const loaded = await waitForThreadEventLog(chatSessionDir(engine.getEngineRunId()));
    const ended = loaded.events.filter((e) => e.kind === 'turn_ended').at(-1);
    assert.equal(ended?.outcome, 'CANCELLED');
    assert.ok(loaded.events.some((e) => e.kind === 'tool_result'));

    const result: ChatResult = {
      status: 'cancelled',
      outcome: 'CANCELLED',
      answer: 'Cancelled',
      usage: {
        totalCostUSD: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalTokens: 0,
        modelBreakdown: {},
      },
      conversation: [],
    };
    assertCrossSurface('cancel', result, ended?.outcome);
  });

  test('budget kill never collapses to completed; surfaces BUDGET_EXHAUSTED', async () => {
    const engine = new ChatEngine({
      task: 'answer briefly under budget',
      projectRoot,
      model: 'deepseek-v4-flash',
      maxTurns: 4,
    });
    // Force wall/cost kill on first turn check (streamDone path).
    (engine as unknown as { checkBudgets: () => { ok: boolean; reason?: string } }).checkBudgets =
      () => ({ ok: false, reason: 'Time budget exceeded (test wall).' });
    installMockRunner(engine, {
      executeWithToolsStream: async function* () {
        yield { type: 'text_delta', text: 'should not run' };
        yield { type: 'done', finishReason: 'stop' };
      },
      execute: async () => ({ type: 'completion', answer: 'x' }),
      getLastInvocationMetadata: () => null,
    });

    const result = await engine.submitMessage('finish', { onThought: () => {} });
    assert.equal(result.outcome, 'BUDGET_EXHAUSTED', `answer=${result.answer?.slice(0, 160)}`);
    assert.equal(result.status, 'budget_exhausted');
    assert.equal(result.budgetExceeded, true);
    assert.notEqual(result.status, 'completed');

    const loaded = await waitForThreadEventLog(chatSessionDir(engine.getEngineRunId()));
    const diskOutcome = loaded.events.filter((e) => e.kind === 'turn_ended').at(-1)?.outcome;
    assert.equal(diskOutcome, 'BUDGET_EXHAUSTED');
    assertCrossSurface('budget', result, diskOutcome);
  });

  test('submitMessage unexpected throw finalizes AGENT_FAILURE on disk', async () => {
    const engine = new ChatEngine({
      task: 'throw path',
      projectRoot,
      model: 'deepseek-v4-flash',
      maxTurns: 2,
    });
    parityOnUserTurn(engine.getParityRuntime(), {
      task: 'throw path',
      model: 'deepseek-v4-flash',
      provider: 'deepseek',
      projectRoot,
    });

    (engine as unknown as { submitMessageStream: typeof engine.submitMessageStream }).submitMessageStream =
      async function* () {
        throw new Error('synthetic stream crash');
      } as typeof engine.submitMessageStream;

    const result = await engine.submitMessage('crash me', { onThought: () => {} });
    assert.equal(result.outcome, 'AGENT_FAILURE');
    assert.equal(result.status, 'failed');

    const loaded = await waitForThreadEventLog(chatSessionDir(engine.getEngineRunId()));
    const ended = loaded.events.filter((e) => e.kind === 'turn_ended').at(-1);
    assert.equal(ended?.outcome, 'AGENT_FAILURE');
    assertCrossSurface('throw', result, ended?.outcome);
  });

  test('stream failed event and consumeChatStream share AGENT_FAILURE', async () => {
    const engine = new ChatEngine({
      task: 'event parity',
      projectRoot,
      model: 'deepseek-v4-flash',
      maxTurns: 2,
    });
    installMockRunner(engine, {
      executeWithToolsStream: async function* () {
        yield { type: 'error', message: 'immediate fail' };
      },
      execute: async () => ({ type: 'completion', answer: 'x' }),
      getLastInvocationMetadata: () => null,
    });

    const collected: ChatEvent[] = [];
    async function* tee(): AsyncGenerator<ChatEvent, void, undefined> {
      for await (const ev of engine.submitMessageStream('fail now')) {
        collected.push(ev);
        yield ev;
      }
    }
    const result = await consumeChatStream(tee(), null);
    assert.ok(collected.some((e) => e.type === 'failed'), 'must yield failed');
    assert.equal(result.outcome, 'AGENT_FAILURE');
    assert.equal(result.status, 'failed');

    const loaded = await waitForThreadEventLog(chatSessionDir(engine.getEngineRunId()));
    assertCrossSurface(
      'event-fail',
      result,
      loaded.events.filter((e) => e.kind === 'turn_ended').at(-1)?.outcome,
    );
  });
});
