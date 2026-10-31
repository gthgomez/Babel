import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChatEngine } from './chatEngine.js'
import { resolveModelByKey } from '../modelPolicy.js'
import { GeminiApiRunner } from '../runners/geminiApi.js'
import { AnthropicApiRunner } from '../runners/anthropicApi.js'
import { OpenAiApiRunner } from '../runners/openAiApi.js'
import { CompatibleApiRunner } from '../runners/compatibleApi.js'

for (const provider of ['gemini', 'anthropic', 'openai', 'openai-compatible'] as const) {
  test(`${provider} native Chat tool requests reach Babel denial and return the denied result to the same provider`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'babel-native-authority-'))
    writeFileSync(join(root, 'README.md'), 'Fixture project')
    const before = { fetch: globalThis.fetch, state: process.env['BABEL_STATE_DIR'], runs: process.env['BABEL_RUNS_DIR'] }
    process.env['BABEL_STATE_DIR'] = join(root, 'profile')
    process.env['BABEL_RUNS_DIR'] = join(root, 'runs')
    let requests = 0
    let deliveredDenial = false
    try {
      globalThis.fetch = async (url, init) => {
        const body = JSON.parse(String(init?.body))
        if (provider === 'gemini' && !String(url).includes('streamGenerateContent')) return new Response(JSON.stringify({ modelVersion: 'fixture-native', candidates: [{ content: { parts: [{ text: 'The credential read was denied.' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 5 } }))
        if (provider === 'anthropic' && !body.stream) return new Response(JSON.stringify({ model: 'fixture-native', content: [{ type: 'text', text: 'The credential read was denied.' }], stop_reason: 'end_turn', usage: { input_tokens: 20, output_tokens: 5 } }))
        requests++
        if (requests === 2 && provider === 'gemini') assert.match(JSON.stringify(body.contents), /fixture-state/, 'opaque Gemini state must reach the next actual request');
        if (requests === 2) deliveredDenial = /denied|blocked|credential|forbidden/i.test(JSON.stringify(provider === 'gemini' ? body.contents : body.messages))
        if (provider === 'openai' || provider === 'openai-compatible') {
          const frame = { model: 'fixture-native', choices: [{ delta: requests === 1 ? { tool_calls: [{ index: 0, id: 'native-call', type: 'function', function: { name: 'read_file', arguments: '{"path":".env"}' } }] } : { content: 'The requested credential read was denied.' }, finish_reason: requests === 1 ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } }
          return new Response(`data: ${JSON.stringify(frame)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
        }
        const frames = provider === 'gemini'
          ? [{ modelVersion: 'fixture-native', candidates: [{ content: { parts: requests === 1 ? [{ functionCall: { id: 'native-call', name: 'read_file', args: { path: '.env' } }, thoughtSignature: 'fixture-state' }] : [{ text: 'The requested credential read was denied.' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 5 } }]
          : [{ type: 'message_start', message: { model: 'fixture-native', usage: { input_tokens: 20 } } },
            ...(requests === 1 ? [{ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'native-call', name: 'read_file', input: {} } }, { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":".env"}' } }, { type: 'content_block_stop', index: 0 }]
              : [{ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'The requested credential read was denied.' } }]),
            { type: 'message_delta', delta: { stop_reason: requests === 1 ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 5 } }, { type: 'message_stop' }]
        return new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
      }
      const options = { explicitCredential: 'fixture-only', env: {}, modelId: 'fixture-native', maxTokens: 128 }
      const runner = provider === 'gemini' ? new GeminiApiRunner(options) : provider === 'anthropic' ? new AnthropicApiRunner(options)
        : provider === 'openai' ? new OpenAiApiRunner(options) : new CompatibleApiRunner('fixture-native', { ...options, baseUrl: 'https://fixture.invalid/v1' })
      const existing = resolveModelByKey({ key: 'deepseek-v4-flash-openrouter' })
      const engine = new ChatEngine({ task: 'Explain the README', projectRoot: root, maxTurns: 3, providerRunner: runner,
        providerPolicy: { ...existing, provider, providerModelId: 'fixture-native', resolvedBackendKey: `${provider}/fixture-native`, contextWindow: 128000 } })
      const events = []
      for await (const event of engine.submitMessageStream('Explain the README')) events.push(event)
      assert.equal(engine.getProviderSelectionStatus().requestedModel, 'fixture-native');
      assert.equal(engine.getProviderSelectionStatus().observedModel, 'fixture-native', JSON.stringify({ runner: runner.getLastInvocationMetadata(), selection: engine.getProviderSelectionStatus() }));
      engine.closeAdmissionStore()
      assert.ok(requests >= 2, 'expected a tool request and a result-delivery request')
      assert.equal(deliveredDenial, true)
      assert.equal(events.some(event => event.type === 'tool_failed' && /denied|blocked|credential|forbidden/i.test(event.error ?? '')), true)
    } finally {
      globalThis.fetch = before.fetch
      if (before.state === undefined) delete process.env['BABEL_STATE_DIR']; else process.env['BABEL_STATE_DIR'] = before.state
      if (before.runs === undefined) delete process.env['BABEL_RUNS_DIR']; else process.env['BABEL_RUNS_DIR'] = before.runs
    }
  })
}
