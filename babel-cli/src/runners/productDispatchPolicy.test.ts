import assert from 'node:assert/strict'
import test from 'node:test'
import { z } from 'zod'
import { isSyntheticProviderFixtureReady, runSyntheticProviderTestFile } from '../testinfra/synthetic-provider-fixture.mjs'

if (!isSyntheticProviderFixtureReady()) {
  test('product dispatch policy uses an isolated synthetic profile', { timeout: 60000 }, async t => {
    const result = await runSyntheticProviderTestFile(import.meta.url)
    t.diagnostic(JSON.stringify(result))
    assert.equal(result.exitCode, 0); assert.ok(result.passed > 0)
  })
} else {
  const { ProductProviderPolicyError, withProductProviderPolicy } = await import('./providerRegistry.js')
  const { createProviderRunner, createChatProviderAdapter } = await import('./providerEngine.js')
  const { DeepInfraApiRunner } = await import('./deepInfraApi.js')
  const { DeepSeekApiRunner } = await import('./deepSeekApi.js')
  const { GeminiApiRunner } = await import('./geminiApi.js')
  const { runWaterfallForSchemaFailureTest, runWithFallback, withPipelineModelRoute } = await import('../execute.js')
  const { EvidenceBundle } = await import('../evidence.js')
  const schema = z.object({ ok: z.boolean() })

  test('unapproved cached and direct adapters cannot dispatch in product scope', async () => {
    const previous = globalThis.fetch
    let calls = 0
    globalThis.fetch = async () => { calls++; return new Response('{"choices":[{"message":{"content":"{}"}}]}') }
    try {
      const options = { provider: 'deepinfra' as const, modelId: 'fixture-model', explicitCredential: 'fixture-key' }
      const engine = createProviderRunner(options)
      const chat = createChatProviderAdapter(options)
      const direct = new DeepInfraApiRunner('fixture-model', undefined, {}, { explicitCredential: 'fixture-key' })
      const deepseek = new DeepSeekApiRunner('deepseek-v4-flash', { explicitCredential: 'sk-fixture' })
      const gemini = new GeminiApiRunner({ modelId: 'fixture-model', explicitCredential: 'fixture-key' })
      await withProductProviderPolicy(async () => {
        await assert.rejects(async () => engine.execute('fixture', schema), /unsupported provider/i)
        await assert.rejects(async () => chat.executeRaw('fixture'), /unsupported provider/i)
        await assert.rejects(async () => direct.execute('fixture', schema), /unsupported provider/i)
        await assert.rejects(async () => deepseek.execute('fixture', schema), /unsupported provider/i)
        await assert.rejects(async () => gemini.executeRaw('fixture'), /unsupported provider/i)
        await assert.rejects(async () => { for await (const _ of chat.executeRawStream('fixture')) { /* drain */ } }, /unsupported provider/i)
        await assert.rejects(async () => { for await (const _ of direct.executeWithToolsStream([], [])) { /* drain */ } }, /unsupported provider/i)
      })
      assert.equal(calls, 0)
    } finally { globalThis.fetch = previous }
  })

  test('offline pipeline fixtures never fall through to a provider for an unknown stage', async () => {
    const previousFetch = globalThis.fetch
    const previousFixture = process.env['BABEL_PIPELINE_V9_OFFLINE']
    const previousKey = process.env['DEEPINFRA_API_KEY']
    let calls = 0
    process.env['BABEL_PIPELINE_V9_OFFLINE'] = '1'
    process.env['DEEPINFRA_API_KEY'] = 'fixture-key'
    globalThis.fetch = async () => { calls++; return new Response('{"choices":[{"message":{"content":"{\\"ok\\":true}"}}]}') }
    try {
      await assert.rejects(withProductProviderPolicy(() => withPipelineModelRoute('qwen3', () =>
        runWithFallback('fixture', schema, { maxCliAttempts: 1 }))), /offline|fixture/i)
      assert.equal(calls, 0)
    } finally {
      globalThis.fetch = previousFetch
      if (previousFixture === undefined) delete process.env['BABEL_PIPELINE_V9_OFFLINE']; else process.env['BABEL_PIPELINE_V9_OFFLINE'] = previousFixture
      if (previousKey === undefined) delete process.env['DEEPINFRA_API_KEY']; else process.env['DEEPINFRA_API_KEY'] = previousKey
    }
  })

  test('fixture mode blocks direct approved transports as well', async () => {
    const previous = process.env['BABEL_PIPELINE_V9_OFFLINE']
    const previousFetch = globalThis.fetch
    let calls = 0
    process.env['BABEL_PIPELINE_V9_OFFLINE'] = '1'
    globalThis.fetch = async () => { calls++; throw new Error('unexpected dispatch') }
    try {
      const runner = createProviderRunner({ provider: 'openrouter', modelId: 'vendor/model', explicitCredential: 'fixture-key' })
      await assert.rejects(async () => runner.execute('fixture', schema), /offline|fixture/i)
      assert.equal(calls, 0)
    } finally {
      globalThis.fetch = previousFetch
      if (previous === undefined) delete process.env['BABEL_PIPELINE_V9_OFFLINE']; else process.env['BABEL_PIPELINE_V9_OFFLINE'] = previous
    }
  })

  test('both approved providers remain dispatchable in product scope', async () => {
    const previous = globalThis.fetch
    let calls = 0
    globalThis.fetch = async (_url, init) => {
      calls++
      assert.equal(init?.redirect, 'error', 'product transports must not follow an unapproved redirect')
      return new Response('{"model":"vendor/model","choices":[{"message":{"content":"{\\"ok\\":true}"}}]}')
    }
    try {
      for (const provider of ['openrouter', 'command-code'] as const) {
        const runner = createProviderRunner({ provider, modelId: 'vendor/model', explicitCredential: 'fixture-key' })
        assert.deepEqual(await withProductProviderPolicy(() => runner.execute('fixture', schema)), { ok: true })
      }
      assert.equal(calls, 2)
    } finally { globalThis.fetch = previous }
  })

  test('a provider-policy denial cannot silently fall through the waterfall', async () => {
    let fallbackCalls = 0
    const denied = { execute: async () => { throw new ProductProviderPolicyError('deepinfra') } }
    const fallback = { execute: async () => { fallbackCalls++; return { ok: true } } }
    await assert.rejects(runWaterfallForSchemaFailureTest({ prompt: 'fixture', schema, stage: 'planning', schemaName: 'fixture',
      evidence: EvidenceBundle.inMemory('product-policy'), tiers: [{ name: 'denied', runner: denied }, { name: 'fallback', runner: fallback as never }] }), /unsupported provider/i)
    assert.equal(fallbackCalls, 0)
  })

  test('product mode allows an explicitly offline loopback provider', async () => {
    const previous = process.env['BABEL_OFFLINE']; const previousFetch = globalThis.fetch
    process.env['BABEL_OFFLINE'] = '1'
    let calls = 0
    globalThis.fetch = async () => { calls++; return new Response('{"choices":[{"message":{"content":"{\\"ok\\":true}"}}]}') }
    try {
      const runner = createProviderRunner({ provider: 'openai-compatible', modelId: 'fixture-model', baseUrl: 'http://127.0.0.1:11434/v1', explicitCredential: 'fixture-key' })
      assert.deepEqual(await withProductProviderPolicy(() => runner.execute('fixture', schema)), { ok: true })
      assert.equal(calls, 1)
    } finally {
      globalThis.fetch = previousFetch
      if (previous === undefined) delete process.env['BABEL_OFFLINE']; else process.env['BABEL_OFFLINE'] = previous
    }
  })
}
