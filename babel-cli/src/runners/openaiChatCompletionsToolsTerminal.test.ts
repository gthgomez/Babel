import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  ProviderInvocationCompleted,
  ToolDefinition,
  ToolStreamEvent,
} from './base.js';
import { OpenAiCompatibleRunner } from './protocol/openai-chat-completions-tools.js';

const tools: ToolDefinition[] = [{
  type: 'function',
  function: {
    name: 'read_file',
    description: 'Read one file',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
}];

class FixtureRunner extends OpenAiCompatibleRunner {
  constructor(private readonly body: string) {
    super('fixture-model', 'FIXTURE_KEY', {}, {
      provider: 'openai',
      explicitCredential: 'fixture-credential',
      env: {},
    });
  }

  protected override get apiUrl(): string {
    return 'https://fixture.invalid/v1/chat/completions';
  }

  protected override async dispatchFetch(): Promise<Response> {
    return new Response(this.body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  }
}

function frame(delta: Record<string, unknown>, finishReason: string | null): string {
  return `data: ${JSON.stringify({
    model: 'fixture-model',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

async function collect(body: string, abortAfterFirstTool?: AbortController): Promise<{
  events: ToolStreamEvent[];
  completions: ProviderInvocationCompleted[];
}> {
  const runner = new FixtureRunner(body);
  const events: ToolStreamEvent[] = [];
  const completions: ProviderInvocationCompleted[] = [];
  for await (const event of runner.executeWithToolsStream(
    [{ role: 'user', content: 'Inspect the fixture.' }],
    tools,
    undefined,
    abortAfterFirstTool?.signal,
    undefined,
    { onInvocationCompleted: (completion) => completions.push(completion) },
  )) {
    events.push(event);
    if (event.type === 'tool_use') abortAfterFirstTool?.abort();
  }
  return { events, completions };
}

const done = 'data: [DONE]\n\n';

function lastFinish(events: ToolStreamEvent[]): string | null {
  const last = events.at(-1);
  return last?.type === 'done' ? last.finishReason : null;
}

test('a normal stop yields text and one delivered receipt', async () => {
  const { events, completions } = await collect(`${frame({ content: 'answer' }, 'stop')}${done}`);
  assert.deepEqual(events.map((event) => event.type), ['text_delta', 'done']);
  assert.equal(lastFinish(events), 'stop');
  assert.equal(completions.length, 1);
  assert.equal(completions[0]?.status, 'delivered');
});

test('a missing finish fails instead of completing or executing tools', async () => {
  const text = await collect(`${frame({ content: 'partial answer' }, null)}${done}`);
  assert.deepEqual(text.events.map((event) => event.type), ['text_delta', 'error']);
  assert.equal(text.completions.length, 1);
  assert.equal(text.completions[0]?.status, 'failed');
  assert.equal(text.completions[0]?.failure_receipt?.partial_model_output, true);

  const tool = await collect(
    `${frame({ tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } }] }, null)}${done}`,
  );
  assert.equal(tool.events.some((event) => event.type === 'tool_use'), false);
  assert.equal(tool.events.at(-1)?.type, 'error');
  assert.equal(tool.completions.length, 1);
  assert.equal(tool.completions[0]?.status, 'failed');
  assert.equal(tool.completions[0]?.failure_receipt?.tool_call_count, 1);
});

test('filtered, unknown and truncated finishes fail without a completed answer', async () => {
  for (const finish of ['content_filter', 'recitation', 'gateway_magic', 'length']) {
    const { events, completions } = await collect(`${frame({ content: 'diagnostic text' }, finish)}${done}`);
    assert.equal(events.some((event) => event.type === 'done'), false, finish);
    assert.equal(events.at(-1)?.type, 'error', finish);
    assert.equal(completions.length, 1, finish);
    assert.equal(completions[0]?.status, 'failed', finish);
  }
});

test('filtered and truncated tool payloads fail without yielding tool input', async () => {
  for (const finish of ['content_filter', 'recitation', 'length']) {
    const { events, completions } = await collect(
      `${frame({ tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } }] }, finish)}${done}`,
    );
    assert.equal(events.some((event) => event.type === 'tool_use'), false, finish);
    assert.equal(events.at(-1)?.type, 'error', finish);
    assert.equal(completions.length, 1, finish);
    assert.equal(completions[0]?.status, 'failed', finish);
    assert.equal(completions[0]?.failure_receipt?.tool_call_count, 1, finish);
    assert.equal(completions[0]?.failure_receipt?.partial_model_output, true, finish);
    assert.equal(
      completions[0]?.failure_receipt?.failure_class,
      finish === 'length' ? 'INCOMPLETE_STREAM' : 'UNKNOWN_PROVIDER_FAILURE',
      finish,
    );
  }
});

test('an explicit tool_calls finish emits the validated tool payload', async () => {
  const { events, completions } = await collect(
    `${frame({ tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } }] }, 'tool_calls')}${done}`,
  );
  assert.deepEqual(events.map((event) => event.type), ['tool_use', 'done']);
  assert.equal(lastFinish(events), 'tool_calls');
  assert.equal(completions.length, 1);
  assert.equal(completions[0]?.status, 'delivered');
});

test('a stop finish with a complete tool payload remains actionable', async () => {
  const { events } = await collect(
    `${frame({ tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } }] }, 'stop')}${done}`,
  );
  assert.deepEqual(events.map((event) => event.type), ['tool_use', 'done']);
  assert.equal(lastFinish(events), 'tool_calls');
});

test('conflicting finish reasons fail even if the final reason is stop', async () => {
  const { events, completions } = await collect(`${frame({ content: 'partial' }, 'length')}${frame({}, 'stop')}${done}`);
  assert.deepEqual(events.map((event) => event.type), ['text_delta', 'error']);
  assert.equal(completions.length, 1);
  assert.equal(completions[0]?.status, 'failed');
  assert.equal(completions[0]?.failure_receipt?.failure_class, 'PROTOCOL_ERROR');
});

test('cancellation between native tool events stops the remaining batch and withholds done', async () => {
  const { events, completions } = await collect(`${frame({ tool_calls: [
    { index: 0, id: 'first', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } },
    { index: 1, id: 'second', type: 'function', function: { name: 'read_file', arguments: '{"path":"b"}' } },
  ] }, 'tool_calls')}${done}`, new AbortController());
  assert.deepEqual(events.map((event) => event.type), ['tool_use', 'error']);
  assert.equal(completions.length, 1);
  assert.equal(completions[0]?.status, 'failed');
});

test('a malformed later tool prevents the entire native batch from being exposed', async () => {
  const { events, completions } = await collect(`${frame({ tool_calls: [
    { index: 0, id: 'valid', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } },
    { index: 1, id: 'invalid', type: 'function', function: { name: 'read_file', arguments: '{' } },
  ] }, 'tool_calls')}${done}`);
  assert.deepEqual(events.map((event) => event.type), ['error']);
  assert.equal(completions[0]?.status, 'failed');
});
