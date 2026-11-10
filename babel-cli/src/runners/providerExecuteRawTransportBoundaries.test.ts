/**
 * Mocked transport probes for executeRaw / executeRawStream (_executeRequest) paths.
 * Descriptive IDs only — no private A-T label mapping.
 */

import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { DeepInfraApiRunner } from './deepInfraApi.js'
import { OpenRouterApiRunner } from './openRouterApi.js'
import { CommandCodeApiRunner } from './commandCodeApi.js'
import {
  DEFAULT_STREAM_MAX_RETRIES,
  getStreamMaxRetries,
} from './providerResponseStream.js'
import type { OpenAiCompatibleRunner } from './protocol/openai-chat-completions.js'

const originalFetch = globalThis.fetch
const originalEnv = {
  deepinfraKey: process.env['DEEPINFRA_API_KEY'],
  openrouterKey: process.env['OPENROUTER_API_KEY'],
  commandCodeKey: process.env['COMMAND_CODE_API_KEY'],
  streamRetries: process.env['BABEL_PROVIDER_STREAM_MAX_RETRIES'],
  deepinfraStreamRetries: process.env['BABEL_DEEPINFRA_STREAM_MAX_RETRIES'],
  idle: process.env['BABEL_PROVIDER_STREAM_IDLE_TIMEOUT_MS'],
  timeout: process.env['BABEL_PROVIDER_REQUEST_TIMEOUT_MS'],
}

beforeEach(() => {
  process.env['DEEPINFRA_API_KEY'] = 'fixture-deepinfra-key'
  process.env['OPENROUTER_API_KEY'] = 'fixture-openrouter-key'
  process.env['COMMAND_CODE_API_KEY'] = 'fixture-command-code-key'
  process.env['BABEL_PROVIDER_STREAM_IDLE_TIMEOUT_MS'] = '200'
  process.env['BABEL_PROVIDER_REQUEST_TIMEOUT_MS'] = '1000'
})

afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalEnv.deepinfraKey === undefined) delete process.env['DEEPINFRA_API_KEY']
  else process.env['DEEPINFRA_API_KEY'] = originalEnv.deepinfraKey
  if (originalEnv.openrouterKey === undefined) delete process.env['OPENROUTER_API_KEY']
  else process.env['OPENROUTER_API_KEY'] = originalEnv.openrouterKey
  if (originalEnv.commandCodeKey === undefined) delete process.env['COMMAND_CODE_API_KEY']
  else process.env['COMMAND_CODE_API_KEY'] = originalEnv.commandCodeKey
  if (originalEnv.streamRetries === undefined) delete process.env['BABEL_PROVIDER_STREAM_MAX_RETRIES']
  else process.env['BABEL_PROVIDER_STREAM_MAX_RETRIES'] = originalEnv.streamRetries
  if (originalEnv.deepinfraStreamRetries === undefined) delete process.env['BABEL_DEEPINFRA_STREAM_MAX_RETRIES']
  else process.env['BABEL_DEEPINFRA_STREAM_MAX_RETRIES'] = originalEnv.deepinfraStreamRetries
  if (originalEnv.idle === undefined) delete process.env['BABEL_PROVIDER_STREAM_IDLE_TIMEOUT_MS']
  else process.env['BABEL_PROVIDER_STREAM_IDLE_TIMEOUT_MS'] = originalEnv.idle
  if (originalEnv.timeout === undefined) delete process.env['BABEL_PROVIDER_REQUEST_TIMEOUT_MS']
  else process.env['BABEL_PROVIDER_REQUEST_TIMEOUT_MS'] = originalEnv.timeout
})

type RawRunner = Pick<OpenAiCompatibleRunner, 'executeRaw' | 'executeRawStream'>

type AdapterCase = {
  label: string
  runner: () => RawRunner
}

const ROUTED_MODEL = 'deepseek/deepseek-v4.1-flash'

function wrapSsePayload(adapter: AdapterCase, payload: Record<string, unknown>): string {
  const body = adapter.label === 'deepinfra' ? payload : { model: ROUTED_MODEL, ...payload }
  return `data: ${JSON.stringify(body)}`
}

function sseFixture(adapter: AdapterCase, lines: string[]): string {
  return `${lines.join('\n')}\n`
}

const ADAPTERS: AdapterCase[] = [
  {
    label: 'deepinfra',
    runner: () => new DeepInfraApiRunner('deepseek-ai/DeepSeek-V3-0324'),
  },
  {
    label: 'openrouter',
    runner: () => new OpenRouterApiRunner(
      'deepseek/deepseek-v4.1-flash',
      { maxTokens: 128 },
      { env: process.env, explicitCredential: 'fixture-only' },
    ),
  },
  {
    label: 'command-code',
    runner: () => new CommandCodeApiRunner(
      'deepseek/deepseek-v4.1-flash',
      { maxTokens: 128 },
      { env: process.env, explicitCredential: 'fixture-only' },
    ),
  },
]

function heldOpenStreamAfterDone(ssePrefix: string): { response: Response; onCancel: () => boolean } {
  let bodyCancelled = false
  let pullGate: () => void
  const pullBlocked = new Promise<void>((resolve) => { pullGate = resolve })
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(ssePrefix))
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
  return { response, onCancel: () => bodyCancelled }
}

describe('executeRaw transport boundaries (mocked)', () => {
  for (const adapter of ADAPTERS) {
    describe(`${adapter.label} executeRaw / executeRawStream`, () => {
      it('raw-stream-partial-then-provider-error: must not finalize delivered', async () => {
        globalThis.fetch = async () => new Response(
          sseFixture(adapter, [
            wrapSsePayload(adapter, { choices: [{ delta: { content: 'partial' } }] }),
            wrapSsePayload(adapter, { error: { message: 'upstream overloaded' } }),
            'data: [DONE]',
          ]),
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
        )
        const completed: Array<{ status: string; partial_model_output?: boolean }> = []
        await assert.rejects(
          () => adapter.runner().executeRaw('probe', {
            onChunk: () => {},
            onInvocationCompleted: (value) => { completed.push(value) },
          }, 'system'),
          /Provider stream error|upstream overloaded/i,
        )
        assert.equal(completed.length, 1)
        assert.equal(completed[0]?.status, 'failed')
        assert.equal(completed[0]?.partial_model_output, true)
        assert.equal(completed.some((entry) => entry.status === 'delivered'), false)
      })

      it('raw-stream-partial-finish-reason-length: must not finalize delivered', async () => {
        globalThis.fetch = async () => new Response(
          sseFixture(adapter, [
            wrapSsePayload(adapter, { choices: [{ delta: { content: 'partial' }, finish_reason: 'length' }] }),
            'data: [DONE]',
          ]),
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
        )
        const completed: Array<{ status: string; partial_model_output?: boolean }> = []
        await assert.rejects(
          () => adapter.runner().executeRaw('probe', {
            onChunk: () => {},
            onInvocationCompleted: (value) => { completed.push(value) },
          }, 'system'),
          /finish_reason: length|output budget/i,
        )
        assert.equal(completed.length, 1)
        assert.equal(completed[0]?.status, 'failed')
        assert.equal(completed[0]?.partial_model_output, true)
        assert.equal(completed.some((entry) => entry.status === 'delivered'), false)
      })

      it('raw-stream-held-open-after-done-success: releases reader without waiting for EOF', async () => {
        const { response, onCancel } = heldOpenStreamAfterDone(
          `${wrapSsePayload(adapter, { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
        )
        globalThis.fetch = async () => response
        const completed: Array<{ status: string }> = []
        const text = await adapter.runner().executeRaw('probe', {
          onChunk: () => {},
          onInvocationCompleted: (value) => { completed.push(value) },
        }, 'system')
        assert.equal(text, 'ok')
        assert.equal(onCancel(), true)
        assert.equal(completed.length, 1)
        assert.equal(completed[0]?.status, 'delivered')
      })

      it('raw-stream-held-open-after-done-success via executeRawStream', async () => {
        const { response, onCancel } = heldOpenStreamAfterDone(
          `${wrapSsePayload(adapter, { choices: [{ delta: { content: 'stream-ok' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
        )
        globalThis.fetch = async () => response
        const completed: Array<{ status: string }> = []
        const chunks: string[] = []
        for await (const chunk of adapter.runner().executeRawStream('probe', 'system', undefined, {
          onInvocationCompleted: (value) => { completed.push(value) },
        })) chunks.push(chunk)
        assert.deepEqual(chunks, ['stream-ok'])
        assert.equal(onCancel(), true)
        assert.equal(completed.length, 1)
        assert.equal(completed[0]?.status, 'delivered')
      })

      it('raw-stream-held-open-after-done-length: rejects and cancels reader (not delivered)', async () => {
        const { response, onCancel } = heldOpenStreamAfterDone(
          `${wrapSsePayload(adapter, { choices: [{ delta: { content: 'partial' }, finish_reason: 'length' }] })}\n\ndata: [DONE]\n\n`,
        )
        globalThis.fetch = async () => response
        const completed: Array<{ status: string; partial_model_output?: boolean }> = []
        await assert.rejects(
          () => adapter.runner().executeRaw('probe', {
            onChunk: () => {},
            onInvocationCompleted: (value) => { completed.push(value) },
          }, 'system'),
          /finish_reason: length|output budget/i,
        )
        assert.equal(onCancel(), true)
        assert.equal(completed.length, 1)
        assert.equal(completed[0]?.status, 'failed')
        assert.equal(completed[0]?.partial_model_output, true)
      })

      it('raw-stream-held-open-after-done-provider-error: rejects and cancels reader', async () => {
        const { response, onCancel } = heldOpenStreamAfterDone(
          `${wrapSsePayload(adapter, { choices: [{ delta: { content: 'partial' } }] })}\n${wrapSsePayload(adapter, { error: { message: 'upstream overloaded' } })}\ndata: [DONE]\n\n`,
        )
        globalThis.fetch = async () => response
        const completed: Array<{ status: string }> = []
        await assert.rejects(
          () => adapter.runner().executeRaw('probe', {
            onChunk: () => {},
            onInvocationCompleted: (value) => { completed.push(value) },
          }, 'system'),
          /Provider stream error|upstream overloaded/i,
        )
        assert.equal(onCancel(), true)
        assert.equal(completed.length, 1)
        assert.equal(completed[0]?.status, 'failed')
        assert.equal(completed.some((entry) => entry.status === 'delivered'), false)
      })

      it('raw-nonstream-body-read-timeout-is-not-json-parse-error', async () => {
        process.env['BABEL_PROVIDER_STREAM_IDLE_TIMEOUT_MS'] = '40'
        process.env['BABEL_PROVIDER_REQUEST_TIMEOUT_MS'] = '500'
        globalThis.fetch = async () => new Response(
          new ReadableStream({ start() { /* stall after headers */ } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
        const completed: Array<{ status: string; failure_stage?: string | null }> = []
        await assert.rejects(
          () => adapter.runner().executeRaw('probe', {
            onInvocationCompleted: (value) => { completed.push(value) },
          }, 'system'),
          (error: unknown) => {
            const message = error instanceof Error ? error.message : String(error)
            assert.match(message, /timeout/i)
            assert.doesNotMatch(message, /Failed to parse API response as JSON/i)
            return true
          },
        )
        assert.equal(completed.length, 1)
        assert.equal(completed[0]?.status, 'failed')
        assert.equal(completed[0]?.failure_stage, 'stream')
      })

      it('raw-nonstream-invocation-deadline-not-reset-after-headers', async () => {
        const totalBudgetMs = 120
        process.env['BABEL_PROVIDER_REQUEST_TIMEOUT_MS'] = String(totalBudgetMs)
        process.env['BABEL_PROVIDER_STREAM_IDLE_TIMEOUT_MS'] = String(totalBudgetMs)
        const started = Date.now()
        globalThis.fetch = async () => {
          await new Promise<void>((resolve) => { setTimeout(resolve, 90) })
          return new Response(
            new ReadableStream({ start() { /* consume only remaining budget */ } }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        }
        const completed: Array<{ status: string }> = []
        await assert.rejects(
          () => adapter.runner().executeRaw('probe', {
            onInvocationCompleted: (value) => { completed.push(value) },
          }, 'system'),
          /timeout/i,
        )
        const elapsed = Date.now() - started
        assert.ok(
          elapsed < totalBudgetMs + 80,
          `expected invocation deadline ~${totalBudgetMs}ms, observed ${elapsed}ms (deadline must not reset after headers)`,
        )
        assert.equal(completed.length, 1)
        assert.equal(completed[0]?.status, 'failed')
      })

      it('raw-stream-truncation-without-done: executeRawStream surfaces failure without delivered receipt', async () => {
        globalThis.fetch = async () => new Response(
          `${wrapSsePayload(adapter, { choices: [{ delta: { content: 'partial' } }] })}\n\n`,
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
        )
        const completed: Array<{ status: string }> = []
        let thrown: unknown
        const chunks: string[] = []
        try {
          for await (const chunk of adapter.runner().executeRawStream('probe', 'system', undefined, {
            onInvocationCompleted: (value) => { completed.push(value) },
          })) chunks.push(chunk)
        } catch (error) {
          thrown = error
        }
        assert.ok(thrown instanceof Error)
        assert.equal(completed.length, 1)
        assert.equal(completed[0]?.status, 'failed')
        assert.ok(chunks.includes('partial'))
      })

      it('raw-stream-early-consumer-exit: aborts lane and cancels held-open body', async () => {
        let bodyCancelled = false
        let pullGate: () => void
        const pullBlocked = new Promise<void>((resolve) => { pullGate = resolve })
        globalThis.fetch = async () => new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(
                `${wrapSsePayload(adapter, { choices: [{ delta: { content: 'partial' } }] })}\n\n`,
              ))
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
        const completed: Array<{ status: string }> = []
        for await (const chunk of adapter.runner().executeRawStream('probe', 'system', undefined, {
          onInvocationCompleted: (value) => { completed.push(value) },
        })) {
          if (chunk === 'partial') break
        }
        await new Promise<void>((resolve) => { setTimeout(resolve, 30) })
        assert.equal(bodyCancelled, true)
        assert.equal(completed.length, 1)
        assert.equal(completed[0]?.status, 'failed')
      })

      it('raw-nonstream-post-headers-abort: JSON body read honours caller abort', async () => {
        const abort = new AbortController()
        let bodyCancelled = false
        globalThis.fetch = async () => new Response(
          new ReadableStream({
            start() { /* stall after headers */ },
            cancel() { bodyCancelled = true },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
        const completed: Array<{ status: string; failure_stage?: string | null }> = []
        const pending = assert.rejects(
          () => adapter.runner().executeRaw('probe', {
            onInvocationCompleted: (value) => { completed.push(value) },
          }, 'system', abort.signal),
          (error: unknown) => error instanceof Error && error.name === 'AbortError',
        )
        setTimeout(() => abort.abort(), 25)
        await pending
        assert.equal(bodyCancelled, true)
        assert.equal(completed.length, 1)
        assert.equal(completed[0]?.status, 'failed')
        assert.equal(completed[0]?.failure_stage, 'stream')
      })
    })
  }

  it('stream-retry-env-empty: getStreamMaxRetries keeps declared default 1', () => {
    delete process.env['BABEL_PROVIDER_STREAM_MAX_RETRIES']
    delete process.env['BABEL_DEEPINFRA_STREAM_MAX_RETRIES']
    assert.equal(getStreamMaxRetries(), DEFAULT_STREAM_MAX_RETRIES)
    assert.equal(DEFAULT_STREAM_MAX_RETRIES, 1)
    process.env['BABEL_PROVIDER_STREAM_MAX_RETRIES'] = ''
    assert.equal(getStreamMaxRetries(), 1)
    process.env['BABEL_PROVIDER_STREAM_MAX_RETRIES'] = '0'
    assert.equal(getStreamMaxRetries(), 0)
  })
})
