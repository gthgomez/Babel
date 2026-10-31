import assert from 'node:assert/strict'
import test from 'node:test'
import { LLMSummarizeCompaction } from './chatCompaction.js'
import { GeminiApiRunner } from '../runners/geminiApi.js'

test('selected connection compaction uses its existing native runner, account and lifecycle', async () => {
  const prior = globalThis.fetch; let calls = 0; let started = 0; let completed = 0; let usageModel = ''
  try {
    globalThis.fetch = async (url, init) => {
      calls++; assert.match(String(url), /generativelanguage.googleapis.com/)
      assert.equal(new Headers(init?.headers).get('x-goog-api-key'), 'selected-fixture-account')
      return new Response(JSON.stringify({ modelVersion: 'fixture-gemini', candidates: [{ content: { parts: [{ text: 'Fixture summary retains the project decisions and pending tasks.' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 10 } }))
    }
    const runner = new GeminiApiRunner({ explicitCredential: 'selected-fixture-account', env: {}, modelId: 'fixture-gemini', maxTokens: 128 })
    const messages = Array.from({ length: 10 }, (_, index) => ({ role: index % 2 ? 'assistant' as const : 'user' as const, content: `Message ${index}: ${'bounded fixture text '.repeat(200)}` }))
    const result = await new LLMSummarizeCompaction({ keepRecentMessages: 2 }).compact(messages, {
      maxTokens: 2000, model: 'fixture-gemini', allowAmbientProvider: false,
      summarizationProvider: { runner, defaultModel: 'fixture-gemini' },
      callbacks: { onInvocationStarted: () => { started++ }, onInvocationCompleted: () => { completed++ } },
      onUsageRecorded: usage => { usageModel = usage.modelId },
    })
    assert.equal(calls, 1); assert.equal(started, 1); assert.equal(completed, 1)
    assert.equal(usageModel, 'fixture-gemini'); assert.ok(result.some(message => message.content.includes('Fixture summary')))
  } finally { globalThis.fetch = prior }
})
