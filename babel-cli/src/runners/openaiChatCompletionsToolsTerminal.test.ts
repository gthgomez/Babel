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
  constructor(private readonly body: string, provider: 'openai' | 'openrouter' = 'openai') {
    super('fixture-model', 'FIXTURE_KEY', {}, {
      provider,
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

test('OpenRouter blank stop is marked retryable only after a complete validated stream', async () => {
  const runner = new FixtureRunner(`${frame({ content: '\n' }, 'stop')}${done}`, 'openrouter');
  const events: ToolStreamEvent[] = [];
  for await (const event of runner.executeWithToolsStream(
    [{ role: 'user', content: 'Continue the fixture.' }],
    tools,
  )) events.push(event);
  const error = events.at(-1);
  assert.equal(error?.type, 'error');
  assert.equal(error?.type === 'error' && error.retryableBlankStop, true);
  assert.equal(events.some(event => event.type === 'tool_use'), false);
});

test('OpenRouter blank stop without observed identity is never marked retryable', async () => {
  const runner = new FixtureRunner(
    `${frame({ content: '\n' }, 'stop')}${done}`.replace('model":"fixture-model",', ''),
    'openrouter',
  );
  const events: ToolStreamEvent[] = [];
  for await (const event of runner.executeWithToolsStream(
    [{ role: 'user', content: 'Continue the fixture.' }],
    tools,
  )) events.push(event);
  const error = events.at(-1);
  assert.equal(error?.type, 'error');
  assert.equal(error?.type === 'error' && error.retryableBlankStop, undefined);
});

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
  assert.equal(completions[0]?.requested_output_budget, null);
  assert.equal(completions[0]?.sent_output_budget, 32_000);
  assert.equal(completions[0]?.provider_effective_output_budget, null);
  assert.equal(completions[0]?.provider_finish_reason, 'stop');
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

test('tool completion without an accumulated call fails while preserving the reported finish', async () => {
  const { events, completions } = await collect(`${frame({ content: 'partial' }, 'tool_calls')}${done}`);
  assert.deepEqual(events.map((event) => event.type), ['text_delta', 'error']);
  const error = events.at(-1);
  assert.equal(error?.type === 'error' && error.terminalFailure, 'tool_completion_without_call');
  assert.equal(completions.length, 1);
  assert.equal(completions[0]?.status, 'failed');
  assert.equal(completions[0]?.usage_metadata?.normalized_finish_reason, 'TOOL_CALL');
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

test('conflicting or unindexed tool fragments cannot overwrite a pending tool', async () => {
  const first = { index: 0, id: 'first', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } };
  for (const last of [
    { index: 0, id: 'other', function: { name: 'other_tool' } },
    { id: 'unindexed', function: { name: 'read_file', arguments: '{}' } },
  ]) {
    const { events, completions } = await collect(
      `${frame({ tool_calls: [first] }, null)}${frame({ tool_calls: [last] }, 'tool_calls')}${done}`,
    );
    assert.deepEqual(events.map((event) => event.type), ['error']);
    assert.equal(completions.length, 1);
    assert.equal(completions[0]?.failure_class, 'PROTOCOL_ERROR');
    assert.equal(completions[0]?.partial_model_output, true);
  }
});

test('empty stop and malformed tail fail with their own causes', async () => {
  const empty = await collect(`${frame({}, 'stop')}${done}`);
  assert.equal(empty.events.at(-1)?.type, 'error');
  assert.equal(empty.completions[0]?.failure_class, 'PROTOCOL_ERROR');
  assert.equal(empty.completions[0]?.partial_model_output, false);

  const partial = await collect(`${frame({ content: 'partial' }, null)}data: {"error":{"code":"rate_limit_exceeded"}}`);
  assert.equal(partial.events.at(-1)?.type, 'error');
  assert.equal(partial.completions[0]?.api_error_code, 'rate_limit_exceeded');
  assert.equal(partial.completions[0]?.partial_model_output, true);
});

test('ending stream iteration early records one interrupted invocation', async () => {
  const runner = new FixtureRunner(`${frame({ content: 'partial' }, null)}${done}`);
  const completions: ProviderInvocationCompleted[] = [];
  for await (const event of runner.executeWithToolsStream(
    [{ role: 'user', content: 'Inspect the fixture.' }],
    tools, undefined, undefined, undefined,
    { onInvocationCompleted: completion => completions.push(completion) },
  )) {
    assert.equal(event.type, 'text_delta');
    break;
  }
  assert.equal(completions.length, 1);
  assert.equal(completions[0]?.status, 'failed');
  assert.equal(completions[0]?.partial_model_output, true);
  assert.equal(completions[0]?.normalized_finish_reason, 'INTERRUPTED');
});

test('interleaved argument fragments retain their own tool index', async () => {
  const { events, completions } = await collect(
    frame({ tool_calls: [
      { index: 0, id: 'a', function: { name: 'read_file', arguments: '{"path":' } },
      { index: 1, id: 'b', function: { name: 'read_file', arguments: '{"path":' } },
    ] }, null) +
    frame({ tool_calls: [{ index: 1, function: { arguments: '"b"}' } }] }, null) +
    frame({ tool_calls: [{ index: 0, function: { arguments: '"a"}' } }] }, 'tool_calls') + done,
  );
  assert.deepEqual(events.flatMap(event => event.type === 'tool_use' ? [event.input['path']] : []), ['a', 'b']);
  assert.equal(completions[0]?.status, 'delivered');
});

test('tool arguments cannot be completed after the provider reports a finish', async () => {
  const { events, completions } = await collect(
    frame({ tool_calls: [{ index: 0, id: 'pending', function: { name: 'read_file', arguments: '{"path":' } }] }, 'tool_calls') +
    frame({ tool_calls: [{ index: 0, function: { arguments: '"a"}' } }] }, null) + done,
  );
  assert.deepEqual(events.map(event => event.type), ['error']);
  assert.equal(completions[0]?.failure_class, 'PROTOCOL_ERROR');
  assert.equal(completions[0]?.provider_finish_reason, 'tool_calls');
  assert.equal(completions[0]?.partial_model_output, true);
});

test('a provider length finish below the sent cap keeps the reported cause distinct', async () => {
  const { completions } = await collect(frame({ content: 'partial' }, 'length') +
    'data: {"usage":{"prompt_tokens":45,"completion_tokens":2048}}\n\n' + done);
  assert.equal(completions[0]?.failure_class, 'INCOMPLETE_STREAM');
  assert.equal(completions[0]?.provider_finish_reason, 'length');
  assert.equal(completions[0]?.sent_output_budget, 32_000);
  assert.equal(completions[0]?.provider_effective_output_budget, null);
  assert.equal(completions[0]?.failure_attribution, 'UNKNOWN');
  assert.equal(completions[0]?.usage_metadata?.completion_tokens, 2048);
});

test('non-streaming empty and truncated responses fail their invocation receipt', async () => {
  for (const [content, finish] of [['', 'stop'], ['partial', 'length']]) {
    const runner = new FixtureRunner(JSON.stringify({
      model: 'fixture-model',
      choices: [{ message: { content }, finish_reason: finish }],
    }));
    const completed: ProviderInvocationCompleted[] = [];
    await assert.rejects(runner.executeRaw('Fixture prompt', {
      onInvocationCompleted: completion => completed.push(completion),
    }), /Empty response|finish_reason: length/);
    assert.equal(completed.length, 1);
    assert.equal(completed[0]?.status, 'failed');
    assert.equal(completed[0]?.provider_finish_reason, finish);
    assert.equal(completed[0]?.partial_model_output, content !== '');
  }
});
