import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import type { ToolStreamEvent, ProviderInvocationStarted } from './base.js'

const tool = { type: 'function' as const, function: { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } }
const sse = (frames: unknown[]) => new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })

test('Gemini native tools preserve thought signatures, correlation, exact request accounting and unknown prices', async () => {
  const { GeminiApiRunner } = await import('./geminiApi.js')
  const oldFetch = globalThis.fetch
  let body = ''
  let started: ProviderInvocationStarted | undefined
  try {
    globalThis.fetch = async (_url, init) => {
      body = String(init?.body)
      return sse([{ modelVersion: 'fixture-gemini', candidates: [{ content: { parts: [{ thoughtSignature: 'opaque-fixture-signature', functionCall: { id: 'call-1', name: 'read_file', args: { path: 'README.md' } } }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4, totalTokenCount: 14 } }])
    }
    const runner = new GeminiApiRunner({ explicitCredential: 'fixture-only', env: {}, modelId: 'fixture-gemini' })
    const events: ToolStreamEvent[] = []
    for await (const event of runner.executeWithToolsStream([{ role: 'user', content: 'Read it' }], [tool], 'System policy', undefined, 'auto', { onInvocationStarted: value => { started = value } })) events.push(event)
    const call = events.find(event => event.type === 'tool_use')
    assert.equal(call?.type, 'tool_use')
    if (call?.type !== 'tool_use') return
    assert.equal(call.id, 'call-1')
    assert.equal(call.providerMetadata?.provider, 'gemini')
    assert.equal(started?.input_digest, createHash('sha256').update(body).digest('hex'))
    assert.equal(runner.getLastInvocationMetadata()?.total_tokens, 14)
    assert.equal(runner.getLastInvocationMetadata()?.estimated_cost_usd, null)
    const next = JSON.parse(runner.buildNativeToolsWireBody([
      { role: 'assistant', content: '', tool_calls: [{ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.input) }, ...(call.providerMetadata ? { providerMetadata: call.providerMetadata } : {}) }] },
      { role: 'tool', content: 'result', tool_call_id: call.id, name: call.name },
    ], [tool], 'System policy'))
    assert.equal(next.contents[0].parts[0].thoughtSignature, 'opaque-fixture-signature')
    assert.equal(next.contents[1].parts[0].functionResponse.id, 'call-1')
    assert.equal(next.systemInstruction.parts[0].text, 'System policy')
  } finally { globalThis.fetch = oldFetch }
})

test('Anthropic assembles fragmented tool JSON and preserves tool-result blocks', async () => {
  const { AnthropicApiRunner } = await import('./anthropicApi.js')
  const oldFetch = globalThis.fetch
  try {
    globalThis.fetch = async () => sse([
      { type: 'message_start', message: { model: 'fixture-claude', usage: { input_tokens: 10 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call-2', name: 'read_file', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"README.md"}' } },
      { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 4 } }, { type: 'message_stop' },
    ])
    const runner = new AnthropicApiRunner({ explicitCredential: 'fixture-only', env: {}, modelId: 'fixture-claude' })
    const events: ToolStreamEvent[] = []
    for await (const event of runner.executeWithToolsStream([{ role: 'user', content: 'Read it' }], [tool])) events.push(event)
    const call = events.find(event => event.type === 'tool_use')
    assert.equal(call?.type, 'tool_use')
    if (call?.type !== 'tool_use') return
    assert.equal(call.input['path'], 'README.md')
    assert.equal(runner.getLastInvocationMetadata()?.total_tokens, 14)
    const next = JSON.parse(runner.buildNativeToolsWireBody([{ role: 'assistant', content: '', tool_calls: [{ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.input) } }] }, { role: 'tool', content: 'result', tool_call_id: call.id }], [tool], 'System policy'))
    assert.equal(next.messages[1].content[0].tool_use_id, 'call-2')
    assert.equal(next.system, 'System policy')
  } finally { globalThis.fetch = oldFetch }
})

test('OpenAI direct tools use shared protocol and the native completion budget field', async () => {
  const { OpenAiApiRunner } = await import('./openAiApi.js')
  const runner = new OpenAiApiRunner({ explicitCredential: 'fixture-only', env: {}, modelId: 'fixture-openai', maxTokens: 128 })
  const body = JSON.parse(runner.buildNativeToolsWireBody([{ role: 'user', content: 'Read it' }], [tool], 'Policy'))
  assert.equal(body.max_completion_tokens, 128)
  assert.equal(body.max_tokens, undefined)
  assert.equal(body.messages[0].content, 'Policy')
})


test('native providers do not retry admission denials and retain partial usage on failed streams', async () => {
  const { GeminiApiRunner } = await import('./geminiApi.js')
  const priorFetch = globalThis.fetch
  const priorRetries = process.env['BABEL_PROVIDER_REQUEST_MAX_RETRIES']
  process.env['BABEL_PROVIDER_REQUEST_MAX_RETRIES'] = '3'
  let admissions = 0
  let fetches = 0
  try {
    globalThis.fetch = async () => { fetches++; return sse([]) }
    const runner = new GeminiApiRunner({ explicitCredential: 'fixture-only', env: {}, modelId: 'fixture-gemini' })
    const events: ToolStreamEvent[] = []
    for await (const event of runner.executeWithToolsStream([{ role: 'user', content: 'hello' }], [], undefined, undefined, 'auto', {
      campaignMeter: { executionStage: 'chat', gate: {
        admitBeforeDispatch: async () => { admissions++; throw new Error('fixture admission denied') },
      } } as never,
    })) events.push(event)
    assert.equal(admissions, 1)
    assert.equal(fetches, 0)
    assert.match(events.find(event => event.type === 'error')?.message ?? '', /admission denied/)

    globalThis.fetch = async () => sse([{ modelVersion: 'observed-fixture', usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 3 }, candidates: [{ content: { parts: [{ text: 'partial' }] } }] }])
    const partial: ToolStreamEvent[] = []
    for await (const event of runner.executeWithToolsStream([{ role: 'user', content: 'hello' }], [])) partial.push(event)
    assert.equal(partial.at(-1)?.type, 'error')
    assert.equal(runner.getLastInvocationMetadata()?.prompt_tokens, 12)
    assert.equal(runner.getLastInvocationMetadata()?.completion_tokens, 3)
  } finally {
    globalThis.fetch = priorFetch
    if (priorRetries === undefined) delete process.env['BABEL_PROVIDER_REQUEST_MAX_RETRIES']
    else process.env['BABEL_PROVIDER_REQUEST_MAX_RETRIES'] = priorRetries
  }
})

test('Gemini generated correlation IDs survive the following request', async () => {
  const { GeminiApiRunner } = await import('./geminiApi.js')
  const oldFetch = globalThis.fetch
  try {
    globalThis.fetch = async () => sse([{ candidates: [{ content: { parts: [{ functionCall: { name: 'read_file', args: { path: 'README.md' } }, thoughtSignature: 'fixture' }] }, finishReason: 'STOP' }] }])
    const runner = new GeminiApiRunner({ explicitCredential: 'fixture-only', env: {}, modelId: 'fixture-gemini' })
    let call: Extract<ToolStreamEvent, { type: 'tool_use' }> | undefined
    for await (const event of runner.executeWithToolsStream([{ role: 'user', content: 'read' }], [tool])) if (event.type === 'tool_use') call = event
    assert.ok(call)
    const body = JSON.parse(runner.buildNativeToolsWireBody([
      { role: 'assistant', content: '', tool_calls: [{ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.input) }, ...(call.providerMetadata ? { providerMetadata: call.providerMetadata } : {}) }] },
      { role: 'tool', content: 'result', tool_call_id: call.id },
    ], [tool]))
    assert.equal(body.contents[0].parts[0].functionCall.id, body.contents[1].parts[0].functionResponse.id)
  } finally { globalThis.fetch = oldFetch }
})


test('Gemini opaque response parts survive durable event-log reload and reconstruction', async () => {
  const { mkdtempSync } = await import('node:fs'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path')
  const { createThreadEventLog, startTurn, recordAssistantToolCalls, recordToolResult, persistThreadEventLog, loadThreadEventLogFromDir, rebuildProviderMessagesFromEvents } = await import('../agent/threadEventLog.js')
  const root = mkdtempSync(join(tmpdir(), 'babel-gemini-resume-'))
  const log = createThreadEventLog('fixture-gemini-thread')
  const turn = startTurn(log, { task: 'Read README', model: 'fixture-model', provider: 'gemini', projectRoot: root, policyPreset: 'workspace_write' })
  recordAssistantToolCalls(log, turn, '', [{ id: 'fixture-call', type: 'function', function: { name: 'read_file', arguments: '{"path":"README.md"}' }, providerMetadata: { provider: 'gemini', parts: [{ thoughtSignature: 'opaque-fixture', functionCall: { id: 'fixture-call', name: 'read_file', args: { path: 'README.md' } } }] } }])
  recordToolResult(log, turn, { tool_call_id: 'fixture-call', tool_name: 'read_file', content: 'fixture result' })
  await persistThreadEventLog(root, log)
  const restored = loadThreadEventLogFromDir(root); assert.ok(restored)
  const { GeminiApiRunner } = await import('./geminiApi.js')
  const api = new GeminiApiRunner({ env: {}, explicitCredential: 'fixture-only', modelId: 'fixture-model' })
  const body = JSON.parse(api.buildNativeToolsWireBody(rebuildProviderMessagesFromEvents(restored), [tool]))
  const parts = body.contents.flatMap((content: { parts: Record<string, unknown>[] }) => content.parts)
  assert.equal(parts.some((part: Record<string, unknown>) => part['thoughtSignature'] === 'opaque-fixture'), true)
  assert.equal(parts.some((part: { functionResponse?: { id?: string } }) => part.functionResponse?.id === 'fixture-call'), true)
})
