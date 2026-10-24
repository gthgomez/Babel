/**
 * Command Code Anthropic Messages transport tests.
 *
 * Mock-transport only: proves claude-haiku-5-5 goes to /messages (never
 * /chat/completions) with Command Code authentication, that tool pairs and
 * system context survive mapping without flattening, and that block-stream
 * parsing, fragmented tool JSON, usage merging, cancellation, and malformed
 * streams have explicit outcomes.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { z } from 'zod'
import {
  AnthropicMessagesRunner,
  extractJson,
  mapProviderMessagesToAnthropic,
  normalizeAnthropicStopReason,
} from './anthropicMessages.js'
import { COMMANDCODE_API_BASE } from './commandCodeApi.js'
import type { ToolStreamEvent } from './base.js'

const originalFetch = globalThis.fetch
const AUTH_ENV = { ['CMD_API_KEY']: 'synthetic-commandcode-key' }

test.afterEach(() => {
  globalThis.fetch = originalFetch
})

interface Observed {
  url: string
  authorization: string
  apiKeyHeader: string | null
  version: string | null
  body: Record<string, unknown>
}

function observe(handler: (observed: Observed) => Response | Promise<Response>): { requests: Observed[] } {
  const requests: Observed[] = []
  globalThis.fetch = (async (input, init) => {
    const headers = (init?.headers as Record<string, string>) ?? {}
    const observed: Observed = {
      url: String(input),
      authorization: headers['Authorization'] ?? '',
      apiKeyHeader: headers['x-api-key'] ?? null,
      version: headers['anthropic-version'] ?? null,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {},
    }
    requests.push(observed)
    return handler(observed)
  }) as typeof fetch
  return { requests }
}

function sse(lines: Array<Record<string, unknown>>): Response {
  const body = lines.map((event) => `event: ${String(event['type'])}\ndata: ${JSON.stringify(event)}`).join('\n\n') + '\n\n'
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
}

function haikuStream(lines: Array<Record<string, unknown>>): { requests: Observed[] } {
  return observe(() => sse(lines))
}

test('claude-haiku-5-5 goes to /messages with the Command Code credential, never /chat/completions', async () => {
  const { requests } = haikuStream([
    { type: 'message_start', message: { model: 'claude-haiku-5-5', usage: { input_tokens: 42 } } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } },
    { type: 'message_stop' },
  ])
  const runner = new AnthropicMessagesRunner('claude-haiku-5-5', { env: { ...AUTH_ENV } })
  const events: ToolStreamEvent[] = []
  for await (const event of runner.executeWithToolsStream([{ role: 'user', content: 'greet' }], [])) {
    events.push(event)
  }
  assert.equal(requests.length, 1)
  assert.equal(requests[0]!.url, `${COMMANDCODE_API_BASE}/messages`)
  assert.equal(requests[0]!.url.includes('chat/completions'), false)
  assert.equal(requests[0]!.authorization, 'Bearer synthetic-commandcode-key')
  assert.equal(requests[0]!.version, '2023-06-01')
  assert.equal(requests[0]!.body.model, 'claude-haiku-5-5')
  const texts = events.filter((event): event is Extract<ToolStreamEvent, { type: 'text_delta' }> => event.type === 'text_delta')
  assert.deepEqual(texts.map((event) => event.text), ['Hi'])
  const metadata = runner.getLastInvocationMetadata()
  assert.equal(metadata?.provider, 'commandcode')
  assert.equal(metadata?.prompt_tokens, 42)
  assert.equal(metadata?.completion_tokens, 7)
  assert.equal(metadata?.total_tokens, 49)
  assert.equal(metadata?.normalized_finish_reason, 'NATURAL_COMPLETION')
})

test('tool pairs, system context, and call identities map without flattening', () => {
  const { system, messages } = mapProviderMessagesToAnthropic([
    { role: 'system', content: 'System context line' },
    { role: 'user', content: 'read the file' },
    { role: 'assistant', content: 'Using a tool', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }] },
    { role: 'tool', content: 'file contents', tool_call_id: 'call_1' },
  ], 'Override system prompt')
  assert.equal(system, 'Override system prompt')
  assert.equal(messages.length, 3)
  const assistant = messages[1]!
  assert.equal(assistant.role, 'assistant')
  assert.equal(assistant.content.length, 2)
  assert.deepEqual(assistant.content[0], { type: 'text', text: 'Using a tool' })
  assert.deepEqual(assistant.content[1], { type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'a.ts' } })
  const toolResult = messages[2]!
  assert.equal(toolResult.role, 'user')
  assert.deepEqual(toolResult.content, [{ type: 'tool_result', tool_use_id: 'call_1', content: 'file contents' }])
  // No prose flattening: roles and block types are preserved on the wire.
})

test('fragmented tool JSON reassembles into exactly one proposal per call', async () => {
  const { requests } = haikuStream([
    { type: 'message_start', message: { model: 'claude-haiku-5-5', usage: { input_tokens: 10 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Reading' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: {} } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":"sr' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 'c/a.ts"}' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_2', name: 'list_dir', input: {} } },
    { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"path":"src"}' } },
    { type: 'content_block_stop', index: 2 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 30 } },
    { type: 'message_stop' },
  ])
  const runner = new AnthropicMessagesRunner('claude-haiku-5-5', { env: { ...AUTH_ENV } })
  const events: ToolStreamEvent[] = []
  for await (const event of runner.executeWithToolsStream(
    [{ role: 'user', content: 'work' }],
    [{ type: 'function', function: { name: 'read_file', description: 'read', parameters: { type: 'object' } } }],
  )) {
    events.push(event)
  }
  const proposals = events.filter((event): event is Extract<ToolStreamEvent, { type: 'tool_use' }> => event.type === 'tool_use')
  assert.equal(proposals.length, 2)
  assert.deepEqual(proposals.map((proposal) => proposal.id), ['toolu_1', 'toolu_2'])
  assert.deepEqual(proposals[0]!.input, { path: 'src/a.ts' })
  // Wire body carried the native tool definition, not prose instructions.
  assert.deepEqual((requests[0]!.body.tools as unknown[])[0], {
    name: 'read_file', description: 'read', input_schema: { type: 'object' },
  })
  const metadata = runner.getLastInvocationMetadata()
  assert.equal(metadata?.normalized_finish_reason, 'TOOL_CALL')
  assert.equal(metadata?.completion_tokens, 30)
})

test('output truncation maps to the length finish reason', async () => {
  haikuStream([
    { type: 'message_start', message: { model: 'claude-haiku-5-5', usage: { input_tokens: 5 } } },
    { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 4096 } },
    { type: 'message_stop' },
  ])
  const runner = new AnthropicMessagesRunner('claude-haiku-5-5', { env: { ...AUTH_ENV } })
  for await (const _event of runner.executeWithToolsStream([{ role: 'user', content: 'long' }], [])) { /* drain */ }
  assert.equal(runner.getLastInvocationMetadata()?.normalized_finish_reason, 'OUTPUT_BUDGET_EXHAUSTED')
})

test('cancellation during the stream surfaces a typed error without a second attempt', async () => {
  const requests: Observed[] = []
  const encoder = new TextEncoder()
  globalThis.fetch = (async (input, init) => {
    const headers = (init?.headers as Record<string, string>) ?? {}
    requests.push({ url: String(input), authorization: headers['Authorization'] ?? '', apiKeyHeader: null, version: null, body: {} })
    const signal = init?.signal
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const chunk = encoder.encode(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'slow' } })}\n\n`)
        const timer = setInterval(() => {
          try { controller.enqueue(chunk) } catch { clearInterval(timer) }
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
  const runner = new AnthropicMessagesRunner('claude-haiku-5-5', { env: { ...AUTH_ENV } })
  const errors: string[] = []
  for await (const event of runner.executeWithToolsStream([{ role: 'user', content: 'hi' }], [], undefined, controller.signal)) {
    if (event.type === 'error') errors.push(event.message)
    controller.abort()
  }
  assert.equal(errors.length, 1)
  assert.equal(requests.length, 1)
})

test('malformed and error streams have explicit outcomes', async () => {
  // Malformed JSON lines are skipped, not fatal.
  globalThis.fetch = (async () => new Response('data: {not json\n\ndata: {"type":"message_start","message":{"model":"claude-haiku-5-5","usage":{"input_tokens":1}}}\n\ndata: {"type":"message_stop"}\n\n', { headers: { 'content-type': 'text/event-stream' } })) as typeof fetch
  const resilient = new AnthropicMessagesRunner('claude-haiku-5-5', { env: { ...AUTH_ENV } })
  const events: ToolStreamEvent[] = []
  for await (const event of resilient.executeWithToolsStream([{ role: 'user', content: 'x' }], [])) events.push(event)
  assert.equal(events.some((event) => event.type === 'done'), true)

  // In-stream error events surface as typed errors.
  observe(() => sse([
    { type: 'error', error: { message: 'overloaded' } },
  ]))
  const failing = new AnthropicMessagesRunner('claude-haiku-5-5', { env: { ...AUTH_ENV } })
  const streamErrors: string[] = []
  for await (const event of failing.executeWithToolsStream([{ role: 'user', content: 'x' }], [])) {
    if (event.type === 'error') streamErrors.push(event.message)
  }
  assert.equal(streamErrors.length, 1)
  assert.match(streamErrors[0]!, /overloaded/)

  // HTTP errors are distinct typed failures; 401 does not retry.
  let attempts = 0
  globalThis.fetch = (async () => {
    attempts += 1
    return new Response(JSON.stringify({ error: { message: 'invalid api key' } }), { status: 401 })
  }) as typeof fetch
  await assert.rejects(
    () => new AnthropicMessagesRunner('claude-haiku-5-5', { env: { ...AUTH_ENV } }).execute('x', z.object({ ok: z.literal(true) })),
    /HTTP 401/,
  )
  assert.equal(attempts, 1)
})

test('unsupported content and missing tool pairing fail explicitly', () => {
  assert.throws(
    () => mapProviderMessagesToAnthropic([{ role: 'tool', content: 'orphan result' }]),
    /missing its tool_call_id/,
  )
  assert.throws(() => extractJson('no structured output here'), /no JSON object/)
})

test('multiple interleaved text and tool blocks preserve order once each', async () => {
  haikuStream([
    { type: 'message_start', message: { model: 'claude-haiku-5-5', usage: { input_tokens: 3 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'a', input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"x":1}' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'mid-text' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 't2', name: 'b', input: {} } },
    { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"y":2}' } },
    { type: 'content_block_stop', index: 2 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } },
    { type: 'message_stop' },
  ])
  const runner = new AnthropicMessagesRunner('claude-haiku-5-5', { env: { ...AUTH_ENV } })
  const sequence: string[] = []
  for await (const event of runner.executeWithToolsStream([{ role: 'user', content: 'work' }], [])) {
    if (event.type === 'tool_use') sequence.push(`tool:${event.id}:${JSON.stringify(event.input)}`)
    if (event.type === 'text_delta') sequence.push(`text:${event.text}`)
  }
  assert.deepEqual(sequence, ['tool:t1:{"x":1}', 'text:mid-text', 'tool:t2:{"y":2}'])
})

test('stop reason normalization is total', () => {
  assert.equal(normalizeAnthropicStopReason('end_turn'), 'stop')
  assert.equal(normalizeAnthropicStopReason('stop_sequence'), 'stop')
  assert.equal(normalizeAnthropicStopReason('max_tokens'), 'length')
  assert.equal(normalizeAnthropicStopReason('tool_use'), 'tool_calls')
  assert.equal(normalizeAnthropicStopReason('refusal'), 'content_filter')
  assert.equal(normalizeAnthropicStopReason(null), null)
})
