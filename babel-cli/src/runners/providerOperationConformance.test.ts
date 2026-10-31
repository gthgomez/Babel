import assert from 'node:assert/strict'
import test from 'node:test'
import { z } from 'zod'
import { createChatProviderAdapter } from './providerEngine.js'

for (const provider of ['openai', 'gemini', 'anthropic', 'openai-compatible'] as const) for (const operation of ['structured', 'raw', 'raw_stream', 'native_tool_stream'] as const) {
  test(`${provider} ${operation} uses its actual adapter and preserves identity/usage`, async () => {
    const previous = globalThis.fetch; let requests = 0; let started = 0; let completed = 0
    const content = operation === 'structured' ? '{"ok":true}' : 'fixture answer'
    try {
      globalThis.fetch = async (url, init) => {
        requests++; const body = JSON.parse(String(init?.body)); const stream = provider === 'gemini' ? String(url).includes('streamGenerateContent') : body.stream === true
        const frames = provider === 'gemini'
          ? [{ modelVersion: 'fixture-model', candidates: [{ content: { parts: [{ text: content }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } }]
          : provider === 'anthropic'
            ? [{ type: 'message_start', message: { model: 'fixture-model', usage: { input_tokens: 10 } } }, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: content } }, { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } }, { type: 'message_stop' }]
            : [{ model: 'fixture-model', choices: [{ delta: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }]
        if (stream) return new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('') + (provider === 'openai' || provider === 'openai-compatible' ? 'data: [DONE]\n\n' : ''))
        return new Response(JSON.stringify(provider === 'gemini' ? frames[0] : provider === 'anthropic'
          ? { model: 'fixture-model', content: [{ type: 'text', text: content }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } }
          : { model: 'fixture-model', choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }))
      }
      const runner = createChatProviderAdapter({ provider, modelId: 'fixture-model', env: {}, explicitCredential: 'fixture-only', sampling: { maxTokens: 64 }, contextWindowTokens: 8192, ...(provider === 'openai-compatible' ? { baseUrl: 'https://fixture.invalid/v1' } : {}) })
      const callbacks = { onInvocationStarted: () => { started++ }, onInvocationCompleted: () => { completed++ } }
      if (operation === 'structured') assert.deepEqual(await runner.execute('Return JSON', z.object({ ok: z.boolean() }), callbacks), { ok: true })
      else if (operation === 'raw') assert.equal(await runner.executeRaw('Hello', callbacks), content)
      else if (operation === 'raw_stream') { let text = ''; for await (const chunk of runner.executeRawStream('Hello', undefined, undefined, callbacks)) text += chunk; assert.equal(text, content) }
      else { let text = ''; for await (const event of runner.executeWithToolsStream([{ role: 'user', content: 'Hello' }], [], undefined, undefined, 'auto', callbacks)) { if (event.type === 'error') assert.fail(event.message); if (event.type === 'text_delta') text += event.text }; assert.equal(text, content) }
      assert.equal(requests, 1); assert.equal(started, 1); assert.equal(completed, 1)
      assert.equal(runner.getLastInvocationMetadata()?.observed_model_id, 'fixture-model'); assert.equal(runner.getLastInvocationMetadata()?.total_tokens, 15)
    } finally { globalThis.fetch = previous }
  })
}
