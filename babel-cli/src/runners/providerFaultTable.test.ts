import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { DeepInfraApiRunner } from './deepInfraApi.js';
import { DeepSeekApiRunner } from './deepSeekApi.js';
import { validateProviderMessageProtocol } from './providerMessages.js';
import { resolveRuntimeInvariantMode } from '../agent/runtimeInvariants.js';
import type { ProviderMessage } from './base.js';
import type { ToolStreamEvent } from './base.js';

const originalFetch = globalThis.fetch;
const originalDeepInfraKey = process.env['DEEPINFRA_API_KEY'];
const originalDeepSeekKey = process.env['DEEPSEEK_API_KEY'];
const originalIdleTimeout = process.env['BABEL_DEEPINFRA_STREAM_IDLE_TIMEOUT_MS'];
const originalDeepSeekIdle = process.env['BABEL_DEEPSEEK_STREAM_IDLE_TIMEOUT_MS'];
const originalDeepSeekReqTimeout = process.env['BABEL_DEEPSEEK_REQUEST_TIMEOUT_MS'];
const originalDeepInfraReqTimeout = process.env['BABEL_DEEPINFRA_REQUEST_TIMEOUT_MS'];
const originalDeepSeekRetries = process.env['BABEL_DEEPSEEK_REQUEST_MAX_RETRIES'];
const originalDeepInfraRetries = process.env['BABEL_DEEPINFRA_REQUEST_MAX_RETRIES'];
const originalExperiment = process.env['BABEL_EXPERIMENT'];
const originalPreflight = process.env['BABEL_PREFLIGHT'];
const originalInvariants = process.env['BABEL_RUNTIME_INVARIANTS'];
const originalNodeEnv = process.env['NODE_ENV'];
const originalCi = process.env['CI'];

beforeEach(() => {
  process.env['DEEPINFRA_API_KEY'] = 'test-infra-key';
  process.env['DEEPSEEK_API_KEY'] = 'sk-test-deepseek-key';
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  restoreEnv('DEEPINFRA_API_KEY', originalDeepInfraKey);
  restoreEnv('DEEPSEEK_API_KEY', originalDeepSeekKey);
  restoreEnv('BABEL_DEEPINFRA_STREAM_IDLE_TIMEOUT_MS', originalIdleTimeout);
  restoreEnv('BABEL_DEEPSEEK_STREAM_IDLE_TIMEOUT_MS', originalDeepSeekIdle);
  restoreEnv('BABEL_DEEPSEEK_REQUEST_TIMEOUT_MS', originalDeepSeekReqTimeout);
  restoreEnv('BABEL_DEEPINFRA_REQUEST_TIMEOUT_MS', originalDeepInfraReqTimeout);
  restoreEnv('BABEL_DEEPSEEK_REQUEST_MAX_RETRIES', originalDeepSeekRetries);
  restoreEnv('BABEL_DEEPINFRA_REQUEST_MAX_RETRIES', originalDeepInfraRetries);
  restoreEnv('BABEL_EXPERIMENT', originalExperiment);
  restoreEnv('BABEL_PREFLIGHT', originalPreflight);
  restoreEnv('BABEL_RUNTIME_INVARIANTS', originalInvariants);
  restoreEnv('NODE_ENV', originalNodeEnv);
  restoreEnv('CI', originalCi);
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function makeSseResponse(sseLines: string[]): Response {
  const data = sseLines.join('\n') + '\n';
  return new Response(data, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function hangingAfter(sseLines: string[]): Response {
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      controller.enqueue(encoder.encode(sseLines.join('\n') + '\n'));
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function eofAfter(sseLines: string[]): Response {
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      controller.enqueue(encoder.encode(sseLines.join('\n') + '\n'));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function errorAfter(sseLines: string[], err: Error): Response {
  let delivered = false;
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      controller.enqueue(encoder.encode(sseLines.join('\n') + '\n'));
      delivered = true;
    },
    pull(controller) {
      if (delivered) controller.error(err);
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

async function collect(
  gen: AsyncGenerator<ToolStreamEvent, void, undefined>,
): Promise<ToolStreamEvent[]> {
  const events: ToolStreamEvent[] = [];
  try {
    for await (const ev of gen) events.push(ev);
  } catch (err) {
    events.push({
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
    });
  }
  return events;
}

function deepInfra(): DeepInfraApiRunner {
  return new DeepInfraApiRunner('deepseek-ai/DeepSeek-V3-0324');
}

function deepSeek(): DeepSeekApiRunner {
  return new DeepSeekApiRunner('deepseek-v4-flash');
}

const USER: ProviderMessage[] = [{ role: 'user', content: 'status' }];

describe('Canary B: Provider Fault Table Verification', () => {
  it('Fault Table Row 1: normal text completion yields text deltas and done', async () => {
    globalThis.fetch = (async () =>
      makeSseResponse([
        'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"All systems "}}]}',
        'data: {"choices":[{"index":0,"delta":{"content":"operational."}}]}',
        'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":4,"total_tokens":14}}',
        'data: [DONE]',
      ])) as typeof fetch;

    const events = await collect(deepInfra().executeWithToolsStream(USER, []));
    assert.equal(events.length, 3);
    assert.equal(events[0]?.type, 'text_delta');
    assert.equal(events[1]?.type, 'text_delta');
    assert.equal(events[2]?.type, 'done');
    if (events[2]?.type === 'done') assert.equal(events[2].finishReason, 'stop');
    assert.equal(events.some((e) => e.type === 'error'), false);
  });

  it('Fault Table Row 2: normal tool call yields tool_use with parsed input', async () => {
    globalThis.fetch = (async () =>
      makeSseResponse([
        'data: {"choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_read_1","type":"function","function":{"name":"read_file","arguments":""}}]}}]}',
        'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":\\"src/main.ts\\"}"}}]}}]}',
        'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}',
        'data: [DONE]',
      ])) as typeof fetch;

    const events = await collect(deepInfra().executeWithToolsStream(USER, []));
    assert.equal(events[0]?.type, 'tool_use');
    if (events[0]?.type === 'tool_use') {
      assert.equal(events[0].id, 'call_read_1');
      assert.equal(events[0].name, 'read_file');
      assert.deepEqual(events[0].input, { path: 'src/main.ts' });
    }
    assert.equal(events[1]?.type, 'done');
  });

  it('Fault Table Row 3: parallel tool calls yield distinct tool_use events', async () => {
    globalThis.fetch = (async () =>
      makeSseResponse([
        'data: {"choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_p1","type":"function","function":{"name":"tool_a","arguments":"{\\"a\\":1}"}},{"index":1,"id":"call_p2","type":"function","function":{"name":"tool_b","arguments":"{\\"b\\":2}"}}]}}]}',
        'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}',
        'data: [DONE]',
      ])) as typeof fetch;

    const events = await collect(deepSeek().executeWithToolsStream(USER, []));
    const toolEvents = events.filter((e) => e.type === 'tool_use');
    assert.equal(toolEvents.length, 2);
    if (toolEvents[0]?.type === 'tool_use') assert.deepEqual(toolEvents[0].input, { a: 1 });
    if (toolEvents[1]?.type === 'tool_use') assert.deepEqual(toolEvents[1].input, { b: 2 });
  });

  it('Fault Table Row 4: partial tool batch rejects and never synthesizes {}', async () => {
    globalThis.fetch = (async () =>
      makeSseResponse([
        'data: {"choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_trunc","type":"function","function":{"name":"read_file","arguments":""}}]}}]}',
        'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
        'data: [DONE]',
      ])) as typeof fetch;

    const events = await collect(deepInfra().executeWithToolsStream(USER, []));
    assert.equal(events.some((e) => e.type === 'tool_use'), false);
    const errEvent = events.find((e) => e.type === 'error');
    assert.ok(errEvent);
    if (errEvent?.type === 'error') assert.match(errEvent.message, /incomplete tool call/i);
  });

  it('Fault Table Row 5: malformed JSON arguments yields typed error', async () => {
    globalThis.fetch = (async () =>
      makeSseResponse([
        'data: {"choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_bad_json","type":"function","function":{"name":"str_replace","arguments":"{invalid_json:"}}]}}]}',
        'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}',
        'data: [DONE]',
      ])) as typeof fetch;

    const events = await collect(deepSeek().executeWithToolsStream(USER, []));
    assert.equal(events.some((e) => e.type === 'tool_use'), false);
    const errEvent = events.find((e) => e.type === 'error');
    assert.ok(errEvent);
    if (errEvent?.type === 'error') assert.match(errEvent.message, /malformed arguments/i);
  });

  it('Fault Table Row 6: duplicate call IDs rejected by provider protocol validator', () => {
    const messages: ProviderMessage[] = [
      { role: 'user', content: 'do work' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'call_dup_1', type: 'function', function: { name: 'tool_a', arguments: '{}' } },
          { id: 'call_dup_1', type: 'function', function: { name: 'tool_b', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_dup_1', content: 'result 1' },
    ];
    const issues = validateProviderMessageProtocol(messages);
    assert.ok(issues.some((i) => i.code === 'duplicate_tool_call_id'));
    assert.ok(issues.some((i) => i.code === 'unanswered_tool_call'));
  });

  it('Fault Table Row 7: orphan tool result rejected by provider protocol validator', () => {
    const messages: ProviderMessage[] = [
      { role: 'user', content: 'start' },
      { role: 'tool', tool_call_id: 'orphan_call_xyz', content: 'orphan observation' },
    ];
    const issues = validateProviderMessageProtocol(messages);
    assert.ok(issues.some((i) => i.code === 'orphan_tool_result'));
  });

  it('Fault Table Row 8: finish_reason error terminates with typed provider error', async () => {
    globalThis.fetch = (async () =>
      makeSseResponse([
        'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"Processing..."}}]}',
        'data: {"choices":[{"index":0,"delta":{},"finish_reason":"error"}]}',
        'data: [DONE]',
      ])) as typeof fetch;

    const events = await collect(deepInfra().executeWithToolsStream(USER, []));
    const errEvent = events.find((e) => e.type === 'error');
    assert.ok(errEvent);
    if (errEvent?.type === 'error') assert.match(errEvent.message, /finish_reason: error/);
    assert.equal(events.some((e) => e.type === 'done'), false);
  });

  it('Fault Table Row 9: finish_reason length with text yields done with length', async () => {
    globalThis.fetch = (async () =>
      makeSseResponse([
        'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"Long text that reached limit"}}]}',
        'data: {"choices":[{"index":0,"delta":{},"finish_reason":"length"}]}',
        'data: [DONE]',
      ])) as typeof fetch;

    const events = await collect(deepInfra().executeWithToolsStream(USER, []));
    const done = events.find((e) => e.type === 'done');
    assert.ok(done);
    if (done?.type === 'done') assert.equal(done.finishReason, 'length');
    assert.equal(events.some((e) => e.type === 'error'), false);
  });

  it('Fault Table Row 10: finish_reason length during tool call rejects incomplete tools', async () => {
    globalThis.fetch = (async () =>
      makeSseResponse([
        'data: {"choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_cut","type":"function","function":{"name":"write_file","arguments":"{\\"content\\":\\"half"}}]}}]}',
        'data: {"choices":[{"index":0,"delta":{},"finish_reason":"length"}]}',
        'data: [DONE]',
      ])) as typeof fetch;

    const events = await collect(deepSeek().executeWithToolsStream(USER, []));
    assert.equal(events.some((e) => e.type === 'tool_use'), false);
    const errEvent = events.find((e) => e.type === 'error');
    assert.ok(errEvent);
    if (errEvent?.type === 'error') {
      assert.match(errEvent.message, /truncated by (?:provider )?token limit \(finish_reason: length\)/);
    }
  });

  it('Fault Table Row 11: premature EOF without [DONE] is a transport/provider error (DeepSeek)', async () => {
    globalThis.fetch = (async () =>
      eofAfter(['data: {"choices":[{"index":0,"delta":{"content":"Cutoff"}}]}'])) as typeof fetch;

    const runner = deepSeek();
    const events = await collect(runner.executeWithToolsStream(USER, []));
    const errEvent = events.find((e) => e.type === 'error');
    assert.ok(errEvent, 'must emit error on abrupt EOF');
    if (errEvent?.type === 'error') {
      assert.match(errEvent.message, /stream (?:interrupted|closed before terminal)/i);
    }
    assert.equal(events.some((e) => e.type === 'done'), false);
  });

  it('Fault Table Row 11b: premature EOF without [DONE] is a transport/provider error (DeepInfra)', async () => {
    globalThis.fetch = (async () =>
      eofAfter(['data: {"choices":[{"index":0,"delta":{"content":"Cutoff"}}]}'])) as typeof fetch;

    const events = await collect(deepInfra().executeWithToolsStream(USER, []));
    const errEvent = events.find((e) => e.type === 'error');
    assert.ok(errEvent, 'must emit error on abrupt EOF');
    if (errEvent?.type === 'error') {
      assert.match(errEvent.message, /stream (?:interrupted|closed before terminal)/i);
    }
    assert.equal(events.some((e) => e.type === 'done'), false);
  });

  it('Fault Table Row 12: HTTP 502 retry recovers on the next attempt', async () => {
    let callCount = 0;
    globalThis.fetch = (async () => {
      callCount += 1;
      if (callCount === 1) return new Response('Bad Gateway', { status: 502 });
      return makeSseResponse([
        'data: {"choices":[{"index":0,"delta":{"content":"recovered"}}]}',
        'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
        'data: [DONE]',
      ]);
    }) as typeof fetch;

    const events = await collect(deepSeek().executeWithToolsStream(USER, []));
    assert.equal(callCount, 2, 'should retry on 502');
    assert.equal(events.some((e) => e.type === 'text_delta' && e.text === 'recovered'), true);
  });

  it('Fault Table Row 13: stream interruption yields typed error and preserves partial output', async () => {
    let callCount = 0;
    const runner = deepInfra();
    let completed: { partial_model_output?: boolean; actual_attempt?: number | null } | undefined;
    globalThis.fetch = (async () => {
      callCount += 1;
      return errorAfter(
        ['data: {"choices":[{"index":0,"delta":{"content":"initial"}}]}'],
        Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
      );
    }) as typeof fetch;

    const events = await collect(
      runner.executeWithToolsStream(USER, [], undefined, undefined, undefined, {
        onInvocationCompleted: (info) => {
          completed = {
            ...(info.partial_model_output !== undefined
              ? { partial_model_output: info.partial_model_output }
              : {}),
            ...(info.actual_attempt !== undefined ? { actual_attempt: info.actual_attempt } : {}),
          };
        },
      }),
    );
    const errEvent = events.find((e) => e.type === 'error');
    assert.ok(errEvent);
    if (errEvent?.type === 'error') assert.match(errEvent.message, /ECONNRESET/);
    assert.equal(events.some((e) => e.type === 'text_delta' && e.text === 'initial'), true);
    assert.equal(callCount, 1, 'must not retry after partial model output');
    assert.equal(completed?.partial_model_output, true);
    assert.equal(completed?.actual_attempt, 1);
  });

  it('Fault Table Row 14: idle timeout terminates when the stream stalls', async () => {
    process.env['BABEL_DEEPINFRA_STREAM_IDLE_TIMEOUT_MS'] = '50';
    globalThis.fetch = (async () =>
      hangingAfter(['data: {"choices":[{"index":0,"delta":{"content":"start"}}]}'])) as typeof fetch;

    const events = await collect(deepInfra().executeWithToolsStream(USER, []));
    const errEvent = events.find((e) => e.type === 'error');
    assert.ok(errEvent);
    if (errEvent?.type === 'error') assert.match(errEvent.message, /idle timeout/i);
  });

  it('Fault Table Row 15: total request deadline covers response body consumption', async () => {
    process.env['BABEL_DEEPSEEK_REQUEST_TIMEOUT_MS'] = '50';
    process.env['BABEL_DEEPSEEK_STREAM_IDLE_TIMEOUT_MS'] = '5000';
    globalThis.fetch = (async () =>
      hangingAfter(['data: {"choices":[{"index":0,"delta":{"content":"start"}}]}'])) as typeof fetch;

    const events = await collect(deepSeek().executeWithToolsStream(USER, []));
    const errEvent = events.find((e) => e.type === 'error');
    assert.ok(errEvent);
    if (errEvent?.type === 'error') {
      assert.match(errEvent.message, /request timeout after 50ms/i);
    }
  });

  it('Fault Table Row 16: caller cancellation during body consumption stays cancellation', async () => {
    process.env['BABEL_DEEPSEEK_STREAM_IDLE_TIMEOUT_MS'] = '2000';
    const controller = new AbortController();
    globalThis.fetch = (async () =>
      hangingAfter(['data: {"choices":[{"index":0,"delta":{"content":"start"}}]}'])) as typeof fetch;

    const runner = deepSeek();
    setTimeout(() => controller.abort(), 20);
    const events = await collect(
      runner.executeWithToolsStream(USER, [], undefined, controller.signal),
    );
    const errEvent = events.find((e) => e.type === 'error');
    assert.ok(errEvent);
    if (errEvent?.type === 'error') {
      assert.match(errEvent.message, /request cancelled/i);
      assert.doesNotMatch(errEvent.message, /request timeout/i);
    }
  });

  it('Fault Table Row 17: malformed SSE event is a typed provider error', async () => {
    globalThis.fetch = (async () =>
      makeSseResponse([
        'data: {"choices":[{"index":0,"delta":{"content":"ok"}}]}',
        'data: {not-json',
        'data: [DONE]',
      ])) as typeof fetch;

    const events = await collect(deepInfra().executeWithToolsStream(USER, []));
    const errEvent = events.find((e) => e.type === 'error');
    assert.ok(errEvent);
    if (errEvent?.type === 'error') assert.match(errEvent.message, /malformed sse/i);
    assert.equal(events.some((e) => e.type === 'done'), false);
  });

  it('Fault Table Row 18: provider error payload inside HTTP 200 stream is a provider error', async () => {
    globalThis.fetch = (async () =>
      makeSseResponse([
        'data: {"choices":[{"index":0,"delta":{"content":"partial"}}]}',
        'data: {"error":{"message":"upstream overloaded","type":"server_error"}}',
        'data: [DONE]',
      ])) as typeof fetch;

    const events = await collect(deepSeek().executeWithToolsStream(USER, []));
    const errEvent = events.find((e) => e.type === 'error');
    assert.ok(errEvent);
    if (errEvent?.type === 'error') {
      assert.match(errEvent.message, /provider stream error/i);
      assert.match(errEvent.message, /upstream overloaded/);
    }
    assert.equal(events.some((e) => e.type === 'done'), false);
  });

  it('Fault Table Row 19: retry after partial model output preserves attempt identity', async () => {
    let callCount = 0;
    const runner = deepSeek();
    const attempts: number[] = [];
    globalThis.fetch = (async () => {
      callCount += 1;
      if (callCount === 1) {
        return errorAfter(
          ['data: {"choices":[{"index":0,"delta":{"content":"partial-one"}}]}'],
          new Error('socket hang up'),
        );
      }
      return makeSseResponse([
        'data: {"choices":[{"index":0,"delta":{"content":"should-not-retry"}}]}',
        'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
        'data: [DONE]',
      ]);
    }) as typeof fetch;

    let completed: { partial_model_output?: boolean; actual_attempt?: number | null } | undefined;
    const events = await collect(
      runner.executeWithToolsStream(USER, [], undefined, undefined, undefined, {
        onInvocationCompleted: (info) => {
          if (typeof info.actual_attempt === 'number') attempts.push(info.actual_attempt);
          completed = {
            ...(info.partial_model_output !== undefined
              ? { partial_model_output: info.partial_model_output }
              : {}),
            ...(info.actual_attempt !== undefined ? { actual_attempt: info.actual_attempt } : {}),
          };
        },
      }),
    );
    assert.equal(callCount, 1, 'partial model output must not start a new identical request');
    const errEvent = events.find((e) => e.type === 'error');
    assert.ok(errEvent);
    assert.equal(completed?.partial_model_output, true);
    assert.equal(completed?.actual_attempt ?? attempts[0], 1);
  });

  it('Fault Table Row 20: interrupted tool batch yields error and zero tool_use', async () => {
    globalThis.fetch = (async () =>
      eofAfter([
        'data: {"choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_int","type":"function","function":{"name":"read_file","arguments":"{\\"path\\":"}}]}}]}',
      ])) as typeof fetch;

    const events = await collect(deepInfra().executeWithToolsStream(USER, []));
    assert.equal(events.some((e) => e.type === 'tool_use'), false);
    const errEvent = events.find((e) => e.type === 'error');
    assert.ok(errEvent);
    if (errEvent?.type === 'error') {
      assert.match(errEvent.message, /stream (?:interrupted|closed before terminal)/i);
    }
  });

  it('invalid history generates zero outbound model requests', async () => {
    let callCount = 0;
    globalThis.fetch = (async () => {
      callCount += 1;
      return makeSseResponse(['data: [DONE]']);
    }) as typeof fetch;

    const invalid: ProviderMessage[] = [
      { role: 'user', content: 'start' },
      { role: 'tool', tool_call_id: 'orphan_call_xyz', content: 'orphan observation' },
    ];
    const events = await collect(deepSeek().executeWithToolsStream(invalid, []));
    assert.equal(callCount, 0, 'invalid history must not POST to the provider');
    const errEvent = events.find((e) => e.type === 'error');
    assert.ok(errEvent);
    if (errEvent?.type === 'error') assert.match(errEvent.message, /invalid provider protocol/i);
  });

  it('experiment / preflight configuration resolves protocol invariants to enforce', () => {
    delete process.env['BABEL_RUNTIME_INVARIANTS'];
    process.env['NODE_ENV'] = 'production';
    delete process.env['CI'];
    const env = { NODE_ENV: 'production', BABEL_EXPERIMENT: '1' } as NodeJS.ProcessEnv;
    assert.equal(resolveRuntimeInvariantMode(undefined, env), 'enforce');
    const preflight = { NODE_ENV: 'production', BABEL_PREFLIGHT: 'true' } as NodeJS.ProcessEnv;
    assert.equal(resolveRuntimeInvariantMode(undefined, preflight), 'enforce');
    const prod = { NODE_ENV: 'production' } as NodeJS.ProcessEnv;
    assert.equal(resolveRuntimeInvariantMode(undefined, prod), 'shadow');
  });

  it('usage-only empty-choice chunk is recorded, not dropped', async () => {
    const runner = deepInfra();
    globalThis.fetch = (async () =>
      makeSseResponse([
        'data: {"choices":[{"index":0,"delta":{"content":"hi"}}]}',
        'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":20,"total_tokens":120}}',
        'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
        'data: [DONE]',
      ])) as typeof fetch;

    await collect(runner.executeWithToolsStream(USER, []));
    const meta = runner.getLastInvocationMetadata();
    assert.equal(meta?.prompt_tokens, 100);
    assert.equal(meta?.completion_tokens, 20);
  });
});
