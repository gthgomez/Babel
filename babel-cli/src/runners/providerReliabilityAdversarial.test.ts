import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';

import {
  buildProviderFailureReceipt,
  outputMaterialDigest,
} from './providerFailureReceipt.js';
import type { ProviderInvocationCompleted, RunnerCallbacks } from './base.js';
import type { DeepInfraApiRunner } from './deepInfraApi.js';

const originalFetch = globalThis.fetch;
const environmentNames = [
  'DEEPINFRA_API_KEY',
  'BABEL_DEEPINFRA_REQUEST_MAX_RETRIES',
  'BABEL_DEEPINFRA_REQUEST_TIMEOUT_MS',
  'BABEL_DEEPINFRA_STREAM_IDLE_TIMEOUT_MS',
  'BABEL_DEEPINFRA_STREAM_MAX_RETRIES',
  'BABEL_VCR_MODE',
  'BABEL_VCR_FILE',
] as const;
const originalEnvironment = new Map(
  environmentNames.map((name) => [name, process.env[name]] as const),
);

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const name of environmentNames) {
    const value = originalEnvironment.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function configureDeepInfra(options: {
  requestMaxAttempts?: number;
  streamIdleTimeoutMs?: number;
  streamMaxRetries?: number;
} = {}): void {
  process.env['DEEPINFRA_API_KEY'] = 'test-key';
  process.env['BABEL_DEEPINFRA_REQUEST_MAX_RETRIES'] = String(options.requestMaxAttempts ?? 1);
  process.env['BABEL_DEEPINFRA_REQUEST_TIMEOUT_MS'] = '1000';
  process.env['BABEL_DEEPINFRA_STREAM_IDLE_TIMEOUT_MS'] = String(options.streamIdleTimeoutMs ?? 20);
  process.env['BABEL_DEEPINFRA_STREAM_MAX_RETRIES'] = String(options.streamMaxRetries ?? 0);
  delete process.env['BABEL_VCR_MODE'];
  delete process.env['BABEL_VCR_FILE'];
}

function openResponse(
  chunks: Array<string | Uint8Array>,
  headers: Record<string, string> = {},
  close = false,
): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
      }
      if (close) controller.close();
    },
  });
  return new Response(body, { status: 200, headers });
}

function sseLine(value: Record<string, unknown>): string {
  return `data: ${JSON.stringify(value)}\n\n`;
}

function textSse(text: string, finishReason = 'stop'): string {
  return (
    sseLine({ choices: [{ delta: { content: text } }] }) +
    sseLine({ choices: [{ delta: {}, finish_reason: finishReason }] }) +
    'data: [DONE]\n\n'
  );
}

function toolSse(argumentsText: string): string {
  return (
    sseLine({
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            id: 'call_1',
            type: 'function',
            function: { name: 'read_file', arguments: argumentsText },
          }],
        },
      }],
    }) +
    sseLine({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }) +
    'data: [DONE]\n\n'
  );
}

function toolMessages(): [{ role: 'user'; content: string }] {
  return [{ role: 'user', content: 'read the file' }];
}

type Completion = ProviderInvocationCompleted;

async function collectNative(
  runner: Pick<DeepInfraApiRunner, 'executeWithToolsStream'>,
  callbacks?: RunnerCallbacks,
): Promise<Array<{ type: string; [key: string]: unknown }>> {
  const events: Array<{ type: string; [key: string]: unknown }> = [];
  for await (const event of runner.executeWithToolsStream(toolMessages(), [], undefined, undefined, undefined, callbacks)) {
    events.push(event);
  }
  return events;
}

function assertSingleFailure(completions: Completion[]): NonNullable<Completion['failure_receipt']> {
  assert.equal(completions.length, 1, 'every failed inference must finalize exactly once');
  assert.equal(completions[0]?.status, 'failed');
  const receipt = completions[0]?.failure_receipt;
  assert.ok(receipt, 'failed inference must include a provider failure receipt');
  return receipt;
}

test('T1/T14: partial text plus idle timeout is terminal and not replayed', async () => {
  configureDeepInfra({ streamMaxRetries: 1 });
  const { DeepInfraApiRunner } = await import('./deepInfraApi.js');
  let requests = 0;
  const chunks: string[] = [];
  const completions: Completion[] = [];
  globalThis.fetch = (async () => {
    requests += 1;
    return openResponse([sseLine({ choices: [{ delta: { content: '{"ok":' } }] })]);
  }) as typeof fetch;

  await assert.rejects(() => new DeepInfraApiRunner('deepseek-ai/DeepSeek-V3-0324').execute(
    'return ok',
    z.object({ ok: z.boolean() }),
    {
      onChunk: (chunk) => { chunks.push(chunk); },
      onInvocationCompleted: (event) => { completions.push(event); },
    },
  ));

  const receipt = assertSingleFailure(completions);
  assert.equal(requests, 1);
  assert.deepEqual(chunks, ['{"ok":']);
  assert.equal(receipt.partial_model_output, true);
  assert.equal(receipt.retryable, false);
  assert.equal(receipt.failure_stage, 'stream');
  assert.match(String(receipt.output_digest), /^[a-f0-9]{64}$/);
});

test('T2/T14: partial reasoning is recorded even without an onThought callback', async () => {
  configureDeepInfra({ streamMaxRetries: 1 });
  const { DeepInfraApiRunner } = await import('./deepInfraApi.js');
  let requests = 0;
  const completions: Completion[] = [];
  globalThis.fetch = (async () => {
    requests += 1;
    return openResponse([sseLine({ choices: [{ delta: { reasoning_content: 'thinking' } }] })]);
  }) as typeof fetch;

  await assert.rejects(() => new DeepInfraApiRunner('deepseek-ai/DeepSeek-V3-0324').execute(
    'return ok',
    z.object({ ok: z.boolean() }),
    {
      onChunk: () => {},
      onInvocationCompleted: (event) => { completions.push(event); },
    },
  ));

  const receipt = assertSingleFailure(completions);
  assert.equal(requests, 1);
  assert.equal(receipt.partial_model_output, true);
  assert.equal(receipt.retryable, false);
  assert.match(String(receipt.output_digest), /^[a-f0-9]{64}$/);
});

test('T3/T14: partial tool-call fragments are not replayed or duplicated', async () => {
  configureDeepInfra({ streamMaxRetries: 1 });
  const { DeepInfraApiRunner } = await import('./deepInfraApi.js');
  let requests = 0;
  const completions: Completion[] = [];
  globalThis.fetch = (async () => {
    requests += 1;
    return openResponse([sseLine({
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            id: 'call_1',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":' },
          }],
        },
      }],
    })]);
  }) as typeof fetch;

  const events = await collectNative(
    new DeepInfraApiRunner('deepseek-ai/DeepSeek-V3-0324'),
    { onInvocationCompleted: (event) => { completions.push(event); } },
  );

  const receipt = assertSingleFailure(completions);
  assert.equal(requests, 1);
  assert.deepEqual(events.map((event) => event.type), ['error']);
  assert.equal(receipt.partial_model_output, true);
  assert.equal(receipt.tool_call_count, 1);
  assert.equal(receipt.retryable, false);
});

test('T4/T14: zero-output idle timeout permits one bounded safe retry', async () => {
  configureDeepInfra({ requestMaxAttempts: 1, streamMaxRetries: 1 });
  const { DeepInfraApiRunner } = await import('./deepInfraApi.js');
  let requests = 0;
  const retryAttempts: number[] = [];
  const completions: Completion[] = [];
  const chunks: string[] = [];
  globalThis.fetch = (async () => {
    requests += 1;
    return requests === 1
      ? openResponse([])
      : openResponse([textSse('{"ok":true}')], {}, true);
  }) as typeof fetch;

  const result = await new DeepInfraApiRunner('deepseek-ai/DeepSeek-V3-0324').execute(
    'return ok',
    z.object({ ok: z.literal(true) }),
    {
      onChunk: (chunk) => { chunks.push(chunk); },
      onRetry: (event) => { retryAttempts.push(event.attempt); },
      onInvocationCompleted: (event) => { completions.push(event); },
    },
  );

  assert.deepEqual(result, { ok: true });
  assert.equal(requests, 2);
  assert.deepEqual(chunks, ['{"ok":true}']);
  assert.deepEqual(retryAttempts, [2]);
  assert.deepEqual(completions.map((event) => event.status), ['delivered']);
});

test('T5/T14: native tool-stream HTTP 402 records first attempt and provider identity', async () => {
  configureDeepInfra({ requestMaxAttempts: 4 });
  const { DeepInfraApiRunner } = await import('./deepInfraApi.js');
  let requests = 0;
  const completions: Completion[] = [];
  globalThis.fetch = (async () => {
    requests += 1;
    return new Response('{"error":{"code":"billing_required"}}', {
      status: 402,
      headers: { 'x-request-id': 'req-402' },
    });
  }) as typeof fetch;

  const events = await collectNative(
    new DeepInfraApiRunner('deepseek-ai/DeepSeek-V3-0324'),
    { onInvocationCompleted: (event) => { completions.push(event); } },
  );

  const receipt = assertSingleFailure(completions);
  assert.equal(requests, 1);
  assert.deepEqual(events.map((event) => event.type), ['error']);
  assert.equal(receipt.failure_class, 'HTTP_402');
  assert.equal(receipt.retryable, false);
  assert.equal(receipt.actual_attempt, 1);
  assert.equal(receipt.max_attempts, 4);
  assert.equal(receipt.provider_request_id, 'req-402');
  assert.equal(receipt.api_error_code, 'billing_required');
});

test('T6/T14: native tool-stream HTTP 429 exhaustion reports the final attempt', async () => {
  configureDeepInfra({ requestMaxAttempts: 2 });
  const { DeepInfraApiRunner } = await import('./deepInfraApi.js');
  let requests = 0;
  const completions: Completion[] = [];
  globalThis.fetch = (async () => {
    requests += 1;
    return new Response('{"error":{"code":"rate_limit"}}', {
      status: 429,
      headers: { 'retry-after': '0', 'x-request-id': `req-429-${requests}` },
    });
  }) as typeof fetch;

  await collectNative(
    new DeepInfraApiRunner('deepseek-ai/DeepSeek-V3-0324'),
    { onInvocationCompleted: (event) => { completions.push(event); } },
  );

  const receipt = assertSingleFailure(completions);
  assert.equal(requests, 2);
  assert.equal(receipt.failure_class, 'HTTP_429');
  assert.equal(receipt.retryable, false);
  assert.equal(receipt.actual_attempt, 2);
  assert.equal(receipt.max_attempts, 2);
});

test('T7/T14: final native transport failure leaves a request-stage receipt', async () => {
  configureDeepInfra({ requestMaxAttempts: 1 });
  const { DeepInfraApiRunner } = await import('./deepInfraApi.js');
  let requests = 0;
  const completions: Completion[] = [];
  globalThis.fetch = (async () => {
    requests += 1;
    throw new Error('socket transport failure');
  }) as typeof fetch;

  const events = await collectNative(
    new DeepInfraApiRunner('deepseek-ai/DeepSeek-V3-0324'),
    { onInvocationCompleted: (event) => { completions.push(event); } },
  );

  const receipt = assertSingleFailure(completions);
  assert.equal(requests, 1);
  assert.deepEqual(events.map((event) => event.type), ['error']);
  assert.equal(receipt.failure_class, 'TRANSPORT_FAILURE');
  assert.equal(receipt.failure_stage, 'request');
  assert.equal(receipt.actual_attempt, 1);
  assert.equal(receipt.max_attempts, 1);
});

test('T8/T14: native reader idle timeout produces one terminal failure', async () => {
  configureDeepInfra({ requestMaxAttempts: 1 });
  const { DeepInfraApiRunner } = await import('./deepInfraApi.js');
  const completions: Completion[] = [];
  globalThis.fetch = (async () => openResponse([])) as typeof fetch;

  const events = await collectNative(
    new DeepInfraApiRunner('deepseek-ai/DeepSeek-V3-0324'),
    { onInvocationCompleted: (event) => { completions.push(event); } },
  );

  const receipt = assertSingleFailure(completions);
  assert.deepEqual(events.map((event) => event.type), ['error']);
  assert.equal(receipt.failure_class, 'TIMEOUT');
  assert.equal(receipt.failure_stage, 'stream');
  assert.equal(receipt.retryable, false);
});

test('T9/T14: malformed accumulated tool arguments fail normalization once', async () => {
  configureDeepInfra({ requestMaxAttempts: 1 });
  const { DeepInfraApiRunner } = await import('./deepInfraApi.js');
  const completions: Completion[] = [];
  globalThis.fetch = (async () => openResponse([toolSse('{"path":')], {}, true)) as typeof fetch;

  const events = await collectNative(
    new DeepInfraApiRunner('deepseek-ai/DeepSeek-V3-0324'),
    { onInvocationCompleted: (event) => { completions.push(event); } },
  );

  const receipt = assertSingleFailure(completions);
  assert.deepEqual(events.map((event) => event.type), ['error']);
  assert.equal(receipt.failure_stage, 'response_normalization');
  assert.equal(receipt.failure_class, 'PROTOCOL_ERROR');
  assert.equal(receipt.tool_call_count, 1);
  assert.match(String(receipt.output_digest), /^[a-f0-9]{64}$/);
});

test('T10/T14: missing native streaming body is durably failed', async () => {
  configureDeepInfra({ requestMaxAttempts: 1 });
  const { DeepInfraApiRunner } = await import('./deepInfraApi.js');
  const completions: Completion[] = [];
  globalThis.fetch = (async () => new Response(null, { status: 200 })) as typeof fetch;

  const events = await collectNative(
    new DeepInfraApiRunner('deepseek-ai/DeepSeek-V3-0324'),
    { onInvocationCompleted: (event) => { completions.push(event); } },
  );

  const receipt = assertSingleFailure(completions);
  assert.deepEqual(events.map((event) => event.type), ['error']);
  assert.equal(receipt.failure_stage, 'stream');
  assert.equal(receipt.failure_class, 'UNKNOWN');
});

test('T11/T14: fragmented SSE frames and split UTF-8 remain lossless', async () => {
  configureDeepInfra({ requestMaxAttempts: 1 });
  const { DeepInfraApiRunner } = await import('./deepInfraApi.js');
  const chunks: string[] = [];
  const completions: Completion[] = [];
  const encoded = new TextEncoder().encode(textSse('{"text":"café"}'));
  const splitAt = encoded.findIndex((value, index) => value >= 0x80 && index > 0);
  assert.ok(splitAt > 0, 'fixture must contain a multibyte UTF-8 code point');
  globalThis.fetch = (async () => openResponse([
    encoded.slice(0, splitAt + 1),
    encoded.slice(splitAt + 1, splitAt + 7),
    encoded.slice(splitAt + 7),
  ], {}, true)) as typeof fetch;

  const result = await new DeepInfraApiRunner('deepseek-ai/DeepSeek-V3-0324').execute(
    'return text',
    z.object({ text: z.literal('café') }),
    {
      onChunk: (chunk) => { chunks.push(chunk); },
      onInvocationCompleted: (event) => { completions.push(event); },
    },
  );

  assert.deepEqual(result, { text: 'café' });
  assert.deepEqual(chunks, ['{"text":"café"}']);
  assert.deepEqual(completions.map((event) => event.status), ['delivered']);
});

test('T12/T14: closed partial stream fails without replay', async () => {
  configureDeepInfra({ requestMaxAttempts: 1, streamMaxRetries: 2 });
  const { DeepInfraApiRunner } = await import('./deepInfraApi.js');
  let requests = 0;
  const chunks: string[] = [];
  const completions: Completion[] = [];
  globalThis.fetch = (async () => {
    requests += 1;
    return openResponse([sseLine({ choices: [{ delta: { content: 'partial' } }] })], {}, true);
  }) as typeof fetch;

  await assert.rejects(() => new DeepInfraApiRunner('deepseek-ai/DeepSeek-V3-0324').execute(
    'return ok',
    z.object({ ok: z.boolean() }),
    {
      onChunk: (chunk) => { chunks.push(chunk); },
      onInvocationCompleted: (event) => { completions.push(event); },
    },
  ));

  const receipt = assertSingleFailure(completions);
  assert.equal(requests, 1);
  assert.deepEqual(chunks, ['partial']);
  assert.equal(receipt.partial_model_output, true);
  assert.equal(receipt.retryable, false);
});

test('T13: failure receipts preserve envelope, budget, upstream, and output provenance', () => {
  const receipt = buildProviderFailureReceipt({
    inferenceId: 'inference-1',
    provider: 'openrouter',
    model: 'z-ai/glm-5.3-flash',
    details: {
      status: 402,
      providerRequestId: 'openrouter-request-1',
      apiErrorCode: 'insufficient_credits',
    },
    observedUpstream: 'ExampleProvider',
    actualAttempt: 1,
    maxAttempts: 4,
    stream: true,
    failureStage: 'response',
    inferenceStarted: true,
    partialModelOutput: false,
    toolCallCount: 0,
    requestedOutputBudget: 8192,
    effectiveOutputBudget: 4096,
    wirePolicyHash: 'a'.repeat(64),
    executionEnvelopeHash: 'b'.repeat(64),
    outputMaterial: 'provider failure',
  });

  assert.equal(receipt.provider_request_id, 'openrouter-request-1');
  assert.equal(receipt.observed_upstream, 'ExampleProvider');
  assert.equal(receipt.requested_output_budget, 8192);
  assert.equal(receipt.effective_output_budget, 4096);
  assert.equal(receipt.wire_policy_hash, 'a'.repeat(64));
  assert.equal(receipt.execution_envelope_hash, 'b'.repeat(64));
  assert.equal(receipt.output_digest, outputMaterialDigest('provider failure'));
  assert.equal(receipt.retryable, false);
});
