/**
 * Live-path integration tests for P1–P3 — drive ChatEngine / chatApproval /
 * conversationSync entry points (not pure-module re-implementations).
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ChatEngine } from './chatEngine.js';
import {
  requestChatActionApproval,
  getChatApprovalSession,
  resetChatApprovalSession,
} from './chatApproval.js';
import {
  applyEventLogToChatEngine,
  createEngineFromEventLog,
} from '../services/threadStore/conversationSync.js';
import {
  createThreadEventLog,
  startTurn,
  recordAssistantToolCalls,
  recordToolResult,
  endTurn,
  rebuildProviderMessagesFromEvents,
  loadThreadEventLogFromDir,
  THREAD_EVENT_LOG_FILENAME,
} from './threadEventLog.js';
import {
  getInputArbiterState,
  resetInputArbiterForTests,
  dispatchInputArbiter,
} from '../ui/inputCoordinator.js';
import { compileChatStackForRun, getLastChatCompiledStack } from '../interactive/execution/chatCore.js';
import { decideProToFlashFailover } from './providerCapabilities.js';
import { parityTryFailover, parityRecordToolBatch } from './chatEngineParityBridge.js';
import {
  deriveSubagentApprovalSession,
  createApprovalSession,
  buildApprovalRequest,
  applyApprovalDecision,
} from './approvalRequests.js';
import type { ToolStreamEvent } from '../runners/base.js';
import type { ChatEvent } from './chatEngine.js';
import { chatSessionDir } from '../cli/runsLayout.js';
import type { ThreadEventLog } from './threadEventLog.js';

/**
 * Fire-and-forget finalizeParityTurnSync can lag under self-hosted Windows load.
 * Poll until the log parses and contains turn_ended (or timeout).
 */
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
  assert.ok(
    last,
    `loadThreadEventLogFromDir timed out after ${timeoutMs}ms (dir=${sessionDir})`,
  );
  assert.ok(
    last!.events.some((e) => e.kind === 'turn_ended'),
    `thread_events.json loaded but missing turn_ended after ${timeoutMs}ms; kinds=${last!.events.map((e) => e.kind).join(',')}`,
  );
  return last!;
}

// ─── Mock native-tools runner ───────────────────────────────────────────────

function makeMockRunner(sequence: 'complete' | 'tools_then_complete' | 'fail_retryable') {
  let call = 0;
  return {
    executeWithToolsStream: async function* (
      _messages: unknown,
      _tools: unknown,
      _sys?: string,
      _signal?: AbortSignal,
    ): AsyncGenerator<ToolStreamEvent, void, undefined> {
      call += 1;
      if (sequence === 'fail_retryable' && call === 1) {
        yield { type: 'error', message: '429 rate limit exceeded' };
        return;
      }
      if (sequence === 'tools_then_complete' && call === 1) {
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
  };
}

function installMockRunner(engine: ChatEngine, runner: ReturnType<typeof makeMockRunner>): void {
  // Live path uses resolveDeliberationRunner / resolveRoutedRunner — pin both.
  const anyEngine = engine as unknown as {
    deliberationRunner: unknown;
    synthesisRunner: unknown;
    shouldUseNativeTools: () => boolean;
  };
  anyEngine.deliberationRunner = runner;
  anyEngine.synthesisRunner = runner;
  // Force native tools so stream path hits executeWithToolsStream
  anyEngine.shouldUseNativeTools = () => true;
}

// ─── (a) monomorphic loop: submitMessage === stream outcome ─────────────────

describe('Live P1-A monomorphic ChatEngine loop', () => {
  let projectRoot: string;

  before(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'babel-parity-live-'));
    writeFileSync(join(projectRoot, 'hello.txt'), 'hello world\n', 'utf-8');
    process.env['BABEL_BENCHMARK_AUTO_APPROVE'] = '1';
  });

  after(() => {
    rmSync(projectRoot, { recursive: true, force: true });
    delete process.env['BABEL_BENCHMARK_AUTO_APPROVE'];
  });

  test('submitMessage and submitMessageStream share one loop and same outcome', async () => {
    const mk = () =>
      new ChatEngine({
        task: 'answer briefly',
        projectRoot,
        model: 'deepseek-v4-flash',
        maxTurns: 4,
      });

    const engineA = mk();
    installMockRunner(engineA, makeMockRunner('complete'));
    const syncResult = await engineA.submitMessage('Reply with only: OK', {
      onThought: () => {},
    });

    const engineB = mk();
    installMockRunner(engineB, makeMockRunner('complete'));
    const events: ChatEvent[] = [];
    for await (const ev of engineB.submitMessageStream('Reply with only: OK')) {
      events.push(ev);
    }
    const terminalB = events.find(
      (e) => e.type === 'done' || e.type === 'failed' || e.type === 'cancelled',
    );
    assert.ok(terminalB, 'stream must yield a terminal event');

    // Both leave durable turn_started + turn_ended (same loop side effects)
    const endedA = engineA
      .getParityEventLog()
      .events.filter((e) => e.kind === 'turn_ended');
    const endedB = engineB
      .getParityEventLog()
      .events.filter((e) => e.kind === 'turn_ended');
    assert.ok(endedA.length >= 1, 'sync path persists turn_ended');
    assert.ok(endedB.length >= 1, 'stream path persists turn_ended');
    assert.equal(
      endedA[endedA.length - 1]!.outcome,
      endedB[endedB.length - 1]!.outcome,
      'stream and non-stream TerminalOutcome must match',
    );
    // Non-stream is a consumer of stream — result status must be a known terminal
    assert.ok(
      ['completed', 'blocked', 'failed', 'cancelled'].includes(syncResult.status),
      syncResult.status,
    );
    assert.ok(syncResult.outcome, 'sync path must set TerminalOutcome via buildResult');
  });

  test('tool cycle records progress + tool_result events on live engine', async () => {
    const engine = new ChatEngine({
      task: 'inspect file',
      projectRoot,
      model: 'deepseek-v4-flash',
      maxTurns: 6,
    });
    installMockRunner(engine, makeMockRunner('tools_then_complete'));

    await engine.submitMessage('Read hello.txt then finish', {
      onThought: () => {},
    });

    const log = engine.getParityEventLog();
    const toolCalls = log.events.filter((e) => e.kind === 'assistant_tool_calls');
    const toolResults = log.events.filter((e) => e.kind === 'tool_result');
    const progress = engine.getParityRuntime().progress;
    assert.ok(progress.receipts.length >= 1, 'progress receipts recorded on live path');
    assert.ok(
      toolCalls.length >= 1,
      `expected assistant_tool_calls on live path; kinds=${log.events.map((e) => e.kind).join(',')}`,
    );
    assert.ok(
      toolResults.length >= 1,
      `expected tool_result on live path; kinds=${log.events.map((e) => e.kind).join(',')}`,
    );
    const callId = toolCalls[0]!.tool_calls[0]?.id;
    assert.ok(callId);
    assert.ok(
      toolResults.some((r) => r.tool_call_id === callId),
      'tool_result tool_call_id must match assistant tool call',
    );
  });

  test('same-target re-read with contentHash scores no_progress on live ledger', () => {
    const engine = new ChatEngine({ task: 't', projectRoot, model: 'deepseek-v4-flash' });
    const rt = engine.getParityRuntime();
    parityRecordToolBatch(rt, {
      at_turn: 0,
      toolCalls: [
        {
          id: 'c1',
          type: 'function',
          function: { name: 'read_file', arguments: '{}' },
        },
      ],
      results: [
        {
          tool_call_id: 'c1',
          tool_name: 'read_file',
          content: 'hello world',
          target: 'hello.txt',
          contentHash: 'abc123',
        },
      ],
    });
    parityRecordToolBatch(rt, {
      at_turn: 1,
      toolCalls: [
        {
          id: 'c2',
          type: 'function',
          function: { name: 'read_file', arguments: '{}' },
        },
      ],
      results: [
        {
          tool_call_id: 'c2',
          tool_name: 'read_file',
          content: 'hello world',
          target: 'hello.txt',
          contentHash: 'abc123',
        },
      ],
    });
    assert.equal(rt.progress.receipts[0]!.hasDelta, true);
    assert.equal(rt.progress.receipts[1]!.hasDelta, false);
    assert.equal(rt.progress.receipts[1]!.noProgressReason, 'repeated_unchanged_reads');
  });
});

// ─── (e) resume from event log with tool results ────────────────────────────

describe('Live P1-C resume via event log', () => {
  test('createEngineFromEventLog restores tool results without re-call', () => {
    const root = mkdtempSync(join(tmpdir(), 'babel-resume-'));
    try {
      const log = createThreadEventLog('resume-thread-live');
      const turnId = startTurn(log, {
        task: 'edit hello.txt',
        model: 'deepseek-v4-pro',
        provider: 'deepseek',
        projectRoot: root,
        policyPreset: 'workspace_write',
      });
      recordAssistantToolCalls(log, turnId, 'Reading', [
        {
          id: 'call_live_1',
          type: 'function',
          function: { name: 'read_file', arguments: '{"path":"hello.txt"}' },
        },
      ]);
      recordToolResult(log, turnId, {
        tool_call_id: 'call_live_1',
        tool_name: 'read_file',
        content: 'hello world',
        exit_code: 0,
      });
      endTurn(log, turnId, 'BLOCKED_POLICY', 'blocked');

      const engine = createEngineFromEventLog(
        { task: 'edit hello.txt', projectRoot: root, model: 'deepseek-v4-pro' },
        log,
        'You are Babel.',
      );
      const provider = engine.getProviderConversation();
      const tool = provider.find((m) => m.role === 'tool');
      assert.equal(tool?.tool_call_id, 'call_live_1');
      assert.match(tool?.content ?? '', /hello world/);

      // applyEventLogToChatEngine is the live resume path
      const engine2 = new ChatEngine({ task: 'x', projectRoot: root });
      applyEventLogToChatEngine(engine2, log, { systemPrompt: 'sys' });
      assert.ok(
        engine2.getProviderConversation().some((m) => m.tool_call_id === 'call_live_1'),
      );

      // Next provider request includes prior tool results
      const next = rebuildProviderMessagesFromEvents(log, { systemPrompt: 'sys' });
      assert.ok(next.some((m) => m.role === 'tool' && m.tool_call_id === 'call_live_1'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('engine stream terminal flushes thread_events.json (no manual persist)', async () => {
    // AC3 verification step 3: drive submitMessageStream → terminal → disk → resume.
    // Must FAIL if streamDone/cancel skip finalizeParityTurn disk flush.
    const root = mkdtempSync(join(tmpdir(), 'babel-engine-flush-'));
    writeFileSync(join(root, 'hello.txt'), 'engine-flush-payload\n', 'utf-8');
    try {
      const engine = new ChatEngine({
        task: 'inspect then stop',
        projectRoot: root,
        model: 'deepseek-v4-flash',
        maxTurns: 6,
      });
      installMockRunner(engine, makeMockRunner('tools_then_complete'));

      const events: ChatEvent[] = [];
      for await (const ev of engine.submitMessageStream('Read hello.txt then finish')) {
        events.push(ev);
      }
      assert.ok(
        events.some((e) => e.type === 'done' || e.type === 'failed' || e.type === 'cancelled'),
        'stream must terminate',
      );

      // Prefer public path via getEngineRunId; poll for fire-and-forget disk flush
      const sessionDir = chatSessionDir(engine.getEngineRunId());
      const diskPath = join(sessionDir, THREAD_EVENT_LOG_FILENAME);
      const loaded = await waitForThreadEventLog(sessionDir);
      assert.ok(
        existsSync(diskPath),
        `thread_events.json must exist after stream terminal (path=${diskPath}). ` +
          'If missing, streamDone did not call finalizeParityTurn.',
      );
      const toolResults = loaded.events.filter((e) => e.kind === 'tool_result');
      const ended = loaded.events.filter((e) => e.kind === 'turn_ended');
      assert.ok(
        toolResults.length >= 1,
        `disk log must retain tool_result; kinds=${loaded.events.map((e) => e.kind).join(',')}`,
      );
      assert.ok(
        ended.length >= 1,
        'disk log must retain turn_ended with TerminalOutcome',
      );
      assert.ok(
        ended[ended.length - 1]!.outcome,
        'turn_ended must carry TerminalOutcome',
      );

      // Resume rebuilds provider messages from disk without re-calling tools
      const resumed = createEngineFromEventLog(
        { task: 'inspect then stop', projectRoot: root, model: 'deepseek-v4-flash' },
        loaded,
      );
      const toolMsg = resumed.getProviderConversation().find((m) => m.role === 'tool');
      assert.ok(toolMsg?.tool_call_id, 'resumed engine must have tool_call_id');
      assert.ok(
        (toolMsg?.content ?? '').length > 0,
        'resumed tool result content must not be empty',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('engine stream failed flushes AGENT_FAILURE turn_ended to disk', async () => {
    // AC3: raw provider/tool failure after tools must finalize via streamFailed
    const root = mkdtempSync(join(tmpdir(), 'babel-fail-flush-'));
    try {
      const engine = new ChatEngine({
        task: 'will fail mid-run',
        projectRoot: root,
        model: 'deepseek-v4-flash',
        maxTurns: 4,
      });
      // Mock: first call tools, second call hard-fails (turn>0 → no failover, streamFailed)
      let call = 0;
      const failRunner = {
        executeWithToolsStream: async function* () {
          call += 1;
          if (call === 1) {
            yield {
              type: 'tool_use' as const,
              id: 'c1',
              name: 'read_file',
              input: { path: 'missing-for-progress.txt' },
            };
            yield { type: 'done' as const, finishReason: 'tool_calls' };
            return;
          }
          yield { type: 'error' as const, message: 'provider hard failure 500' };
        },
        execute: async () => ({ type: 'completion', answer: 'x' }),
        getLastInvocationMetadata: () => null,
      };
      installMockRunner(engine, failRunner as ReturnType<typeof makeMockRunner>);

      const events: ChatEvent[] = [];
      for await (const ev of engine.submitMessageStream('read then fail')) {
        events.push(ev);
      }
      assert.ok(
        events.some((e) => e.type === 'failed'),
        `expected failed event; got ${events.map((e) => e.type).join(',')}`,
      );

      const sessionDir = chatSessionDir(engine.getEngineRunId());
      const loaded = await waitForThreadEventLog(sessionDir);
      const ended = loaded.events.filter((e) => e.kind === 'turn_ended');
      assert.ok(ended.length >= 1, 'turn_ended required on failed path');
      assert.equal(
        ended[ended.length - 1]!.outcome,
        'AGENT_FAILURE',
        'failed path TerminalOutcome must be AGENT_FAILURE',
      );
      // If tools ran before failure, tool_result must still be on disk
      const tools = loaded.events.filter((e) => e.kind === 'tool_result');
      assert.ok(
        tools.length >= 1,
        'tool_result before failure must be retained on disk',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('engine cancel() flushes CANCELLED TerminalOutcome to disk', async () => {
    const root = mkdtempSync(join(tmpdir(), 'babel-cancel-flush-'));
    try {
      const engine = new ChatEngine({
        task: 'long run',
        projectRoot: root,
        model: 'deepseek-v4-flash',
        maxTurns: 4,
      });
      // Open a turn so cancel has a turn_id
      const { parityOnUserTurn } = await import('./chatEngineParityBridge.js');
      parityOnUserTurn(engine.getParityRuntime(), {
        task: 'long run',
        model: 'deepseek-v4-flash',
        provider: 'deepseek',
        projectRoot: root,
      });
      // Record a tool result then cancel (simulates mid-tool cancel after observations)
      parityRecordToolBatch(engine.getParityRuntime(), {
        at_turn: 0,
        toolCalls: [
          {
            id: 'cancel_call',
            type: 'function',
            function: { name: 'read_file', arguments: '{}' },
          },
        ],
        results: [
          {
            tool_call_id: 'cancel_call',
            tool_name: 'read_file',
            content: 'pre-cancel-observation',
            target: 'x.ts',
            contentHash: 'h1',
          },
        ],
      });
      engine.cancel();

      const sessionDir = chatSessionDir(engine.getEngineRunId());
      const loaded = await waitForThreadEventLog(sessionDir);
      assert.ok(loaded.events.some((e) => e.kind === 'tool_result'));
      const ended = loaded.events.filter((e) => e.kind === 'turn_ended');
      assert.ok(ended.length >= 1);
      assert.equal(ended[ended.length - 1]!.outcome, 'CANCELLED');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('Live P1-D subagent scope ceiling', () => {
  test('deriveSubagentApprovalSession caps child below parent (live helper)', () => {
    const parent = createApprovalSession('parent', ['shell', 'write']);
    const child = deriveSubagentApprovalSession(parent, 'child', [
      'shell',
      'write',
      'network',
    ]);
    assert.ok(!child.parentScopeCeiling.includes('network'));
    const req = buildApprovalRequest({
      thread_id: 'child',
      turn_id: 't',
      command: 'curl x',
      cwd: '/',
      capability: 'network',
      reason: 'net',
    });
    const res = applyApprovalDecision(child, req, 'allow_session');
    assert.equal(res.decision, 'deny');
  });
});

// ─── (f) live chatApproval uses ApprovalRequest ─────────────────────────────

describe('Live P1-D chatApproval path', () => {
  test('headless deny/allow_once via requestChatActionApproval', async () => {
    resetChatApprovalSession('live-approval-test');
    process.env['CI'] = 'true';
    delete process.env['BABEL_BENCHMARK_AUTO_APPROVE'];

    const denied = await requestChatActionApproval({
      type: 'run_command',
      command: 'curl https://example.com',
    });
    assert.equal(denied, false);
    assert.ok(getChatApprovalSession().history.some((h) => h.decision === 'deny'));

    process.env['BABEL_BENCHMARK_AUTO_APPROVE'] = '1';
    const allowed = await requestChatActionApproval({
      type: 'write_file',
      path: 'a.ts',
      content: 'x',
    });
    assert.equal(allowed, true);
    assert.ok(getChatApprovalSession().history.some((h) => h.decision === 'allow_once'));

    delete process.env['BABEL_BENCHMARK_AUTO_APPROVE'];
    delete process.env['CI'];
  });
});

// ─── (g) failover decision used by resolve path ─────────────────────────────

describe('Live P1-E failover on engine', () => {
  test('parityTryFailover records decision for Pro rate-limit', () => {
    const d = decideProToFlashFailover(
      'deepseek-v4-pro',
      new Error('429 rate limit'),
    );
    assert.ok(d);
    assert.equal(d!.toModel, 'deepseek-v4-flash');
    assert.equal(d!.countsAsVerification, false);

    const engine = new ChatEngine({
      task: 't',
      projectRoot: process.cwd(),
      model: 'deepseek-v4-pro',
    });
    const rt = engine.getParityRuntime();
    const dec = parityTryFailover(rt, 'deepseek-v4-pro', new Error('503 overloaded'));
    assert.ok(dec);
    assert.equal(rt.lastFailover?.toModel, 'deepseek-v4-flash');
  });
});

// ─── P2-B cancel dispatches input arbiter ───────────────────────────────────

describe('Live P2-B cancel → input arbiter', () => {
  test('engine.cancel dispatches ctrl_c cancel_turn', () => {
    resetInputArbiterForTests();
    dispatchInputArbiter({ type: 'run_started' });
    assert.equal(getInputArbiterState().mode, 'running');

    const engine = new ChatEngine({ task: 't', projectRoot: process.cwd() });
    engine.cancel();
    assert.equal(getInputArbiterState().cancelArmed, true);
    assert.equal(engine.getParityRuntime().loop.outcome, 'CANCELLED');
  });
});

// ─── P2-A chat compile live entry ───────────────────────────────────────────

describe('Live P2-A chat compile entry', () => {
  test('compileChatStackForRun records manifest hash', () => {
    const root = process.cwd().includes('babel-cli')
      ? join(process.cwd(), '..')
      : process.cwd();
    const stack = compileChatStackForRun({
      projectRoot: root,
      task: 'fix CLI parser',
      model: 'deepseek-v4-pro',
    });
    assert.ok(stack.manifest_hash.length >= 16);
    assert.equal(stack.deep_stages_excluded, true);
    assert.equal(getLastChatCompiledStack()?.manifest_hash, stack.manifest_hash);
  });
});
