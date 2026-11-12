/**
 * Offline transport conformance for OpenAiCompatible inheritors (OpenRouter, Command Code).
 *
 * The provider fault table exercises DeepInfra/DeepSeek directly; this suite pins the same
 * streaming/tool/cancel invariants on routed chat providers that inherit the shared transport.
 *
 * Pass-after controls on main@65a1c692; fail-before for identity-before-tool delivery is
 * documented by providerRouteSafety.test.ts + commit 83eda681 (pre-validation yielded tool_use).
 */

import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { OpenRouterApiRunner } from './openRouterApi.js'
import { CommandCodeApiRunner } from './commandCodeApi.js'
import type { ProviderInvocationCompleted, ProviderMessage, ToolStreamEvent } from './base.js'

const originalFetch = globalThis.fetch
const originalOpenRouterKey = process.env['OPENROUTER_API_KEY']
const originalCommandCodeKey = process.env['COMMAND_CODE_API_KEY']
const originalIdle = process.env['BABEL_PROVIDER_STREAM_IDLE_TIMEOUT_MS']
const originalRequestRetries = process.env['BABEL_PROVIDER_REQUEST_MAX_RETRIES']

beforeEach(() => {
  process.env['OPENROUTER_API_KEY'] = 'test-openrouter-key'
  process.env['COMMAND_CODE_API_KEY'] = 'test-command-code-key'
  process.env['BABEL_PROVIDER_STREAM_IDLE_TIMEOUT_MS'] = '2000'
  process.env['BABEL_PROVIDER_REQUEST_MAX_RETRIES'] = '4'
})

afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalOpenRouterKey === undefined) delete process.env['OPENROUTER_API_KEY']
  else process.env['OPENROUTER_API_KEY'] = originalOpenRouterKey
  if (originalCommandCodeKey === undefined) delete process.env['COMMAND_CODE_API_KEY']
  else process.env['COMMAND_CODE_API_KEY'] = originalCommandCodeKey
  if (originalIdle === undefined) delete process.env['BABEL_PROVIDER_STREAM_IDLE_TIMEOUT_MS']
  else process.env['BABEL_PROVIDER_STREAM_IDLE_TIMEOUT_MS'] = originalIdle
  if (originalRequestRetries === undefined) delete process.env['BABEL_PROVIDER_REQUEST_MAX_RETRIES']
  else process.env['BABEL_PROVIDER_REQUEST_MAX_RETRIES'] = originalRequestRetries
})

const USER: ProviderMessage[] = [{ role: 'user', content: 'status' }]

function makeSseResponse(sseLines: string[]): Response {
  return new Response(`${sseLines.join('\n')}\n`, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

function hangingAfter(sseLines: string[]): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`${sseLines.join('\n')}\n`))
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  )
}

async function collect(
  gen: AsyncGenerator<ToolStreamEvent, void, undefined>,
  completed: ProviderInvocationCompleted[] = [],
): Promise<ToolStreamEvent[]> {
  const events: ToolStreamEvent[] = []
  try {
    for await (const event of gen) events.push(event)
  } catch (err) {
    events.push({
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
    })
  }
  assert.equal(completed.length, 1, 'transport must finalize invocation exactly once')
  return events
}

type AdapterCase = {
  label: string
  model: string
  runner: () => { executeWithToolsStream: OpenRouterApiRunner['executeWithToolsStream'] }
}

const ADAPTERS: AdapterCase[] = [
  {
    label: 'openrouter',
    model: 'deepseek/deepseek-v4.1-flash',
    runner: () => new OpenRouterApiRunner(
      'deepseek/deepseek-v4.1-flash',
      { maxTokens: 128 },
      { env: process.env, explicitCredential: 'fixture-only' },
    ),
  },
  {
    label: 'command-code',
    model: 'deepseek/deepseek-v4.1-flash',
    runner: () => new CommandCodeApiRunner(
      'deepseek/deepseek-v4.1-flash',
      { maxTokens: 128 },
      { env: process.env, explicitCredential: 'fixture-only' },
    ),
  },
]

function withModel(model: string, chunk: Record<string, unknown>): string {
  return `data: ${JSON.stringify({ model, ...chunk })}\n`
}

for (const adapter of ADAPTERS) {
  describe(`${adapter.label} inherited transport conformance`, { concurrency: 1 }, () => {
    it('HTTP transport throw then successful SSE preserves observed model and usage metadata', async () => {
      const { model } = adapter
      let physicalAttempts = 0
      globalThis.fetch = async () => {
        physicalAttempts += 1
        if (physicalAttempts === 1) throw new TypeError('fetch failed')
        return makeSseResponse([
          withModel(model, {
            choices: [{ delta: { content: 'routed-ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 31, completion_tokens: 7, total_tokens: 38 },
          }),
          'data: [DONE]',
        ])
      }
      const runner = adapter.runner() as OpenRouterApiRunner | CommandCodeApiRunner
      const completed: ProviderInvocationCompleted[] = []
      const events = await collect(
        runner.executeWithToolsStream(USER, [], undefined, undefined, 'auto', {
          onInvocationCompleted: (value) => { completed.push(value) },
        }),
        completed,
      )
      assert.equal(physicalAttempts, 2)
      assert.deepEqual(events.map((event) => event.type), ['text_delta', 'done'])
      const metadata = runner.getLastInvocationMetadata()
      assert.equal(metadata?.observed_model_id, model)
      assert.equal(metadata?.prompt_tokens, 31)
      assert.equal(metadata?.completion_tokens, 7)
      assert.equal(metadata?.provider, adapter.label === 'openrouter' ? 'openrouter' : 'command-code')
      assert.equal(completed[0]?.status, 'delivered')
    })

    it('split tool-call arguments reconstruct to one tool_use', async () => {
      const { model } = adapter
      globalThis.fetch = async () => makeSseResponse([
        withModel(model, { choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_read_1', type: 'function', function: { name: 'read_file', arguments: '' } }] } }] }),
        withModel(model, { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":"src/main.ts"}' } }] } }] }),
        withModel(model, { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
        'data: [DONE]',
      ])
      const completed: ProviderInvocationCompleted[] = []
      const events = await collect(
        adapter.runner().executeWithToolsStream(USER, [], undefined, undefined, 'auto', {
          onInvocationCompleted: (value) => { completed.push(value) },
        }),
        completed,
      )
      assert.deepEqual(events.map((event) => event.type), ['tool_use', 'done'])
      const tool = events[0]
      assert.equal(tool?.type, 'tool_use')
      if (tool?.type === 'tool_use') {
        assert.deepEqual(tool.input, { path: 'src/main.ts' })
      }
      assert.equal(completed[0]?.status, 'delivered')
    })

    it('partial tool batch yields typed error without tool_use', async () => {
      const { model } = adapter
      globalThis.fetch = async () => makeSseResponse([
        withModel(model, { choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_trunc', type: 'function', function: { name: 'read_file', arguments: '' } }] } }] }),
        withModel(model, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
        'data: [DONE]',
      ])
      const completed: ProviderInvocationCompleted[] = []
      const events = await collect(
        adapter.runner().executeWithToolsStream(USER, [], undefined, undefined, 'auto', {
          onInvocationCompleted: (value) => { completed.push(value) },
        }),
        completed,
      )
      assert.equal(events.some((event) => event.type === 'tool_use'), false)
      const err = events.find((event) => event.type === 'error')
      assert.ok(err?.type === 'error')
      if (err?.type === 'error') assert.match(err.message, /incomplete tool call/i)
      assert.equal(completed[0]?.status, 'failed')
    })

    it('malformed tool arguments yield error once without tool_use', async () => {
      const { model } = adapter
      globalThis.fetch = async () => makeSseResponse([
        withModel(model, { choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_bad_json', type: 'function', function: { name: 'str_replace', arguments: '{invalid_json:' } }] } }] }),
        withModel(model, { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
        'data: [DONE]',
      ])
      const completed: ProviderInvocationCompleted[] = []
      const events = await collect(
        adapter.runner().executeWithToolsStream(USER, [], undefined, undefined, 'auto', {
          onInvocationCompleted: (value) => { completed.push(value) },
        }),
        completed,
      )
      assert.equal(events.filter((event) => event.type === 'tool_use').length, 0)
      const err = events.find((event) => event.type === 'error')
      assert.ok(err?.type === 'error')
      if (err?.type === 'error') assert.match(err.message, /malformed arguments/i)
      assert.equal(completed[0]?.status, 'failed')
    })

    it('held-open body after [DONE] releases the SSE reader', async () => {
      const { model } = adapter
      let bodyCancelled = false
      let pullGate: () => void
      const pullBlocked = new Promise<void>((resolve) => { pullGate = resolve })
      globalThis.fetch = async () => new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode([
              withModel(model, { choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] }),
              'data: [DONE]',
            ].join('\n') + '\n'))
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
      const completed: ProviderInvocationCompleted[] = []
      const events = await collect(
        adapter.runner().executeWithToolsStream(USER, [], undefined, undefined, 'auto', {
          onInvocationCompleted: (value) => { completed.push(value) },
        }),
        completed,
      )
      assert.equal(bodyCancelled, true)
      assert.deepEqual(events.map((event) => event.type), ['text_delta', 'done'])
      assert.equal(completed[0]?.status, 'delivered')
    })

    it('caller cancellation during streaming stays cancellation without tool delivery', async () => {
      const { model } = adapter
      const abort = new AbortController()
      let bodyCancelled = false
      globalThis.fetch = async () => new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(
              withModel(model, { choices: [{ index: 0, delta: { content: 'partial' } }] }),
            ))
          },
          cancel() { bodyCancelled = true },
        }),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      )
      const completed: ProviderInvocationCompleted[] = []
      const events: ToolStreamEvent[] = []
      for await (const event of adapter.runner().executeWithToolsStream(USER, [], undefined, abort.signal, 'auto', {
        onInvocationCompleted: (value) => { completed.push(value) },
      })) {
        events.push(event)
        if (event.type === 'text_delta') abort.abort()
      }
      assert.equal(bodyCancelled, true)
      assert.equal(events.some((event) => event.type === 'tool_use' || event.type === 'done'), false)
      const err = events.find((event) => event.type === 'error')
      assert.ok(err?.type === 'error')
      if (err?.type === 'error') assert.match(err.message, /cancelled/i)
      assert.equal(completed.length, 1)
      assert.equal(completed[0]?.status, 'failed')
    })

    it('idle stall after partial tool fragments does not replay or duplicate completions', async () => {
      const { model } = adapter
      process.env['BABEL_PROVIDER_STREAM_IDLE_TIMEOUT_MS'] = '50'
      let requests = 0
      globalThis.fetch = async () => {
        requests += 1
        return hangingAfter([
          withModel(model, { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":' } }] } }] }),
        ])
      }
      const completed: ProviderInvocationCompleted[] = []
      const events = await collect(
        adapter.runner().executeWithToolsStream(USER, [], undefined, undefined, 'auto', {
          onInvocationCompleted: (value) => { completed.push(value) },
        }),
        completed,
      )
      assert.equal(requests, 1)
      assert.deepEqual(events.map((event) => event.type), ['error'])
      assert.equal(completed[0]?.status, 'failed')
      assert.equal(completed[0]?.failure_receipt?.partial_model_output, true)
      assert.equal(completed[0]?.failure_receipt?.retryable, false)
      assert.equal(completed[0]?.failure_receipt?.tool_call_count, 1)
    })

    it('HTTP 429 retry backoff cancellation emits one terminal receipt', async () => {
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
      const events: ToolStreamEvent[] = []
      for await (const event of adapter.runner().executeWithToolsStream(USER, [], undefined, abort.signal, 'auto', {
        onRetry: () => { abort.abort() },
        onInvocationCompleted: (value) => { completed.push(value) },
      })) {
        events.push(event)
      }
      assert.equal(calls, 1)
      assert.deepEqual(events.map((event) => event.type), ['error'])
      assert.equal(completed.length, 1)
      assert.equal(completed[0]?.status, 'failed')
      assert.match(completed[0]?.failure_receipt?.failure_stage ?? '', /request/)
    })

    it('substituted model identity blocks tool delivery when exact route is required', async () => {
      const { model, label } = adapter
      const strictRunner: OpenRouterApiRunner | CommandCodeApiRunner = label === 'openrouter'
        ? new OpenRouterApiRunner(
          model,
          { maxTokens: 128 },
          { env: process.env, explicitCredential: 'fixture-only', requireExactModelId: true },
        )
        : new CommandCodeApiRunner(
          model,
          { maxTokens: 128 },
          { env: process.env, explicitCredential: 'fixture-only' },
        )
      globalThis.fetch = async () => makeSseResponse([
        withModel('other-provider/model', { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call-fixture', type: 'function', function: { name: 'read_file', arguments: '{"path":"fixture.txt"}' } }] }, finish_reason: 'tool_calls' }] }),
        'data: [DONE]',
      ])
      const completed: ProviderInvocationCompleted[] = []
      const events: ToolStreamEvent[] = []
      await assert.rejects(async () => {
        for await (const event of strictRunner.executeWithToolsStream(USER, [], undefined, undefined, 'auto', {
          onInvocationCompleted: (value) => { completed.push(value) },
        })) events.push(event)
      }, /model|identity/i)
      assert.equal(events.some((event) => event.type === 'tool_use' || event.type === 'done'), false)
      assert.equal(completed.length, 1)
      assert.equal(completed[0]?.status, 'failed')
      const usage = strictRunner.getLastInvocationMetadata()
      assert.equal(usage?.total_tokens ?? null, null)
      assert.equal(usage?.estimated_cost_usd ?? null, null)
    })
  })
}
