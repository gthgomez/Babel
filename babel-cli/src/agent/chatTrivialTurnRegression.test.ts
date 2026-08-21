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
import { ChatEngine, reconcileStreamedAnswer, type ChatEvent } from './chatEngine.js';
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
  test('reconcileStreamedAnswer covers exact, prefix, zero-stream, and divergent cases', () => {
    assert.equal(reconcileStreamedAnswer('Hello world', 'Hello world'), null);
    assert.equal(reconcileStreamedAnswer('Hello ', 'Hello world'), 'world');
    assert.equal(reconcileStreamedAnswer(null, 'Hello world'), 'Hello world');
    assert.equal(reconcileStreamedAnswer('', 'Hello world'), 'Hello world');
    assert.equal(reconcileStreamedAnswer('raw noise', 'Normalized final'), 'Normalized final');
    assert.equal(reconcileStreamedAnswer('anything', ''), null);
  });

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

  test('zero-stream completion emits the answer exactly once', async () => {
    const state = { calls: 0 };
    const engine = new ChatEngine({
      task: 'hello',
      projectRoot: makeRoot(),
      maxTurns: 4,
    });
    // Truly zero visible deltas — the provider yields only a done marker.
    stubNativeRunner(engine, {
      executeWithToolsStream: async function* () {
        state.calls += 1;
        yield { type: 'done' as const, finishReason: 'stop' };
      },
      getLastInvocationMetadata: () => null,
    });

    const events = await collect(engine, 'hello', 'explain');
    const chunks = events
      .filter((e): e is Extract<ChatEvent, { type: 'answer_chunk' }> => e.type === 'answer_chunk')
      .map((e) => e.text)
      .filter((t) => t.length > 0);
    const done = events.filter((e) => e.type === 'done').at(-1) as
      | Extract<ChatEvent, { type: 'done' }>
      | undefined;

    assert.ok(done, 'expected done event');
    assert.equal(chunks.length, 1, `expected a single emission for zero-stream, got ${JSON.stringify(chunks)}`);
    assert.equal(chunks[0], done.answer);
  });

  test('normalized legacy JSON final is buffered — parsed answer emitted exactly once', async () => {
    const engine = new ChatEngine({
      task: 'hello',
      projectRoot: makeRoot(),
      maxTurns: 4,
    });
    // Legacy path (no native tools): raw stream carries a JSON wrapper that
    // the lenient parser normalizes. The raw text must NOT be live-streamed
    // (it is not append-compatible with the parsed final answer).
    const rawJson = '{"thinking":"internal","answer":"Normalized final"}';
    stubNativeRunner(engine, {
      executeRawStream: async function* () {
        yield rawJson;
      },
      executeRaw: async () => rawJson,
      getLastInvocationMetadata: () => null,
    });
    (engine as unknown as Record<string, unknown>)['shouldUseNativeTools'] = () => false;

    const events = await collect(engine, 'hello', 'explain');
    const chunks = events
      .filter((e): e is Extract<ChatEvent, { type: 'answer_chunk' }> => e.type === 'answer_chunk')
      .map((e) => e.text);
    const done = events.filter((e) => e.type === 'done').at(-1) as
      | Extract<ChatEvent, { type: 'done' }>
      | undefined;

    assert.ok(done, 'expected done event');
    assert.equal(done.answer, 'Normalized final');
    assert.deepEqual(
      chunks,
      ['Normalized final'],
      `buffered parse path must emit exactly the parsed answer once, got: ${JSON.stringify(chunks)}`,
    );
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

describe('per-round budget terminal precedes continuation mechanisms', () => {
  test('a single over-limit text round hard-stops after one provider call', async () => {
    const state = { calls: 0 };
    const engine = new ChatEngine({
      task: 'the login page is broken',
      projectRoot: makeRoot(),
      maxTurns: 8,
    });
    stubNativeRunner(engine, {
      executeWithToolsStream: async function* () {
        state.calls += 1;
        yield { type: 'text_delta' as const, text: 'thinking out loud about the fix' };
        yield { type: 'done' as const, finishReason: 'stop' };
      },
      getLastInvocationMetadata: () => ({
        provider_model_id: 'test-model',
        prompt_tokens: 250_000,
        completion_tokens: 10_000,
      }),
    });

    const events = await collect(engine, 'the login page is broken', 'execute');

    assert.equal(
      state.calls,
      1,
      `over-limit round must terminate immediately, got ${state.calls} provider calls`,
    );
    assert.equal(events.some((e) => e.type === 'cancelled'), false);
    const done = events.filter((e) => e.type === 'done').at(-1) as
      | Extract<ChatEvent, { type: 'done' }>
      | undefined;
    assert.ok(done, 'expected a terminal done event');
    const budgetText = `${done.answer ?? ''} ${done.blockedReport?.reason ?? ''}`;
    assert.match(
      budgetText,
      /token explosion|per-round token|tokens/i,
      `expected an honest budget terminal, got: ${budgetText.slice(0, 200)}`,
    );
  });
});

describe('generation boundaries (thinking without tools) segment streams', () => {
  test('engine emits thinking between consecutive text-only generations', async () => {
    const state = { calls: 0 };
    const engine = new ChatEngine({
      task: 'the login page is broken',
      projectRoot: makeRoot(),
      maxTurns: 3,
    });
    stubNativeRunner(engine, textOnlyRunner('Still reasoning about the approach.', state));

    const events = await collect(engine, 'the login page is broken', 'execute');
    const types = events.map((e) => e.type);
    let found = false;
    for (let i = 0; i < types.length && !found; i++) {
      if (types[i] !== 'answer_chunk') continue;
      for (let j = i + 1; j < types.length && !found; j++) {
        if (types[j] === 'tool_start') break; // tool boundary is a different seam
        if (types[j] !== 'thinking') continue;
        for (let k = j + 1; k < types.length; k++) {
          if (types[k] === 'answer_chunk') {
            found = true; // chunkA … thinking … chunkB with no tool between
            break;
          }
          if (types[k] === 'done' || types[k] === 'failed' || types[k] === 'cancelled') break;
        }
      }
    }
    assert.equal(
      state.calls >= 2,
      true,
      `expected at least two generations, got ${state.calls} provider calls`,
    );
    assert.equal(found, true, `expected a thinking boundary between answer generations, got: ${types.join(',')}`);
  });

  test('dispatch forwards generation boundaries to the renderer', async () => {
    const { dispatchChatEvent } = await import('../interactive/execution/chatEventDispatch.js');
    const calls: string[] = [];
    const fakeRenderer = {
      onAnswerChunk: (t: string) => calls.push(`chunk:${t}`),
      onAnswerGenerationBoundary: () => calls.push('boundary'),
    } as never;
    dispatchChatEvent({ type: 'answer_chunk', text: 'A' }, { convRenderer: fakeRenderer });
    dispatchChatEvent({ type: 'thinking' }, { convRenderer: fakeRenderer });
    dispatchChatEvent({ type: 'answer_chunk', text: 'B' }, { convRenderer: fakeRenderer });
    assert.deepEqual(calls, ['chunk:A', 'boundary', 'chunk:B']);
  });

  test('renderer commits generation A and opens a fresh segment for B', async () => {
    const { ConversationalRenderer } = await import('../ui/waterfall.js');
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: unknown) => true) as typeof process.stdout.write;
    try {
      const renderer = new ConversationalRenderer({ isTTY: true, verboseMode: false });
      renderer.start();

      renderer.onAnswerChunk('Generation A text.');
      renderer.onAnswerGenerationBoundary();
      renderer.onAnswerChunk('Generation B text.');

      const committed = renderer.getCommittedHistoryCells();
      const assistantCells = committed.filter((c) => c.kind === 'assistant_message');
      assert.equal(assistantCells.length, 1, 'generation A must be committed as its own cell');
      const payloadA = assistantCells[0]!.payload as { message?: string };
      assert.equal(payloadA.message, 'Generation A text.');

      // Live summary segment now contains only generation B.
      const liveText = renderer.getAnswerText();
      assert.match(liveText, /Generation B text\./);
      assert.doesNotMatch(liveText, /Generation A text\./, 'generations must not concatenate');

      const active = (renderer as unknown as {
        _historyTranscript?: { getActiveRecord?: () => { kind: string; payload?: { message?: string } } | null };
      })._historyTranscript?.getActiveRecord?.();
      assert.equal(active?.kind, 'assistant_message');
      assert.equal(active?.payload?.message, 'Generation B text.');

      renderer.stop();
    } finally {
      process.stdout.write = originalWrite;
    }
  });
});

describe('assistant stream segments at tool boundaries', () => {  test('answer → tool → answer produces separate transcript cells', async () => {
    const { ConversationalRenderer } = await import('../ui/waterfall.js');
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: unknown) => true) as typeof process.stdout.write;
    try {
      const renderer = new ConversationalRenderer({ isTTY: true, verboseMode: false });
      renderer.start();

      renderer.onAnswerChunk('Part A');
      const id = renderer.onToolCallStart('read_file', 'src/a.ts');
      assert.ok(id > 0);
      renderer.onToolCallComplete(id, 'read 10 bytes', undefined, 0);
      renderer.onAnswerChunk('Part B');

      const committed = renderer.getCommittedHistoryCells();
      const kinds = committed.map((c) => c.kind);
      assert.deepEqual(
        kinds.filter((k) => k === 'assistant_message' || k === 'tool_call'),
        ['assistant_message', 'tool_call'],
        `tool boundary must segment cells instead of concatenating streams, got: ${JSON.stringify(kinds)}`,
      );
      // The second stream becomes the new active assistant cell.
      const active = (renderer as unknown as {
        _historyTranscript?: { getActiveRecord?: () => { kind: string; payload?: { message?: string } } | null };
      })._historyTranscript?.getActiveRecord?.();
      assert.equal(active?.kind, 'assistant_message');
      assert.equal(active?.payload?.message, 'Part B');

      renderer.stop();
    } finally {
      process.stdout.write = originalWrite;
    }
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
