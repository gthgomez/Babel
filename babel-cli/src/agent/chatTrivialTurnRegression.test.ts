/**
 * Regression coverage for the interactive chat/TUI runaway-turn defects:
 *
 * 1. Trivial conversational turns ('?', 'hello') must terminate normally.
 *    They classified as 'execute' intent, and the implementor prefers-patch
 *    refusal continued unconditionally on every zero-write completion,
 *    starving the bounded text-only escalation — re-querying until maxTurns
 *    and burning tokens.
 * 2. Streamed answers must not be duplicated: live deltas followed by a
 *    full-answer re-emission made the TUI render the text twice.
 * 3. Cancelled turns must report THIS turn's finalized telemetry — not
 *    none, and not the previous turn's stale record.
 */

import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatEngine, type ChatEvent } from './chatEngine.js';
import { TEXT_ONLY_FORCE_BLOCKED_THRESHOLD } from './stallDetector.js';

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'babel-trivial-regression-'));
  roots.push(root);
  return root;
}

type MockRunner = Record<string, unknown>;

/** Text-only native-tools runner: streams the same answer every call. */
function textOnlyRunner(answer: string, state: { calls: number }): MockRunner {
  return {
    executeWithToolsStream: async function* () {
      state.calls += 1;
      yield { type: 'text_delta' as const, text: answer };
      yield { type: 'done' as const, finishReason: 'stop' };
    },
    executeRawStream: async function* () {
      state.calls += 1;
      yield answer;
    },
    executeRaw: async () => answer,
    execute: async () => ({ type: 'completion', answer }),
    getLastInvocationMetadata: () => null,
  };
}

function stubNativeRunner(engine: ChatEngine, runner: MockRunner): void {
  const box = engine as unknown as Record<string, unknown>;
  box['deliberationRunner'] = runner;
  box['shouldUseNativeTools'] = () => true;
}

async function collect(
  engine: ChatEngine,
  input: string,
  taskIntent?: 'execute' | 'explain',
): Promise<ChatEvent[]> {
  const events: ChatEvent[] = [];
  for await (const ev of engine.submitMessageStream(input, taskIntent)) {
    events.push(ev);
  }
  return events;
}

describe('conversational turn classification', () => {
  test('trivial / contentless turns are never execute intent', () => {
    assert.equal(ChatEngine.classifyChatTaskIntent('?'), 'explain');
    assert.equal(ChatEngine.classifyChatTaskIntent('??'), 'explain');
    assert.equal(ChatEngine.classifyChatTaskIntent('hello'), 'explain');
    assert.equal(ChatEngine.classifyChatTaskIntent('Hello!'), 'explain');
    assert.equal(ChatEngine.classifyChatTaskIntent('hi there'), 'explain');
    assert.equal(ChatEngine.classifyChatTaskIntent('thanks!'), 'explain');
    assert.equal(ChatEngine.classifyChatTaskIntent('ok'), 'explain');
    assert.equal(ChatEngine.classifyChatTaskIntent('good morning'), 'explain');
  });

  test('action-bearing turns keep their intent', () => {
    assert.equal(ChatEngine.classifyChatTaskIntent('fix this bug'), 'execute');
    assert.equal(ChatEngine.classifyChatTaskIntent('the login page is broken'), 'execute');
    assert.equal(
      ChatEngine.classifyChatTaskIntent('hello, can you fix the login bug?'),
      'execute',
    );
    assert.equal(ChatEngine.classifyChatTaskIntent('what does this function do?'), 'explain');
  });
});

describe('trivial text-only turns terminate normally', () => {
  test("'?' completes in one provider round without re-query", async () => {
    const state = { calls: 0 };
    const engine = new ChatEngine({
      task: '?',
      projectRoot: makeRoot(),
      maxTurns: 6,
    });
    stubNativeRunner(engine, textOnlyRunner('Sure — how can I help?', state));

    const events = await collect(engine, '?');

    const doneEvents = events.filter((e) => e.type === 'done');
    assert.equal(doneEvents.length, 1, `expected one done event, got: ${events.map((e) => e.type).join(',')}`);
    assert.equal(state.calls, 1, `expected exactly one provider round, got ${state.calls}`);
    assert.equal(events.some((e) => e.type === 'failed'), false);
    assert.equal(events.some((e) => e.type === 'cancelled'), false);
    const done = doneEvents[0] as Extract<ChatEvent, { type: 'done' }>;
    assert.equal(done.answer, 'Sure — how can I help?');
    // Kernel mapping for a clean completion without a verifier receipt.
    assert.equal(done.outcome, 'UNVERIFIED_PATCH');
  });

  test('execute-intent pure-text loops terminate at the bounded threshold', async () => {
    const state = { calls: 0 };
    const engine = new ChatEngine({
      task: 'the login page is broken',
      projectRoot: makeRoot(),
      maxTurns: 12,
    });
    stubNativeRunner(
      engine,
      textOnlyRunner('Understood, I am thinking about the approach.', state),
    );

    const events = await collect(engine, 'the login page is broken', 'execute');

    assert.equal(events.some((e) => e.type === 'failed'), false);
    assert.ok(
      state.calls <= TEXT_ONLY_FORCE_BLOCKED_THRESHOLD,
      `expected bounded rounds (<= ${TEXT_ONLY_FORCE_BLOCKED_THRESHOLD}), got ${state.calls}`,
    );
    assert.equal(state.calls, TEXT_ONLY_FORCE_BLOCKED_THRESHOLD);
    const done = events.filter((e) => e.type === 'done').at(-1) as
      | Extract<ChatEvent, { type: 'done' }>
      | undefined;
    assert.ok(done, 'expected a terminal done event');
    assert.ok(done.blockedReport, 'expected BLOCKED report from text-only loop guard');
    assert.equal(done.blockedReport?.status, 'BLOCKED');
  });
});

describe('streamed answers are not duplicated', () => {
  test('final answer chunk is not re-emitted after live deltas', async () => {
    const state = { calls: 0 };
    const engine = new ChatEngine({
      task: 'hello',
      projectRoot: makeRoot(),
      maxTurns: 4,
    });
    // Two-delta runner so streamed text accumulates across chunks.
    const runner: MockRunner = {
      executeWithToolsStream: async function* () {
        state.calls += 1;
        yield { type: 'text_delta' as const, text: 'Hello ' };
        yield { type: 'text_delta' as const, text: 'world' };
        yield { type: 'done' as const, finishReason: 'stop' };
      },
      getLastInvocationMetadata: () => null,
    };
    stubNativeRunner(engine, runner);

    const events = await collect(engine, 'hello', 'explain');
    const chunks = events
      .filter((e): e is Extract<ChatEvent, { type: 'answer_chunk' }> => e.type === 'answer_chunk')
      .map((e) => e.text);
    const joined = chunks.join('');
    const done = events.filter((e) => e.type === 'done').at(-1) as
      | Extract<ChatEvent, { type: 'done' }>
      | undefined;

    assert.ok(done, 'expected done event');
    assert.equal(chunks.length, 2, `expected exactly the two live deltas, got ${chunks.length}: ${JSON.stringify(chunks)}`);
    assert.equal(joined, 'Hello world');
    assert.equal(joined, done.answer, 'streamed text must equal the final answer exactly once');
  });

  test('BLOCKED-declared completions are emitted once', async () => {
    const state = { calls: 0 };
    const engine = new ChatEngine({
      task: 'check the service status',
      projectRoot: makeRoot(),
      maxTurns: 4,
    });
    stubNativeRunner(
      engine,
      textOnlyRunner('BLOCKED: external service unreachable.', state),
    );
    // Blocked-report detection requires prior investigate evidence.
    (engine as unknown as { toolCallLog: unknown[] }).toolCallLog = [
      { tool: 'read_file', target: 'src/service.ts', index: 0, exit_code: 0, stdout: 'contents' },
    ];

    const events = await collect(engine, 'check the service status', 'explain');
    const chunks = events
      .filter((e): e is Extract<ChatEvent, { type: 'answer_chunk' }> => e.type === 'answer_chunk')
      .map((e) => e.text);
    const done = events.filter((e) => e.type === 'done').at(-1) as
      | Extract<ChatEvent, { type: 'done' }>
      | undefined;

    assert.ok(done, 'expected done event');
    assert.ok(done.blockedReport, 'expected structured blocked report');
    assert.equal(chunks.join(''), done.answer, 'answer text must appear exactly once');
    assert.equal(chunks.length, 1, `expected single emission, got ${chunks.length}`);
  });
});

describe('cancelled turn reports consistent per-turn telemetry', () => {
  test('cancelled event carries this turn’s finalized telemetry', async () => {
    let calls = 0;
    let release!: () => void;
    const parked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const meta = { provider_model_id: 'test-model', prompt_tokens: 123, completion_tokens: 45 };
    let observedSignal: AbortSignal | null = null;

    const runner: MockRunner = {
      executeWithToolsStream: async function* (
        _messages: unknown,
        _defs: unknown,
        _system: unknown,
        signal?: AbortSignal,
      ) {
        calls += 1;
        observedSignal = signal ?? null;
        if (calls === 1) {
          // Tool round so the loop continues to a second provider call.
          yield {
            type: 'tool_use' as const,
            id: 't1',
            name: 'read_file',
            input: { path: 'does-not-exist-regression.txt' },
          };
          yield { type: 'done' as const, finishReason: 'tool_calls' };
          return;
        }
        await parked;
        // Mirror real runners: abort mid-stream surfaces as AbortError.
        if (observedSignal?.aborted) {
          const err = new Error('operation was aborted');
          err.name = 'AbortError';
          throw err;
        }
        yield { type: 'done' as const, finishReason: 'stop' };
      },
      getLastInvocationMetadata: () => ({ ...meta }),
    };

    const engine = new ChatEngine({
      task: 'read the config file',
      projectRoot: makeRoot(),
      maxTurns: 6,
    });
    stubNativeRunner(engine, runner);

    const events: ChatEvent[] = [];
    const finished = (async () => {
      for await (const ev of engine.submitMessageStream('read the config file')) {
        events.push(ev);
      }
    })();

    const deadline = Date.now() + 2000;
    while (calls < 2 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.equal(calls, 2, 'runner should be parked in round two');
    engine.abortTurn();
    release();
    await finished;

    const cancelled = events.find(
      (e): e is Extract<ChatEvent, { type: 'cancelled' }> => e.type === 'cancelled',
    );
    assert.ok(cancelled, `expected a cancelled terminal, got: ${events.map((e) => e.type).join(',')}`);
    assert.equal(events.some((e) => e.type === 'done'), false);
    assert.equal(events.some((e) => e.type === 'failed'), false);

    const telemetry = cancelled.turnTelemetry;
    assert.ok(telemetry, 'cancelled event must carry finalized per-turn telemetry');
    assert.equal(telemetry.counts.modelInvocations, 2);
    assert.equal(telemetry.promptTokens, 123);
    assert.equal(telemetry.completionTokens, 45);

    const lastTelemetry = engine.getLastTurnTelemetry();
    assert.ok(lastTelemetry, 'engine last-turn telemetry must be finalized on cancel');
    assert.equal(lastTelemetry.turnId, telemetry.turnId);
    assert.equal(lastTelemetry.counts.modelInvocations, 2);
  });
});
