import assert from 'node:assert/strict'
import test from 'node:test'
import { GeminiApiRunner } from './geminiApi.js'
import { CompatibleApiRunner } from './compatibleApi.js'
import type { ToolStreamEvent } from './base.js'

const runner = () => new GeminiApiRunner({ explicitCredential: 'fixture-only', env: {}, modelId: 'fixture-model', maxTokens: 64 })
const frame = { modelVersion: 'observed-fixture', candidates: [{ content: { parts: [{ text: 'Hello 🌎' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2 } }

test('native SSE tolerates split UTF-8 and CRLF boundaries and retains exact model identity', async () => {
  const prior = globalThis.fetch
  try {
    const bytes = new TextEncoder().encode(`data: ${JSON.stringify(frame)}\r\n\r\n`)
    globalThis.fetch = async () => new Response(new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close() } }))
    const api = runner(); let text = ''
    for await (const chunk of api.executeRawStream('Hello')) text += chunk
    assert.equal(text, 'Hello 🌎'); assert.equal(api.getLastInvocationMetadata()?.observed_model_id, 'observed-fixture')
  } finally { globalThis.fetch = prior }
})

test('native cancellation aborts the body, finalizes once and delivers no tool calls', async () => {
  const prior = globalThis.fetch; const abort = new AbortController(); let cancelled = false; let completed = 0
  try {
    globalThis.fetch = async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'partial' }] } }] })}\n\n`)) },
      cancel() { cancelled = true },
    }))
    const events: ToolStreamEvent[] = []
    for await (const event of runner().executeWithToolsStream([{ role: 'user', content: 'Hello' }], [], undefined, abort.signal, 'auto', { onInvocationCompleted: () => { completed++ } })) {
      events.push(event); if (event.type === 'text_delta') abort.abort()
    }
    assert.equal(cancelled, true); assert.equal(completed, 1); assert.equal(events.some(event => event.type === 'tool_use'), false)
    assert.match(events.find(event => event.type === 'error')?.message ?? '', /cancelled/)
  } finally { globalThis.fetch = prior }
})

test('native authentication failures do not retry and raw output exhaustion fails honestly', async () => {
  const prior = globalThis.fetch; let requests = 0
  try {
    globalThis.fetch = async () => { requests++; return new Response('fixture rejection', { status: 401 }) }
    await assert.rejects(runner().executeRaw('Hello'), /HTTP 401/); assert.equal(requests, 1)
    globalThis.fetch = async () => new Response(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'partial' }] }, finishReason: 'MAX_TOKENS' }] })}\n\n`)
    await assert.rejects(async () => { for await (const _chunk of runner().executeRawStream('Hello')) { /* consume */ } }, /finish_reason: length/)
  } finally { globalThis.fetch = prior }
})

test('an explicitly unauthenticated compatible endpoint never receives an authorization header', async () => {
  const prior = globalThis.fetch
  try {
    globalThis.fetch = async (_input, init) => {
      assert.equal(new Headers(init?.headers).has('authorization'), false)
      assert.equal(init?.redirect, 'error')
      return new Response(JSON.stringify({ model: 'fixture-model', choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }))
    }
    const api = new CompatibleApiRunner('fixture-model', { env: {}, authentication: 'none', baseUrl: 'http://127.0.0.1:12345/v1', maxTokens: 64 })
    assert.equal(await api.executeRaw('Hello'), 'ok')
    assert.equal(api.getLastInvocationMetadata()?.estimated_cost_usd, null)
  } finally { globalThis.fetch = prior }
})


test('closing a native stream early produces a valid failure receipt', async () => {
  const prior = globalThis.fetch; let completed: import('./base.js').ProviderInvocationCompleted | undefined
  try {
    globalThis.fetch = async () => new Response(`data: ${JSON.stringify(frame)}\n\n`)
    for await (const event of runner().executeWithToolsStream([{ role: 'user', content: 'Hello' }], [], undefined, undefined, 'auto', { onInvocationCompleted: value => { completed = value } })) if (event.type === 'text_delta') break
    assert.equal(completed?.status, 'failed'); assert.ok(completed?.failure_receipt)
  } finally { globalThis.fetch = prior }
})


test('malformed native tool batches emit no partial tool proposals', async () => {
  const prior = globalThis.fetch
  try {
    globalThis.fetch = async () => new Response(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ functionCall: { id: 'duplicate', name: 'read_file', args: { path: 'first' } } }, { functionCall: { id: 'duplicate', name: 'read_file', args: { path: 'second' } } }] }, finishReason: 'STOP' }] })}\n\n`)
    const events: ToolStreamEvent[] = []
    for await (const event of runner().executeWithToolsStream([{ role: 'user', content: 'Hello' }], [])) events.push(event)
    assert.equal(events.filter(event => event.type === 'tool_use').length, 0)
    assert.match(events.find(event => event.type === 'error')?.message ?? '', /duplicate tool identity/)
  } finally { globalThis.fetch = prior }
})
