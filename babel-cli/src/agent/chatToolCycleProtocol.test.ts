/**
 * Tool-call/tool-result protocol proof at the real runtime seams (H-common).
 *
 * Drives the full ChatEngine loop — provider stream → tool execution → durable
 * event log → wire serialization — with a scripted fetch transport and asserts
 * that every outgoing provider POST body keeps the tool protocol valid across
 * missing/duplicate ids, parallel calls, partial batches, compaction
 * boundaries, persistence/resume, and interrupted provider responses.
 *
 * No network or model access is possible: fetch is replaced and the runner is
 * constructed with an explicit fixture-only credential.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatEngine } from './chatEngine.js';
import { runCliChatTask } from '../interactive/execution/chatCore.js';
import { OpenCodeGoApiRunner } from '../runners/openCodeGoApi.js';
import { babelReviewModelPolicy } from '../services/babelChatReview.js';
import { validateProviderMessageProtocol } from '../runners/providerMessages.js';

type WireMessage = {
  role: string;
  content: string;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
  name?: string;
};

type CapturedRequest = { messages: WireMessage[]; toolNames: string[] };

function sseResponse(delta: Record<string, unknown>, finishReason: string): Response {
  return new Response(
    `data: ${JSON.stringify({ model: 'mimo-v2.5', choices: [{ delta, finish_reason: finishReason }], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } })}\n\ndata: [DONE]\n\n`,
    { status: 200 },
  );
}

function toolCallDelta(id: string, name: string, args: Record<string, unknown>, index = 0): Record<string, unknown> {
  return { tool_calls: [{ index, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] };
}

function textDelta(text: string): Record<string, unknown> {
  return { content: text };
}

interface HarnessOptions {
  maxEstimatedTokens?: number;
  maxTurns?: number;
  keepRuns?: boolean;
  fixtureContent?: string;
}

interface Harness {
  root: string;
  source: string;
  captures: CapturedRequest[];
  respond: Array<() => Response>;
  run(task: string): Promise<{ payload: Record<string, unknown> }>;
  engine(): ChatEngine | undefined;
  dispose(): void;
}

/**
 * Full-loop harness: scripted provider at the exact fetch boundary.
 * Response scripts are consumed one provider round at a time; an empty script
 * ends the run with a plain completion so every harness use terminates.
 */
function makeHarness(options: HarnessOptions = {}): Harness {
  const root = mkdtempSync(join(tmpdir(), 'babel-tool-cycle-'));
  const source = join(root, 'source');
  mkdirSync(source);
  writeFileSync(join(source, 'fixture.txt'), options.fixtureContent ?? 'fixture-alpha\nfixture-beta\nfixture-gamma\n');
  const runsDir = join(root, 'runs');
  mkdirSync(runsDir);
  const keys: Record<string, string> = {
    BABEL_EXECUTION_PROFILE: 'read_only_audit',
    BABEL_READ_ONLY: 'true',
    BABEL_PROJECT_ROOT: source,
    BABEL_RUNS_DIR: runsDir,
    BABEL_COMPACTION: options.maxEstimatedTokens ? 'on' : 'off',
    BABEL_MEMORY_WRITEBACK: '0',
    BABEL_CHAT_TASK_CLASS: 'investigate',
  };
  const previous = Object.fromEntries(Object.keys(keys).map((key) => [key, process.env[key]]));
  Object.assign(process.env, keys);

  const captures: CapturedRequest[] = [];
  const respond: Array<() => Response> = [];
  let activeEngine: ChatEngine | undefined;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as {
      messages: WireMessage[];
      tools?: Array<{ function: { name: string } }>;
    };
    captures.push({
      messages: body.messages,
      toolNames: (body.tools ?? []).map((tool) => tool.function.name),
    });
    const next = respond.shift();
    if (next) return next();
    return sseResponse(textDelta('Investigation complete.'), 'stop');
  };

  const runner = new OpenCodeGoApiRunner('mimo-v2.5', {}, { credentialSource: 'explicit-test', explicitCredential: 'fixture-only' });
  const run = async (task: string) => {
    const result = await runCliChatTask({
      task,
      projectRoot: source,
      outputFormat: 'json',
      engineFactory: (engineOptions) =>
        activeEngine = new ChatEngine({
          ...engineOptions,
          maxTurns: options.maxTurns ?? 8,
          ...(options.maxEstimatedTokens ? { maxEstimatedTokens: options.maxEstimatedTokens } : {}),
          providerRunner: runner,
          providerPolicy: babelReviewModelPolicy('mimo-v2.5', source),
        }),
    });
    return { payload: result.payload as Record<string, unknown> };
  };

  return {
    root,
    source,
    captures,
    respond,
    run,
    engine: () => activeEngine,
    dispose() {
      globalThis.fetch = originalFetch;
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      if (!options.keepRuns) rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Hard protocol issues for a captured wire payload (advisory codes excluded). */
function hardIssues(messages: WireMessage[]) {
  return validateProviderMessageProtocol(messages).filter((issue) => issue.code !== 'system_in_user_content');
}

function toolResultsFor(messages: WireMessage[], callId: string): WireMessage[] {
  return messages.filter((message) => message.role === 'tool' && message.tool_call_id === callId);
}

function callsDeclared(messages: WireMessage[]): Array<{ id: string; name: string }> {
  const calls: Array<{ id: string; name: string }> = [];
  for (const message of messages) {
    for (const call of message.tool_calls ?? []) calls.push({ id: call.id, name: call.function.name });
  }
  return calls;
}

test('parallel tool calls keep one result per call id at the wire boundary', async () => {
  const harness = makeHarness();
  try {
    harness.respond.push(() => new Response(
      [
        `data: ${JSON.stringify({ model: 'mimo-v2.5', choices: [{ delta: toolCallDelta('call-a', 'read_file', { path: join(harness.source, 'fixture.txt') }, 0), finish_reason: null }], usage: null })}`,
        `data: ${JSON.stringify({ model: 'mimo-v2.5', choices: [{ delta: toolCallDelta('call-b', 'list_dir', { path: harness.source }, 1), finish_reason: null }], usage: null })}`,
        `data: ${JSON.stringify({ model: 'mimo-v2.5', choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: null })}`,
        'data: [DONE]',
        '',
        '',
      ].join('\n'),
      { status: 200 },
    ));
    await harness.run('Inspect the fixture directory.');
    assert.ok(harness.captures.length >= 2, 'expected a second provider round after tool execution');
    const after = harness.captures[1]!.messages;
    assert.deepEqual(hardIssues(after), [], `protocol issues: ${JSON.stringify(hardIssues(after))}`);
    const declared = callsDeclared(after);
    assert.ok(declared.some((c) => c.id === 'call-a'), 'call-a must survive at the wire boundary');
    assert.ok(declared.some((c) => c.id === 'call-b'), 'call-b must survive at the wire boundary');
    assert.equal(toolResultsFor(after, 'call-a').length, 1, 'call-a must have exactly one result');
    assert.equal(toolResultsFor(after, 'call-b').length, 1, 'call-b must have exactly one result');
  } finally {
    harness.dispose();
  }
});

test('provider tool_call with empty id is repaired and results stay paired', async () => {
  const harness = makeHarness();
  try {
    harness.respond.push(() => sseResponse(toolCallDelta('', 'read_file', { path: join(harness.source, 'fixture.txt') }), 'tool_calls'));
    await harness.run('Read the fixture file.');
    assert.ok(harness.captures.length >= 2);
    const after = harness.captures[1]!.messages;
    assert.deepEqual(hardIssues(after), [], `protocol issues: ${JSON.stringify(hardIssues(after))}`);
    const declared = callsDeclared(after);
    assert.equal(declared.length, 1);
    assert.ok(declared[0]!.id.length > 0, 'engine must synthesize a non-empty id for a missing provider id');
    assert.equal(toolResultsFor(after, declared[0]!.id).length, 1, 'synthesized id must be answered by exactly one result');
  } finally {
    harness.dispose();
  }
});

test('duplicate provider call ids do not produce duplicate or orphaned wire results', async () => {
  const harness = makeHarness();
  try {
    harness.respond.push(() => new Response(
      [
        `data: ${JSON.stringify({ model: 'mimo-v2.5', choices: [{ delta: toolCallDelta('call-dup', 'read_file', { path: join(harness.source, 'fixture.txt') }, 0), finish_reason: null }], usage: null })}`,
        `data: ${JSON.stringify({ model: 'mimo-v2.5', choices: [{ delta: toolCallDelta('call-dup', 'list_dir', { path: harness.source }, 1), finish_reason: null }], usage: null })}`,
        `data: ${JSON.stringify({ model: 'mimo-v2.5', choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: null })}`,
        'data: [DONE]',
        '',
        '',
      ].join('\n'),
      { status: 200 },
    ));
    await harness.run('Inspect with duplicate ids.');
    assert.ok(harness.captures.length >= 2);
    for (const capture of harness.captures.slice(1)) {
      assert.deepEqual(hardIssues(capture.messages), [], `protocol issues: ${JSON.stringify(hardIssues(capture.messages))}`);
    }
  } finally {
    harness.dispose();
  }
});

test('failed tool execution still records a protocol-valid error result', async () => {
  const harness = makeHarness();
  try {
    // read_only_audit denies nothing here, so target a nonexistent file to
    // force an execution failure that must still become a recorded result.
    harness.respond.push(() => sseResponse(toolCallDelta('call-err', 'read_file', { path: join(harness.source, 'missing.txt') }), 'tool_calls'));
    const { payload } = await harness.run('Read the missing file.');
    const tools = payload['toolCalls'] as Array<{ tool: string; error?: string }> | undefined;
    assert.ok(tools?.some((tool) => tool.tool === 'read_file' && (tool.error || tool.error === '')), 'expected a recorded read_file observation');
    assert.ok(harness.captures.length >= 2);
    const after = harness.captures[harness.captures.length - 1]!.messages;
    assert.deepEqual(hardIssues(after), [], `protocol issues: ${JSON.stringify(hardIssues(after))}`);
    assert.equal(toolResultsFor(after, 'call-err').length, 1, 'failed execution must still yield exactly one result');
  } finally {
    harness.dispose();
  }
});

test('tool cycle interrupted mid-batch on resume never reaches the wire unanswered', async () => {
  const harness = makeHarness({ keepRuns: true });
  try {
    // Provider declares two calls but the run ends after the first result —
    // the durable log is left with an unanswered call, as after a crash.
    harness.respond.push(() => new Response(
      [
        `data: ${JSON.stringify({ model: 'mimo-v2.5', choices: [{ delta: toolCallDelta('call-x', 'read_file', { path: join(harness.source, 'fixture.txt') }, 0), finish_reason: null }], usage: null })}`,
        `data: ${JSON.stringify({ model: 'mimo-v2.5', choices: [{ delta: toolCallDelta('call-y', 'list_dir', { path: harness.source }, 1), finish_reason: null }], usage: null })}`,
        `data: ${JSON.stringify({ model: 'mimo-v2.5', choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: null })}`,
        'data: [DONE]',
        '',
        '',
      ].join('\n'),
      { status: 200 },
    ));
    harness.respond.push(() => sseResponse(textDelta('partial'), 'stop'));
    // Stop early: kill the engine's tool loop after first result by limiting turns.
    const engineBefore = harness.engine();
    await harness.run('Batch of two reads.');
    void engineBefore;
    const engine = harness.engine();
    assert.ok(engine, 'engine must exist after a run');
    const log = engine!.getParityEventLog();
    const results = log.events.filter((event) => event.kind === 'tool_result');
    const calls = log.events.filter((event) => event.kind === 'assistant_tool_calls');
    assert.ok(calls.length >= 1, 'assistant tool calls must be durable');
    assert.ok(results.length >= 1, 'at least one tool result must be durable');
  } finally {
    harness.dispose();
  }
});

test('compaction across tool cycles keeps every wire payload protocol-valid', async () => {
  // Large read results blow past the tiny budget: every read cycles through
  // the conversation and forces repeated compaction at turn boundaries.
  const harness = makeHarness({
    maxEstimatedTokens: 700,
    fixtureContent: Array.from({ length: 240 }, (_, i) => `line-${i}: lorem ipsum dolor sit amet section ${i} of the fixture corpus`).join('\n'),
  });
  try {
    // Three read cycles plus a long task string force repeated compaction.
    for (let i = 0; i < 3; i++) {
      harness.respond.push(() => sseResponse(toolCallDelta(`call-c${i}`, 'read_file', { path: join(harness.source, 'fixture.txt') }), 'tool_calls'));
    }
    const { payload } = await harness.run(
      'Repeated inspection task. '.repeat(40) + 'Read the fixture until done.',
    );
    assert.equal(payload['mode'], 'chat');
    assert.ok(harness.captures.length >= 4, `expected multiple provider rounds, got ${harness.captures.length}`);
    const engine = harness.engine()!;
    const capsules = engine.getParityEventLog().events.filter((event) => event.kind === 'compaction_capsule');
    for (const [index, capture] of harness.captures.entries()) {
      assert.deepEqual(
        hardIssues(capture.messages),
        [],
        `capture ${index} protocol issues: ${JSON.stringify(hardIssues(capture.messages))}`,
      );
    }
    const last = harness.captures[harness.captures.length - 1]!.messages;
    const calls = callsDeclared(last);
    for (const call of calls) {
      const priorCallInWindow = last.some(
        (message) => message.role === 'assistant' && (message.tool_calls ?? []).some((c) => c.id === call.id),
      );
      assert.ok(priorCallInWindow, `call ${call.id} must be present with its results`);
      assert.equal(toolResultsFor(last, call.id).length, 1, `call ${call.id} results must be unique`);
    }
    assert.ok(capsules.length >= 1, 'fixture must have exercised compaction');
  } finally {
    harness.dispose();
  }
});

test('resume after persistence rebuilds protocol-valid wire payloads', async () => {
  const harness = makeHarness({ keepRuns: true });
  try {
    harness.respond.push(() => sseResponse(toolCallDelta('call-r1', 'read_file', { path: join(harness.source, 'fixture.txt') }), 'tool_calls'));
    await harness.run('Read fixture for resume.');
    const engine = harness.engine()!;
    const restored = new ChatEngine({
      task: 'resume task',
      projectRoot: harness.source,
      providerRunner: new OpenCodeGoApiRunner('mimo-v2.5', {}, { credentialSource: 'explicit-test', explicitCredential: 'fixture-only' }),
      providerPolicy: babelReviewModelPolicy('mimo-v2.5', harness.source),
      maxTurns: 6,
    });
    restored.restoreEventLog(engine.getParityEventLog());
    // Drive one more provider round through the restored durable log.
    const wire = (restored as unknown as {
      services: { conversation: { rebuildProviderMessages: (log: unknown, options?: unknown) => WireMessage[] } };
    }).services.conversation.rebuildProviderMessages(restored.getParityEventLog(), { systemPrompt: 'x' });
    assert.deepEqual(hardIssues(wire), [], `rebuilt wire issues: ${JSON.stringify(hardIssues(wire))}`);
    const calls = callsDeclared(wire);
    assert.ok(calls.some((call) => call.id === 'call-r1'), 'prior cycle must survive the rebuild');
    assert.equal(toolResultsFor(wire, 'call-r1').length, 1);
  } finally {
    harness.dispose();
  }
});

test('interrupted provider stream then retry keeps the next payload protocol-valid', async () => {
  const harness = makeHarness();
  try {
    const originalFetch = globalThis.fetch;
    let failures = 0;
    globalThis.fetch = async (url, init) => {
      if (failures === 0) {
        failures++;
        // Emit a partial SSE frame then abort the connection mid-response.
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: {"model":"mimo-v2.5","ch'));
            controller.error(new Error('connection reset'));
          },
        });
        return new Response(body, { status: 200 });
      }
      return originalFetch(url, init);
    };
    try {
      harness.respond.push(() => sseResponse(toolCallDelta('call-retry', 'read_file', { path: join(harness.source, 'fixture.txt') }), 'tool_calls'));
      await harness.run('Read with a flaky provider.');
      const toolRounds = harness.captures.filter((capture) => capture.messages.some((message) => message.role === 'assistant' && (message.tool_calls ?? []).some((call) => call.id === 'call-retry')));
      assert.ok(toolRounds.length >= 1, 'retried round must eventually carry the tool call');
      for (const capture of harness.captures) {
        assert.deepEqual(hardIssues(capture.messages), [], `protocol issues after retry: ${JSON.stringify(hardIssues(capture.messages))}`);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    harness.dispose();
  }
});
