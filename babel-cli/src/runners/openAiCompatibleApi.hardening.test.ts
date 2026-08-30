import assert from 'node:assert/strict'
import test from 'node:test'
import { OpenAICompatibleApiRunner } from './openAiCompatibleApi.js'
import { DeepInfraApiRunner } from './deepInfraApi.js'
import { OpenRouterApiRunner } from './openRouterApi.js'

const originalFetch = globalThis.fetch

function responseBody(content = 'ok'): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 })
}

async function capturedBody(run: () => Promise<unknown>): Promise<Record<string, unknown>> {
  let body: Record<string, unknown> = {}
  globalThis.fetch = (async (_input, init) => {
    body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    return responseBody()
  }) as typeof fetch
  await run()
  return body
}

test.afterEach(() => {
  globalThis.fetch = originalFetch
})

test('OpenRouter omits max_tokens when no explicit budget exists', async () => {
  const body = await capturedBody(() => new OpenRouterApiRunner(
    'example/fixed-model',
    {},
    { env: { OPENROUTER_API_KEY: 'synthetic-key', BABEL_DEEPINFRA_TOKENS: '32000' } },
  ).executeRaw('hello'))
  assert.equal(Object.hasOwn(body, 'max_tokens'), false)
})

test('OpenRouter sends the explicit sampling budget exactly', async () => {
  const body = await capturedBody(() => new OpenRouterApiRunner(
    'example/fixed-model',
    { maxTokens: 321 },
    { env: { OPENROUTER_API_KEY: 'synthetic-key' } },
  ).executeRaw('hello'))
  assert.equal(body.max_tokens, 321)
})

test('OpenRouter sends its provider-scoped environment budget exactly', async () => {
  const body = await capturedBody(() => new OpenRouterApiRunner(
    'example/fixed-model',
    {},
    { env: { OPENROUTER_API_KEY: 'synthetic-key', BABEL_OPENROUTER_TOKENS: '777' } },
  ).executeRaw('hello'))
  assert.equal(body.max_tokens, 777)
})

test('OpenRouter uses the execution-envelope output budget exactly', async () => {
  const envelope = {
    mode: 'chat',
    model: { requested: 'example/fixed-model', resolved: 'example/fixed-model' },
    provider: { gateway: 'openrouter' },
    output: { requested: 444, effective: 444 },
    reasoning: {},
    sampling: {},
    tools: { effective: false },
    structuredOutput: { mode: 'none' },
    routing: { allowFallbacks: true, requireParameters: false, order: [] },
    configurationHash: 'synthetic-envelope-hash',
  } as any
  const body = await capturedBody(() => new OpenRouterApiRunner(
    'example/fixed-model',
    {},
    { env: { OPENROUTER_API_KEY: 'synthetic-key' }, executionEnvelope: envelope },
  ).executeRaw('hello'))
  assert.equal(body.max_tokens, 444)
})

test('DeepInfra retains its explicit compatibility default without leaking it to OpenRouter', async () => {
  const deepInfraBody = await capturedBody(() => new DeepInfraApiRunner(
    'deepseek-ai/DeepSeek-V3-0324',
    'DEEPINFRA_API_KEY',
    {},
    { env: { DEEPINFRA_API_KEY: 'synthetic-key' } },
  ).executeRaw('hello'))
  assert.equal(deepInfraBody.max_tokens, 32000)

  const openRouterBody = await capturedBody(() => new OpenRouterApiRunner(
    'example/fixed-model',
    {},
    { env: { OPENROUTER_API_KEY: 'synthetic-key', BABEL_DEEPINFRA_TOKENS: '32000' } },
  ).executeRaw('hello'))
  assert.equal(Object.hasOwn(openRouterBody, 'max_tokens'), false)
})

test('generic OpenAI-compatible transport has no implicit output budget', async () => {
  const body = await capturedBody(() => new OpenAICompatibleApiRunner(
    'example/fixed-model',
    'OPENAI_API_KEY',
    {},
    { env: { OPENAI_API_KEY: 'synthetic-key' } },
  ).executeRaw('hello'))
  assert.equal(Object.hasOwn(body, 'max_tokens'), false)
})

function chunkedSseResponse(payload: string, splitAt: number[]): Response {
  const bytes = new TextEncoder().encode(payload)
  const cuts = [0, ...splitAt.filter((value) => value > 0 && value < bytes.length), bytes.length]
  let index = 0
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= cuts.length - 1) {
        controller.close()
        return
      }
      controller.enqueue(bytes.slice(cuts[index], cuts[index + 1]))
      index += 1
    },
  }), { status: 200 })
}

test('ordinary SSE parsing carries fragmented lines and fragmented UTF-8 across reads', async () => {
  const payload = [
    'data: {"model":"example/fixed-model","choices":[{"delta":{"content":"hi🙂"}}]}\n',
    'data: [DONE]\n',
  ].join('')
  const bytes = new TextEncoder().encode(payload)
  const utf8Start = bytes.findIndex((value) => value === 0xf0)
  const utf8Split = utf8Start > 0 ? utf8Start + 1 : 1
  const splitAt = [1, 6, 18, utf8Split, bytes.length - 2]
  globalThis.fetch = (async () => chunkedSseResponse(payload, splitAt)) as typeof fetch

  const chunks: string[] = []
  const result = await new OpenRouterApiRunner(
    'example/fixed-model',
    {},
    { env: { OPENROUTER_API_KEY: 'synthetic-key' } },
  ).executeRaw('hello', { onChunk: (chunk) => { chunks.push(chunk) } })

  assert.equal(result, 'hi🙂')
  assert.deepEqual(chunks, ['hi🙂'])
})

test('partial streamed output followed by disconnect fails without replaying the request', async () => {
  let calls = 0
  globalThis.fetch = (async () => {
    calls += 1
    const encoder = new TextEncoder()
    const prefix = encoder.encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n')
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(prefix)
        controller.close()
      },
    }), { status: 200 })
  }) as typeof fetch
  const failures: any[] = []
  const chunks: string[] = []
  await assert.rejects(() => new OpenRouterApiRunner(
    'example/fixed-model',
    {},
    { env: { OPENROUTER_API_KEY: 'synthetic-key', BABEL_OPENROUTER_STREAM_MAX_RETRIES: '3' } },
  ).executeRaw('hello', {
    onChunk: (chunk) => { chunks.push(chunk) },
    onProviderFailure: (receipt) => failures.push(receipt),
  }))
  assert.equal(calls, 1)
  assert.deepEqual(chunks, ['partial'])
  assert.equal(failures.length, 1)
  assert.equal(failures[0].partial_model_output, true)
  assert.equal(failures[0].retryable, false)
})

test('HTTP 402 emits a non-retryable, attributed provider failure receipt', async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: { code: 'insufficient_credits' } }), {
    status: 402,
    headers: { 'x-openrouter-request-id': 'or_req_test' },
  })) as typeof fetch
  const failures: any[] = []
  await assert.rejects(() => new OpenRouterApiRunner(
    'example/fixed-model',
    {},
    { env: { OPENROUTER_API_KEY: 'synthetic-key', BABEL_OPENROUTER_REQUEST_MAX_RETRIES: '4' } },
  ).executeRaw('hello', { onProviderFailure: (receipt) => failures.push(receipt) }))
  assert.equal(failures.length, 1)
  assert.equal(failures[0].http_status, 402)
  assert.equal(failures[0].normalized_failure_class, 'HTTP_402')
  assert.equal(failures[0].retryable, false)
  assert.equal(failures[0].retry_attempt, 1)
  assert.equal(failures[0].api_error_code, 'insufficient_credits')
  assert.equal(failures[0].openrouter_request_id, 'or_req_test')
})

test('invalid JSON API responses emit normalization failure evidence', async () => {
  globalThis.fetch = (async () => new Response('not json', { status: 200 })) as typeof fetch
  const failures: any[] = []
  await assert.rejects(() => new OpenAICompatibleApiRunner(
    'example/fixed-model',
    'OPENAI_API_KEY',
    {},
    { env: { OPENAI_API_KEY: 'synthetic-key' } },
  ).executeRaw('hello', { onProviderFailure: (receipt) => failures.push(receipt) }))
  assert.equal(failures.length, 1)
  assert.equal(failures[0].normalized_failure_class, 'MALFORMED_RESPONSE')
  assert.equal(failures[0].failure_stage, 'normalization')
})

test('exhausted HTTP 429 and HTTP 500 receipts are not retryable', async () => {
  for (const status of [429, 500]) {
    let calls = 0
    globalThis.fetch = (async () => {
      calls += 1
      return new Response('temporary failure', { status })
    }) as typeof fetch
    const failures: any[] = []
    await assert.rejects(() => new OpenRouterApiRunner(
      'example/fixed-model',
      {},
      { env: { OPENROUTER_API_KEY: 'synthetic-key', BABEL_OPENROUTER_REQUEST_MAX_RETRIES: '2' } },
    ).executeRaw('hello', { onProviderFailure: (receipt) => failures.push(receipt) }))
    assert.equal(calls, 2)
    assert.equal(failures.length, 1)
    assert.equal(failures[0].normalized_failure_class, status === 429 ? 'HTTP_429' : 'HTTP_5XX')
    assert.equal(failures[0].retryable, false)
    assert.equal(failures[0].retry_attempt, 2)
    assert.equal(failures[0].maximum_attempts, 2)
  }
})
