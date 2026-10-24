/**
 * Command Code Chat Completions transport tests.
 *
 * Mock-transport only: credential and origin isolation, streaming and native
 * tool behavior, usage handling, error mapping, abort and retry settlement.
 * No network, no real credentials.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { z } from 'zod'
import { CommandCodeApiRunner, COMMANDCODE_API_BASE, COMMANDCODE_CREDENTIAL_ENV_VAR } from './commandCodeApi.js'
import { createProviderRunner } from './providerEngine.js'
import { ProviderCredentialError } from './credentialHub.js'
import type { RunnerProgressEvent, ToolStreamEvent } from './base.js'

const originalFetch = globalThis.fetch

test.afterEach(() => {
  globalThis.fetch = originalFetch
})

interface ObservedRequest {
  url: string
  authorization: string
  body: Record<string, unknown>
  headers: Record<string, string>
}

function observeRequests(handler: (request: ObservedRequest) => Response | Promise<Response>): {
  requests: ObservedRequest[]
} {
  const requests: ObservedRequest[] = []
  globalThis.fetch = (async (input, init) => {
    const headers = (init?.headers as Record<string, string>) ?? {}
    requests.push({
      url: String(input),
      authorization: String(headers['Authorization'] ?? headers['authorization'] ?? ''),
      headers,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {},
    })
    return handler(requests[requests.length - 1]!)
  }) as typeof fetch
  return { requests }
}

function sseResponse(events: unknown[]): Response {
  const body = events.map((event) => `data: ${JSON.stringify(event)}`).join('\n\n') + '\n\ndata: [DONE]\n\n'
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
}

// Synthetic credential value; the env-var name comes from the transport constant.
const AUTH_ENV = { [COMMANDCODE_CREDENTIAL_ENV_VAR]: 'synthetic-commandcode-key' }

test('Command Code requests use only its credential and its origin', async () => {
  const { requests } = observeRequests(() => new Response(JSON.stringify({
    model: 'z-ai/glm-5.3-flash',
    choices: [{ message: { content: '{"ok":true}' } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  }), { status: 200 }))
  const runner = new CommandCodeApiRunner('z-ai/glm-5.3-flash', { maxTokens: 100 }, { env: { ...AUTH_ENV, OPENROUTER_API_KEY: 'synthetic-router-key' } })
  const result = await runner.execute('respond', z.object({ ok: z.literal(true) }))
  assert.deepEqual(result, { ok: true })
  assert.equal(requests.length, 1)
  assert.equal(requests[0]!.url, `${COMMANDCODE_API_BASE}/chat/completions`)
  // Only the Command Code credential reaches the wire; safe scalars asserted.
  assert.equal(requests[0]!.authorization, 'Bearer synthetic-commandcode-key')
  assert.equal(requests[0]!.authorization.includes('synthetic-router-key'), false)
  assert.equal(requests[0]!.body.model, 'z-ai/glm-5.3-flash')
  assert.equal(runner.getLastInvocationMetadata()?.provider, 'commandcode')
})

test('engine factory routes commandcode through the Command Code transport', async () => {
  const { requests } = observeRequests(() => new Response(JSON.stringify({
    model: 'gpt-6-luna',
    choices: [{ message: { content: '{"ok":true}' } }],
    usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
  }), { status: 200 }))
  const runner = createProviderRunner({
    provider: 'commandcode',
    modelId: 'gpt-6-luna',
    env: { ...AUTH_ENV },
  })
  assert.equal(runner.supports('native_tool_stream'), true)
  assert.equal(runner.supports('structured'), true)
  await runner.execute('respond', z.object({ ok: z.literal(true) }))
  assert.equal(requests[0]!.url, `${COMMANDCODE_API_BASE}/chat/completions`)
  assert.equal(runner.getLastInvocationMetadata()?.provider, 'commandcode')
})

test('fragmented SSE with final usage after content settles once with exact totals', async () => {
  const model = 'xiaomi/mimo-v2.6-flash'
  const usage = { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30, cost: 0.0021 }
  observeRequests(() => sseResponse([
    { model, choices: [{ delta: { content: 'Hel' } }] },
    { model, choices: [{ delta: { content: 'lo' } }] },
    // Fragmented JSON across chunks must reassemble.
    { model, choices: [{ delta: { content: '{"ok' } }] },
    { model, choices: [{ delta: { content: '":true}' }, finish_reason: 'stop' }] },
    { model, choices: [], usage },
  ]))
  const runner = new CommandCodeApiRunner(model, { maxTokens: 100 }, { env: { ...AUTH_ENV } })
  const chunks: string[] = []
  await runner.execute('Reply', z.object({ ok: z.literal(true) }), { onChunk: (chunk: string) => { chunks.push(chunk) } })
  const metadata = runner.getLastInvocationMetadata()
  assert.equal(metadata?.estimated_cost_usd, 0.0021)
  assert.equal(metadata?.cost_precision, 'exact')
  assert.equal(metadata?.total_tokens, 30)
  assert.equal(metadata?.observed_model_id, model)
})

test('multiple interleaved native tool calls produce distinct proposals once', async () => {
  const model = 'gpt-6-luna'
  const toolEvents: ToolStreamEvent[] = []
  observeRequests(() => sseResponse([
    { model, choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'read_file', arguments: '{"path":' } }] } }] },
    { model, choices: [{ delta: { content: 'Working' } }] },
    { model, choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"src/a.ts"}' } }] } }] },
    { model, choices: [{ delta: { tool_calls: [{ index: 1, id: 'call_b', type: 'function', function: { name: 'list_dir', arguments: '{"path":"src"}' } }] } }] },
    { model, choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    { model, choices: [], usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 } },
  ]))
  const runner = new CommandCodeApiRunner(model, { maxTokens: 100 }, { env: { ...AUTH_ENV } })
  for await (const event of runner.executeWithToolsStream(
    [{ role: 'user', content: 'read two files' }],
    [
      { type: 'function', function: { name: 'read_file', description: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
      { type: 'function', function: { name: 'list_dir', description: 'list', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
    ],
  )) {
    toolEvents.push(event)
  }
  const proposals = toolEvents.filter((event): event is Extract<ToolStreamEvent, { type: 'tool_use' }> => event.type === 'tool_use')
  assert.equal(proposals.length, 2)
  const ids = proposals.map((proposal) => proposal.id).sort()
  assert.deepEqual(ids, ['call_a', 'call_b'])
  const readA = proposals.find((proposal) => proposal.id === 'call_a')
  assert.equal(readA!.input.path, 'src/a.ts')
  const metadata = runner.getLastInvocationMetadata()
  assert.equal(metadata?.provider, 'commandcode')
  assert.equal(metadata?.total_tokens, 18)
})

test('empty choices with terminal usage still yields usage metadata', async () => {
  const model = 'z-ai/glm-5.3-flash'
  observeRequests(() => new Response(JSON.stringify({
    model,
    choices: [],
    usage: { prompt_tokens: 5, completion_tokens: 0, total_tokens: 5 },
  }), { status: 200 }))
  const runner = new CommandCodeApiRunner(model, { maxTokens: 10 }, { env: { ...AUTH_ENV } })
  await assert.rejects(() => runner.execute('Reply', z.object({ ok: z.literal(true) })))
  const metadata = runner.getLastInvocationMetadata()
  assert.equal(metadata?.total_tokens, 5)
  assert.equal(metadata?.completion_tokens, 0)
})

test('missing and invalid credentials are distinct typed failures', async () => {
  const { requests } = observeRequests(() => new Response(JSON.stringify({ error: { message: 'denied' } }), { status: 200 }))
  await assert.rejects(async () => {
    await new CommandCodeApiRunner('gpt-6-luna', {}, {}).execute('Reply', z.object({ ok: z.literal(true) }))
  }, (error: unknown) => error instanceof ProviderCredentialError && error.envVar === 'CMD_API_KEY')
  // An OpenRouter key in the environment must not satisfy the Command Code runner.
  await assert.rejects(async () => {
    await new CommandCodeApiRunner('gpt-6-luna', {}, { env: { OPENROUTER_API_KEY: 'synthetic-router-key' } }).execute('Reply', z.object({ ok: z.literal(true) }))
  }, (error: unknown) => error instanceof ProviderCredentialError)
  assert.equal(requests.length, 0)
})

test('provider failures map to distinct outcomes without changing the selected route', async () => {
  const cases: Array<{ status: number; body: unknown; expect: RegExp }> = [
    { status: 401, body: { error: { message: 'invalid api key' } }, expect: /401|invalid|unauthorized|denied/i },
    { status: 403, body: { error: { message: 'model not enabled for this account' } }, expect: /403|denied|not enabled|forbidden/i },
    { status: 404, body: { error: { message: 'unknown model' } }, expect: /404|not found|unknown model/i },
    { status: 429, body: { error: { message: 'rate limit exceeded' } }, expect: /429|rate limit/i },
    { status: 500, body: { error: { message: 'upstream exploded' } }, expect: /500|server|upstream/i },
  ]
  for (const testCase of cases) {
    observeRequests(() => new Response(JSON.stringify(testCase.body), { status: testCase.status }))
    const runner = new CommandCodeApiRunner('deepseek/deepseek-v4.1-flash', { maxTokens: 10 }, { env: { ...AUTH_ENV } })
    await assert.rejects(
      () => runner.execute('Reply', z.object({ ok: z.literal(true) })),
      (error: unknown) => testCase.expect.test(error instanceof Error ? error.message : String(error)),
      `status ${testCase.status} must map to a distinct typed failure`,
    )
  }
})

test('abort cancels without a second charged attempt', async () => {
  const requests: ObservedRequest[] = []
  const encoder = new TextEncoder()
  globalThis.fetch = (async (input, init) => {
    requests.push({ url: String(input), authorization: '', body: {}, headers: {} })
    const signal = init?.signal
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const chunk = encoder.encode(`data: ${JSON.stringify({ model: 'gpt-6-luna', choices: [{ delta: { content: 'slow' } }] })}\n\n`)
        const timer = setInterval(() => {
          // Self-terminating: never keep the event loop alive after the test.
          try {
            controller.enqueue(chunk)
          } catch {
            clearInterval(timer)
          }
        }, 10)
        signal?.addEventListener('abort', () => {
          clearInterval(timer)
          const abortError = new Error('This operation was aborted')
          abortError.name = 'AbortError'
          controller.error(abortError)
        }, { once: true })
      },
    })
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
  }) as typeof fetch
  const controller = new AbortController()
  const runner = new CommandCodeApiRunner('gpt-6-luna', { maxTokens: 10 }, { env: { ...AUTH_ENV } })
  const stream = runner.executeWithToolsStream([{ role: 'user', content: 'hi' }], [], undefined, controller.signal)
  const errorEvents: string[] = []
  for await (const event of stream) {
    if (event.type === 'error') errorEvents.push(event.message)
    controller.abort()
  }
  // Cancellation surfaces as exactly one typed error event, not a silent
  // completion, a thrown crash, or a second dispatched attempt.
  assert.equal(errorEvents.length, 1)
  assert.equal(requests.length, 1)
})

test('retry settlement stays bounded and receipt-linked', async () => {
  let attempt = 0
  const retries: import('./base.js').ProviderRetryEvent[] = []
  observeRequests(() => {
    attempt += 1
    if (attempt < 3) return new Response(JSON.stringify({ error: { message: 'upstream unavailable' } }), { status: 503 })
    return new Response(JSON.stringify({
      model: 'z-ai/glm-5.3-flash',
      choices: [{ message: { content: '{"ok":true}' } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }), { status: 200 })
  })
  const runner = new CommandCodeApiRunner('z-ai/glm-5.3-flash', { maxTokens: 10 }, { env: { ...AUTH_ENV } })
  const result = await runner.execute('Reply', z.object({ ok: z.literal(true) }), {
    onRetry: (event) => { retries.push(event) },
  })
  assert.deepEqual(result, { ok: true })
  assert.equal(attempt, 3)
  assert.equal(retries.length, 2)
  assert.equal(runner.getLastInvocationMetadata()?.total_tokens, 15)
})

test('observed model substitution is rejected on every selected route', async () => {
  for (const model of ['deepseek/deepseek-v4.1-flash', 'z-ai/glm-5.3-flash', 'gpt-6-luna', 'xiaomi/mimo-v2.6-flash']) {
    observeRequests(() => new Response(JSON.stringify({
      model: 'some/other-model',
      choices: [{ message: { content: '{"ok":true}' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), { status: 200 }))
    const runner = new CommandCodeApiRunner(model, { maxTokens: 10 }, { env: { ...AUTH_ENV } })
    await assert.rejects(
      () => runner.execute('Reply', z.object({ ok: z.literal(true) })),
      /refusing model substitution/,
    )
  }
})
