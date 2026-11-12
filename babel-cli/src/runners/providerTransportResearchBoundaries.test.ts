/**
 * Mocked transport probes for the six coordinator-supplied boundary definitions.
 * Labels refer to the numbered descriptions in the review handoff, not private A-T0x IDs.
 */

import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { DeepInfraApiRunner } from './deepInfraApi.js'
import {
  getRequestMaxRetries,
  REQUEST_MAX_RETRIES,
} from './providerResponsePolicy.js'
import type { ProviderInvocationCompleted, ProviderMessage, ToolStreamEvent } from './base.js'

const originalFetch = globalThis.fetch
const originalEnv = {
  deepinfraKey: process.env['DEEPINFRA_API_KEY'],
  retries: process.env['BABEL_PROVIDER_REQUEST_MAX_RETRIES'],
  providerRetries: process.env['BABEL_PROVIDER_REQUEST_MAX_RETRIES'],
  idle: process.env['BABEL_PROVIDER_STREAM_IDLE_TIMEOUT_MS'],
  timeout: process.env['BABEL_PROVIDER_REQUEST_TIMEOUT_MS'],
}

beforeEach(() => {
  process.env['DEEPINFRA_API_KEY'] = 'fixture-deepinfra-key'
  process.env['BABEL_PROVIDER_STREAM_IDLE_TIMEOUT_MS'] = '500'
  process.env['BABEL_PROVIDER_REQUEST_TIMEOUT_MS'] = '5000'
})

afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalEnv.deepinfraKey === undefined) delete process.env['DEEPINFRA_API_KEY']
  else process.env['DEEPINFRA_API_KEY'] = originalEnv.deepinfraKey
  if (originalEnv.retries === undefined) delete process.env['BABEL_PROVIDER_REQUEST_MAX_RETRIES']
  else process.env['BABEL_PROVIDER_REQUEST_MAX_RETRIES'] = originalEnv.retries
  if (originalEnv.providerRetries === undefined) delete process.env['BABEL_PROVIDER_REQUEST_MAX_RETRIES']
  else process.env['BABEL_PROVIDER_REQUEST_MAX_RETRIES'] = originalEnv.providerRetries
  if (originalEnv.idle === undefined) delete process.env['BABEL_PROVIDER_STREAM_IDLE_TIMEOUT_MS']
  else process.env['BABEL_PROVIDER_STREAM_IDLE_TIMEOUT_MS'] = originalEnv.idle
  if (originalEnv.timeout === undefined) delete process.env['BABEL_PROVIDER_REQUEST_TIMEOUT_MS']
  else process.env['BABEL_PROVIDER_REQUEST_TIMEOUT_MS'] = originalEnv.timeout
})

const USER: ProviderMessage[] = [{ role: 'user', content: 'probe' }]

function runner() {
  return new DeepInfraApiRunner('deepseek-ai/DeepSeek-V3-0324')
}

async function collectEvents(
  gen: AsyncGenerator<ToolStreamEvent, void, undefined>,
  completed: ProviderInvocationCompleted[] = [],
): Promise<{ events: ToolStreamEvent[]; thrown: unknown }> {
  const events: ToolStreamEvent[] = []
  let thrown: unknown
  try {
    for await (const event of gen) events.push(event)
  } catch (error) {
    thrown = error
  }
  return { events, thrown }
}

describe('transport research boundary probes (mocked)', { concurrency: 1 }, () => {
  it('probe 1: partial text then provider stream error yields failed receipt (not delivered)', async () => {
    globalThis.fetch = async () => new Response(
      [
        'data: {"choices":[{"delta":{"content":"partial"}}]}',
        'data: {"error":{"message":"upstream overloaded"}}',
        'data: [DONE]',
      ].join('\n') + '\n',
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    )
    const completed: ProviderInvocationCompleted[] = []
    const { events, thrown } = await collectEvents(
      runner().executeWithToolsStream(USER, [], undefined, undefined, 'auto', {
        onInvocationCompleted: (value) => { completed.push(value) },
      }),
      completed,
    )
    assert.equal(thrown, undefined, 'terminal fault is yielded, not thrown')
    assert.deepEqual(events.map((event) => event.type), ['text_delta', 'error'])
    assert.equal(completed.length, 1)
    assert.equal(completed[0]?.status, 'failed')
    assert.equal(completed[0]?.partial_model_output, true)
    assert.equal(completed.some((entry) => entry.status === 'delivered'), false)
  })

  it('probe 1b: truncated stream without [DONE] stays failed with partial provenance', async () => {
    globalThis.fetch = async () => new Response(
      'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    )
    const completed: ProviderInvocationCompleted[] = []
    const { events, thrown } = await collectEvents(
      runner().executeWithToolsStream(USER, [], undefined, undefined, 'auto', {
        onInvocationCompleted: (value) => { completed.push(value) },
      }),
      completed,
    )
    assert.equal(thrown, undefined)
    assert.deepEqual(events.map((event) => event.type), ['text_delta', 'error'])
    assert.equal(completed.length, 1)
    assert.equal(completed[0]?.status, 'failed')
    assert.equal(completed[0]?.partial_model_output, true)
  })

  it('probe 2: complete tool call + [DONE] releases reader while HTTP body stays open', async () => {
    const payload = JSON.stringify({
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            id: 'call_1',
            type: 'function',
            function: { name: 'read_file', arguments: '{}' },
          }],
        },
        finish_reason: 'tool_calls',
      }],
    })
    let bodyCancelled = false
    let pullGate: () => void
    const pullBlocked = new Promise<void>((resolve) => { pullGate = resolve })
    globalThis.fetch = async () => new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`data:${payload}\n\ndata: [DONE]\n\n`))
        },
        async pull() {
          await pullBlocked
        },
        cancel() {
          bodyCancelled = true
          pullGate()
        },
      }),
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    )
    const events: ToolStreamEvent[] = []
    for await (const event of runner().executeWithToolsStream(USER, [])) events.push(event)
    assert.equal(bodyCancelled, true, 'must cancel reader at [DONE], not wait for body EOF')
    assert.deepEqual(events.map((event) => event.type), ['tool_use', 'done'])
  })

  it('probe 3: legal SSE data:{JSON} without optional space parses deltas', async () => {
    const payload = JSON.stringify({ choices: [{ delta: { content: 'nospace' }, finish_reason: 'stop' }] })
    globalThis.fetch = async () => new Response(
      `data:${payload}\n\ndata: [DONE]\n\n`,
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    )
    const events: ToolStreamEvent[] = []
    for await (const event of runner().executeWithToolsStream(USER, [])) events.push(event)
    assert.deepEqual(events.map((event) => event.type), ['text_delta', 'done'])
    const delta = events[0]
    assert.equal(delta?.type, 'text_delta')
    if (delta?.type === 'text_delta') assert.equal(delta.text, 'nospace')
  })

  it('probe 4: cancellation during HTTP 429 retry backoff emits exactly one terminal receipt', async () => {
    process.env['BABEL_PROVIDER_REQUEST_MAX_RETRIES'] = '3'
    let calls = 0
    const abort = new AbortController()
    globalThis.fetch = async () => {
      calls += 1
      return new Response('rate limited', {
        status: 429,
        headers: { 'retry-after': '30' },
      })
    }
    const completed: ProviderInvocationCompleted[] = []
    const { events } = await collectEvents(
      runner().executeWithToolsStream(USER, [], undefined, abort.signal, 'auto', {
        onRetry: () => { abort.abort() },
        onInvocationCompleted: (value) => { completed.push(value) },
      }),
      completed,
    )
    assert.equal(calls, 1)
    assert.deepEqual(events.map((event) => event.type), ['error'])
    assert.equal(completed.length, 1)
    assert.equal(completed[0]?.status, 'failed')
    assert.match(completed[0]?.failure_receipt?.failure_stage ?? '', /request/)
  })

  it('probe 5: after response headers arrive, caller abort governs body read', async () => {
    const abort = new AbortController()
    let bodyCancelled = false
    globalThis.fetch = async () => new Response(
      new ReadableStream({
        start() { /* headers only; body stalls until cancelled */ },
        cancel() { bodyCancelled = true },
      }),
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    )
    const completed: ProviderInvocationCompleted[] = []
    const pending = collectEvents(
      runner().executeWithToolsStream(USER, [], undefined, abort.signal, 'auto', {
        onInvocationCompleted: (value) => { completed.push(value) },
      }),
      completed,
    )
    setTimeout(() => abort.abort(), 25)
    const { events, thrown } = await pending
    assert.equal(thrown, undefined)
    assert.equal(bodyCancelled, true)
    assert.equal(events.some((event) => event.type === 'error'), true)
    assert.equal(completed.length, 1)
    assert.equal(completed[0]?.status, 'failed')
  })

  it('probe 6: absent retry configuration keeps declared default (empty string is not zero)', () => {
    delete process.env['BABEL_PROVIDER_REQUEST_MAX_RETRIES']
    delete process.env['BABEL_DEEPINFRA_REQUEST_MAX_RETRIES']
    assert.equal(getRequestMaxRetries(), REQUEST_MAX_RETRIES)
    process.env['BABEL_PROVIDER_REQUEST_MAX_RETRIES'] = ''
    assert.equal(getRequestMaxRetries(), REQUEST_MAX_RETRIES)
    process.env['BABEL_PROVIDER_REQUEST_MAX_RETRIES'] = '2'
    assert.equal(getRequestMaxRetries(), 2)
  })
})
