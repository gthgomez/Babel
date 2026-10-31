import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { GeminiApiRunner } from './geminiApi.js'
import { AnthropicApiRunner } from './anthropicApi.js'
import { createProviderRunner } from './providerEngine.js'
import { prepareProviderRequest } from './preparedProviderRequest.js'
import { resolveProviderCapabilities } from '../agent/providerCapabilities.js'
import type { ProviderInvocationCompleted, ProviderMessage } from './base.js'

const models = [GeminiApiRunner, AnthropicApiRunner]
const options = { explicitCredential: 'fixture-only', env: {}, modelId: 'fixture-model', maxTokens: 64 }
const messages: ProviderMessage[] = [{ role: 'user', content: 'Hello' }]

test('thin compatible adapters retain the explicitly declared context ceiling', async () => {
  for (const provider of ['command-code', 'opencode', 'opencode-go'] as const) {
    const runner = createProviderRunner({ provider, modelId: provider === 'opencode-go' ? 'deepseek-v4-flash' : 'fixture-model', explicitCredential: 'fixture-only', env: {}, contextWindowTokens: 200, sampling: { maxTokens: 64 } })
    await assert.rejects(runner.executeRaw('x'.repeat(4000)), /body exceeds/)
  }
})

test('request context metadata is scoped to the exact provider as well as model identity', () => {
  const input = { body: JSON.stringify({ messages }), mode: 'native' as const, requestedModelId: 'deepseek-v4-flash', reservedCompletionTokens: 64 }
  assert.equal(prepareProviderRequest({ ...input, provider: 'deepseek' }).context_limit_tokens, 1_000_000)
  assert.equal(prepareProviderRequest({ ...input, provider: 'openai-compatible' }).context_limit_tokens, null)
  assert.equal(resolveProviderCapabilities('deepseek-v4-flash', undefined, 'openai-compatible').contextWindow, 0)
})

test('native provider output ceilings preserve explicit, legacy environment and original defaults', () => {
  for (const [Api, variable, fallback] of [[GeminiApiRunner, 'BABEL_GEMINI_TOKENS', 8192], [AnthropicApiRunner, 'BABEL_API_TOKENS', 8096]] as const) {
    assert.equal(new Api({ explicitCredential: 'fixture-only', env: { [variable]: '256' } }).getNativeRequestReservedCompletionTokens(), 256)
    assert.equal(new Api({ ...options, env: { [variable]: '256' } }).getNativeRequestReservedCompletionTokens(), 64)
    assert.equal(new Api({ explicitCredential: 'fixture-only', env: {} }).getNativeRequestReservedCompletionTokens(), fallback)
  }
})

test('native admission includes Gemini contents and Anthropic top-level system before fetch', async () => {
  const previous = globalThis.fetch; let dispatched = false
  globalThis.fetch = async () => { dispatched = true; throw new Error('unexpected dispatch') }
  try {
    for (const Api of models) {
      const runner = new Api({ ...options, contextWindowTokens: 200 })
      await assert.rejects(runner.executeRaw('x'.repeat(4000)), /body exceeds/)
      await assert.rejects(runner.executeRaw('short', undefined, 'x'.repeat(4000)), /body exceeds/)
    }
    assert.equal(dispatched, false)
  } finally { globalThis.fetch = previous }
})

test('native serializers reject uncommitted and promoted model context and retain advisory semantics', () => {
  for (const Api of models) {
    const runner = new Api(options)
    assert.throws(() => runner.buildNativeToolsWireBody([{ role: 'assistant', content: 'draft', compactionCandidate: true }], []), /Uncommitted/)
    assert.throws(() => runner.buildNativeToolsWireBody([{ role: 'system', content: 'model content', provenance: 'model', authoritative: false }], []), /system role/)
    const wire = runner.buildNativeToolsWireBody([...messages, { role: 'assistant', content: 'advice', provenance: 'model', authoritative: false }], [], 'UNIQUE PRIMARY PROMPT')
    assert.match(wire, /BABEL ADVISORY CONTEXT RULE/)
    assert.equal(wire.split('UNIQUE PRIMARY PROMPT').length - 1, 1)
  }
})

test('native receipts retain partial thought and tool material hashes and output budgets', async () => {
  const previous = globalThis.fetch
  const empty = createHash('sha256').update('').digest('hex')
  try {
    for (const part of [{ text: 'private reasoning', thought: true }, { functionCall: { id: 'call-a', name: 'read_file', args: { path: 'file.ts' } } }]) {
      let completed: ProviderInvocationCompleted | undefined
      globalThis.fetch = async () => new Response(`data: ${JSON.stringify({ candidates: [{ content: { parts: [part] } }] })}\n\n`)
      for await (const _event of new GeminiApiRunner(options).executeWithToolsStream(messages, [], undefined, undefined, 'auto', { onInvocationCompleted: value => { completed = value } })) { /* drain incomplete stream */ }
      assert.equal(completed?.failure_receipt?.partial_model_output, true)
      assert.notEqual(completed?.failure_receipt?.output_digest, empty)
      assert.equal(completed?.failure_receipt?.requested_output_budget, 64)
      assert.equal(completed?.failure_receipt?.effective_output_budget, 64)
      assert.equal(completed?.failure_receipt?.tool_call_count, 0)
    }
    let completed: ProviderInvocationCompleted | undefined
    globalThis.fetch = async () => new Response(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ functionCall: { id: 'call-a', name: 'read_file', args: {} } }] }, finishReason: 'STOP' }] })}\n\n`)
    for await (const _event of new GeminiApiRunner(options).executeWithToolsStream(messages, [], undefined, undefined, 'auto', { onInvocationCompleted: value => { completed = value } })) { /* drain */ }
    assert.equal(completed?.status, 'delivered'); assert.notEqual(completed?.output_digest, empty)
    assert.equal(completed?.tool_call_count, 1)
  } finally { globalThis.fetch = previous }
})

test('Go selected credential reference cannot fall through to another account or helper', async () => {
  const previous = globalThis.fetch; let selected = false
  globalThis.fetch = async (_input, init) => {
    selected = new Headers(init?.headers).get('authorization') === 'Bearer fixture-selected'
    return new Response(JSON.stringify({ model: 'deepseek-v4-flash', choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }))
  }
  try {
    const runner = createProviderRunner({ provider: 'opencode-go', modelId: 'deepseek-v4-flash', apiKeyEnvVar: 'WORK_GO_KEY', env: { WORK_GO_KEY: 'fixture-selected', BABEL_OPENCODE_GO_API_KEY: 'fixture-other' } })
    assert.equal(await runner.executeRaw('Hello'), 'ok'); assert.equal(selected, true)
    assert.throws(() => createProviderRunner({ provider: 'opencode-go', modelId: 'deepseek-v4-flash', apiKeyEnvVar: 'WORK_GO_KEY', env: { BABEL_OPENCODE_GO_API_KEY: 'fixture-other' } }), /WORK_GO_KEY/)
  } finally { globalThis.fetch = previous }
})
