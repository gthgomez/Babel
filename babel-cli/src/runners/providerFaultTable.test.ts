import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { DeepInfraApiRunner } from './deepInfraApi.js';
import { DeepSeekApiRunner } from './deepSeekApi.js';
import { validateProviderMessageProtocol } from './providerMessages.js';
import type { ProviderMessage } from './base.js';

const originalFetch = globalThis.fetch;
const originalDeepInfraKey = process.env['DEEPINFRA_API_KEY'];
const originalDeepSeekKey = process.env['DEEPSEEK_API_KEY'];
const originalIdleTimeout = process.env['BABEL_DEEPINFRA_STREAM_IDLE_TIMEOUT_MS'];
const originalDeepSeekReqTimeout = process.env['BABEL_DEEPSEEK_REQUEST_TIMEOUT_MS'];

beforeEach(() => {
  process.env['DEEPINFRA_API_KEY'] = 'test-infra-key';
  process.env['DEEPSEEK_API_KEY'] = 'sk-test-deepseek-key';
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalDeepInfraKey === undefined) {
    delete process.env['DEEPINFRA_API_KEY'];
  } else {
    process.env['DEEPINFRA_API_KEY'] = originalDeepInfraKey;
  }
  if (originalDeepSeekKey === undefined) {
    delete process.env['DEEPSEEK_API_KEY'];
  } else {
    process.env['DEEPSEEK_API_KEY'] = originalDeepSeekKey;
  }
  if (originalIdleTimeout === undefined) {
    delete process.env['BABEL_DEEPINFRA_STREAM_IDLE_TIMEOUT_MS'];
  } else {
    process.env['BABEL_DEEPINFRA_STREAM_IDLE_TIMEOUT_MS'] = originalIdleTimeout;
  }
  if (originalDeepSeekReqTimeout === undefined) {
    delete process.env['BABEL_DEEPSEEK_REQUEST_TIMEOUT_MS'];
  } else {
    process.env['BABEL_DEEPSEEK_REQUEST_TIMEOUT_MS'] = originalDeepSeekReqTimeout;
  }
});

function makeSseResponse(sseLines: string[]): Response {
  const data = sseLines.join('\n') + '\n';
  return new Response(data, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

describe('Canary B: Provider Fault Table Verification', () => {

  // 1. Normal Completion
  it('Fault Table Row 1: normal completion yields text deltas and done finish', async () => {
    globalThis.fetch = (async () =>
      makeSseResponse([
        'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"All systems "}}]}',
        'data: {"choices":[{"index":0,"delta":{"content":"operational."}}]}',
        'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":4,"total_tokens":14}}',
        'data: [DONE]',
      ])) as typeof fetch;

    const runner = new DeepInfraApiRunner('deepseek-ai/DeepSeek-V3-0324');
    const events: any[] = [];
    for await (const ev of runner.executeWithToolsStream([{ role: 'user', content: 'status' }], [])) {
      events.push(ev);
    }

    assert.equal(events.length, 3);
    assert.equal(events[0].type, 'text_delta');
    assert.equal(events[0].text, 'All systems ');
    assert.equal(events[1].type, 'text_delta');
    assert.equal(events[1].text, 'operational.');
    assert.equal(events[2].type, 'done');
    assert.equal(events[2].finishReason, 'stop');
  });

  // 2. Normal Tool Call
  it('Fault Table Row 2: normal tool call yields tool_use with parsed input', async () => {
    globalThis.fetch = (async () =>
      makeSseResponse([
        'data: {"choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_read_1","type":"function","function":{"name":"read_file","arguments":""}}]}}]}',
        'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":\\"src/main.ts\\"}"}}]}}]}',
        'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}',
        'data: [DONE]',
      ])) as typeof fetch;

    const runner = new DeepInfraApiRunner('deepseek-ai/DeepSeek-V3-0324');
    const events: any[] = [];
    for await (const ev of runner.executeWithToolsStream([{ role: 'user', content: 'read src/main.ts' }], [])) {
      events.push(ev);
    }

    assert.equal(events.length, 2);
    assert.equal(events[0].type, 'tool_use');
    assert.equal(events[0].id, 'call_read_1');
    assert.equal(events[0].name, 'read_file');
    assert.deepEqual(events[0].input, { path: 'src/main.ts' });
    assert.equal(events[1].type, 'done');
    assert.equal(events[1].finishReason, 'tool_calls');
  });

  // 3. Parallel Tool Calls
  it('Fault Table Row 3: parallel tool calls yield distinct tool_use events', async () => {
    globalThis.fetch = (async () =>
      makeSseResponse([
        'data: {"choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_p1","type":"function","function":{"name":"tool_a","arguments":"{\\"a\\":1}"}},{"index":1,"id":"call_p2","type":"function","function":{"name":"tool_b","arguments":"{\\"b\\":2}"}}]}}]}',
        'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}',
        'data: [DONE]',
      ])) as typeof fetch;

    const runner = new DeepSeekApiRunner('deepseek-v4-flash');
    const events: any[] = [];
    for await (const ev of runner.executeWithToolsStream([{ role: 'user', content: 'run parallel' }], [])) {
      events.push(ev);
    }

    const toolEvents = events.filter((e) => e.type === 'tool_use');
    assert.equal(toolEvents.length, 2);
    assert.equal(toolEvents[0].id, 'call_p1');
    assert.deepEqual(toolEvents[0].input, { a: 1 });
    assert.equal(toolEvents[1].id, 'call_p2');
    assert.deepEqual(toolEvents[1].input, { b: 2 });
  });

  // 4. Partial Tool Batch (Astra Probe P14: Never synthesize {})
  it('Fault Table Row 4: partial tool batch rejects with error, never synthesizes empty object', async () => {
    globalThis.fetch = (async () =>
      makeSseResponse([
        'data: {"choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_trunc","type":"function","function":{"name":"read_file","arguments":""}}]}}]}',
        'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
        'data: [DONE]',
      ])) as typeof fetch;

    const runner = new DeepInfraApiRunner('deepseek-ai/DeepSeek-V3-0324');
    const events: any[] = [];
    for await (const ev of runner.executeWithToolsStream([{ role: 'user', content: 'read' }], [])) {
      events.push(ev);
    }

    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'error');
    assert.match(events[0].message, /incomplete tool call/i);
    // Crucial check for P14: No tool_use with empty input {} was emitted
    assert.equal(events.some((e) => e.type === 'tool_use'), false);
  });

  // 5. Malformed JSON Arguments
  it('Fault Table Row 5: malformed JSON arguments yields typed error', async () => {
    globalThis.fetch = (async () =>
      makeSseResponse([
        'data: {"choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_bad_json","type":"function","function":{"name":"str_replace","arguments":"{invalid_json:"}}]}}]}',
        'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}',
        'data: [DONE]',
      ])) as typeof fetch;

    const runner = new DeepSeekApiRunner('deepseek-v4-flash');
    const events: any[] = [];
    for await (const ev of runner.executeWithToolsStream([{ role: 'user', content: 'replace' }], [])) {
      events.push(ev);
    }

    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'error');
    assert.match(events[0].message, /malformed arguments/i);
  });

  // 6. Duplicate Call IDs (Astra Probe P06)
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
    assert.ok(issues.length > 0);
    assert.ok(issues.some((i) => i.code === 'duplicate_tool_call_id'));
    assert.ok(issues.some((i) => i.code === 'unanswered_tool_call'));
  });

  // 7. Orphan Result
  it('Fault Table Row 7: orphan tool result rejected by provider protocol validator', () => {
    const messages: ProviderMessage[] = [
      { role: 'user', content: 'start' },
      { role: 'tool', tool_call_id: 'orphan_call_xyz', content: 'orphan observation' },
    ];

    const issues = validateProviderMessageProtocol(messages);
    assert.ok(issues.length > 0);
    assert.ok(issues.some((i) => i.code === 'orphan_tool_result'));
  });

  // 8. Provider Error Finish
  it('Fault Table Row 8: finish_reason error terminates with typed provider error', async () => {
    globalThis.fetch = (async () =>
      makeSseResponse([
        'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"Processing..."}}]}',
        'data: {"choices":[{"index":0,"delta":{},"finish_reason":"error"}]}',
        'data: [DONE]',
      ])) as typeof fetch;

    const runner = new DeepInfraApiRunner('deepseek-ai/DeepSeek-V3-0324');
    const events: any[] = [];
    for await (const ev of runner.executeWithToolsStream([{ role: 'user', content: 'run' }], [])) {
      events.push(ev);
    }

    const errEvent = events.find((e) => e.type === 'error');
    assert.ok(errEvent);
    assert.match(errEvent.message, /finish_reason: error/);
  });

  // 9. Output-Length Finish
  it('Fault Table Row 9a: finish_reason length with pending tool call rejects with error', async () => {
    globalThis.fetch = (async () =>
      makeSseResponse([
        'data: {"choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_cut","type":"function","function":{"name":"write_file","arguments":"{\\"content\\":\\"half"}}]}}]}',
        'data: {"choices":[{"index":0,"delta":{},"finish_reason":"length"}]}',
        'data: [DONE]',
      ])) as typeof fetch;

    const runner = new DeepSeekApiRunner('deepseek-v4-flash');
    const events: any[] = [];
    for await (const ev of runner.executeWithToolsStream([{ role: 'user', content: 'write file' }], [])) {
      events.push(ev);
    }

    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'error');
    assert.match(events[0].message, /truncated by token limit \(finish_reason: length\)/);
  });

  it('Fault Table Row 9b: finish_reason length on text completion yields done with length finishReason', async () => {
    globalThis.fetch = (async () =>
      makeSseResponse([
        'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"Long text that reached limit"}}]}',
        'data: {"choices":[{"index":0,"delta":{},"finish_reason":"length"}]}',
        'data: [DONE]',
      ])) as typeof fetch;

    const runner = new DeepInfraApiRunner('deepseek-ai/DeepSeek-V3-0324');
    const events: any[] = [];
    for await (const ev of runner.executeWithToolsStream([{ role: 'user', content: 'write story' }], [])) {
      events.push(ev);
    }

    assert.equal(events.length, 2);
    assert.equal(events[0].type, 'text_delta');
    assert.equal(events[1].type, 'done');
    assert.equal(events[1].finishReason, 'length');
  });

  // 10. Early EOF
  it('Fault Table Row 10: early stream EOF terminates with error event', async () => {
    globalThis.fetch = (async () => {
      const stream = new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode('data: {"choices":[{"index":0,"delta":{"content":"Cutoff"}}]}\n\n'));
          controller.close(); // Abrupt EOF without [DONE]
        },
      });
      return new Response(stream, { status: 200 });
    }) as typeof fetch;

    const runner = new DeepSeekApiRunner('deepseek-v4-flash');
    const events: any[] = [];
    for await (const ev of runner.executeWithToolsStream([{ role: 'user', content: 'test' }], [])) {
      events.push(ev);
    }

    const errEvent = events.find((e) => e.type === 'error');
    assert.ok(errEvent, 'must emit error on abrupt EOF');
    assert.match(errEvent.message, /stream (?:interrupted|closed before terminal)/i);
  });

  // 11. HTTP Retry
  it('Fault Table Row 11: HTTP retry recovers from 502 Bad Gateway', async () => {
    let callCount = 0;
    globalThis.fetch = (async () => {
      callCount += 1;
      if (callCount === 1) {
        return new Response('Bad Gateway', { status: 502 });
      }
      return makeSseResponse([
        'data: {"choices":[{"index":0,"delta":{"content":"recovered"}}]}',
        'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
        'data: [DONE]',
      ]);
    }) as typeof fetch;

    const runner = new DeepSeekApiRunner('deepseek-v4-flash');
    const events: any[] = [];
    for await (const ev of runner.executeWithToolsStream([{ role: 'user', content: 'retry test' }], [])) {
      events.push(ev);
    }

    assert.equal(callCount, 2, 'should retry on 502');
    assert.equal(events.some((e) => e.type === 'text_delta' && e.text === 'recovered'), true);
  });

  // 12. Stream Interruption
  it('Fault Table Row 12: stream interruption yields typed error', async () => {
    globalThis.fetch = (async () => {
      const stream = new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode('data: {"choices":[{"index":0,"delta":{"content":"initial"}}]}\n\n'));
          controller.error(new Error('read ECONNRESET'));
        },
      });
      return new Response(stream, { status: 200 });
    }) as typeof fetch;

    const runner = new DeepInfraApiRunner('deepseek-ai/DeepSeek-V3-0324');
    const events: any[] = [];
    for await (const ev of runner.executeWithToolsStream([{ role: 'user', content: 'interrupt test' }], [])) {
      events.push(ev);
    }

    const errEvent = events.find((e) => e.type === 'error');
    assert.ok(errEvent);
    assert.match(errEvent.message, /ECONNRESET/);
  });

  // 13. Idle Timeout
  it('Fault Table Row 13: idle timeout terminates when stream stalls', async () => {
    process.env['BABEL_DEEPINFRA_STREAM_IDLE_TIMEOUT_MS'] = '50';

    globalThis.fetch = (async () => {
      const stream = new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode('data: {"choices":[{"index":0,"delta":{"content":"start"}}]}\n\n'));
          // Intentionally do not enqueue or close, stalling the stream
        },
      });
      return new Response(stream, { status: 200 });
    }) as typeof fetch;

    const runner = new DeepInfraApiRunner('deepseek-ai/DeepSeek-V3-0324');
    const events: any[] = [];
    for await (const ev of runner.executeWithToolsStream([{ role: 'user', content: 'idle test' }], [])) {
      events.push(ev);
    }

    const errEvent = events.find((e) => e.type === 'error');
    assert.ok(errEvent);
    assert.match(errEvent.message, /idle timeout/i);
  });

  // 14. Total Request Timeout
  it('Fault Table Row 14: total request timeout terminates when deadline expires', async () => {
    process.env['BABEL_DEEPSEEK_REQUEST_TIMEOUT_MS'] = '50';

    globalThis.fetch = (async () => {
      const stream = new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode('data: {"choices":[{"index":0,"delta":{"content":"start"}}]}\n\n'));
          // Hangs indefinitely
        },
      });
      return new Response(stream, { status: 200 });
    }) as typeof fetch;

    const runner = new DeepSeekApiRunner('deepseek-v4-flash');
    const events: any[] = [];
    for await (const ev of runner.executeWithToolsStream(
      [{ role: 'user', content: 'deadline test' }],
      [],
    )) {
      events.push(ev);
    }

    const errEvent = events.find((e) => e.type === 'error');
    assert.ok(errEvent);
    assert.match(errEvent.message, /request timeout after 50ms/i);
  });

  // 15. Caller Cancellation
  it('Fault Table Row 15: caller cancellation terminates with cancellation error', async () => {
    const controller = new AbortController();

    globalThis.fetch = (async () => {
      const stream = new ReadableStream({
        start(streamCtrl) {
          const encoder = new TextEncoder();
          streamCtrl.enqueue(encoder.encode('data: {"choices":[{"index":0,"delta":{"content":"start"}}]}\n\n'));
          setTimeout(() => controller.abort(), 10);
        },
      });
      return new Response(stream, { status: 200 });
    }) as typeof fetch;

    const runner = new DeepSeekApiRunner('deepseek-v4-flash');
    const events: any[] = [];
    for await (const ev of runner.executeWithToolsStream(
      [{ role: 'user', content: 'cancel test' }],
      [],
      undefined,
      controller.signal,
    )) {
      events.push(ev);
    }

    const errEvent = events.find((e) => e.type === 'error');
    assert.ok(errEvent);
    assert.match(errEvent.message, /request cancelled/i);
  });
});
