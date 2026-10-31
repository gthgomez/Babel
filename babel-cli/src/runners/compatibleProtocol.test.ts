import assert from 'node:assert/strict'
import test from 'node:test'
import { z } from 'zod'

test('compatible providers share a neutral protocol rather than DeepInfra inheritance', async () => {
  const { OpenAiCompatibleRunner } = await import('./protocol/openai-chat-completions.js')
  const { OpenRouterApiRunner } = await import('./openRouterApi.js')
  const { DeepInfraApiRunner } = await import('./deepInfraApi.js')
  const runner = new OpenRouterApiRunner('fixture-model', {}, { explicitCredential: 'fixture-only', env: {} })
  assert.equal(runner instanceof OpenAiCompatibleRunner, true)
  assert.equal(runner instanceof DeepInfraApiRunner, false)
})

test('neutral retry setting accepts zero and takes precedence over the legacy setting', async () => {
  const { getRequestMaxRetries } = await import('./providerResponsePolicy.js')
  const neutral = process.env['BABEL_PROVIDER_REQUEST_MAX_RETRIES']
  const legacy = process.env['BABEL_DEEPINFRA_REQUEST_MAX_RETRIES']
  try {
    process.env['BABEL_PROVIDER_REQUEST_MAX_RETRIES'] = '0'
    process.env['BABEL_DEEPINFRA_REQUEST_MAX_RETRIES'] = '3'
    assert.equal(getRequestMaxRetries(), 0)
  } finally {
    if (neutral === undefined) delete process.env['BABEL_PROVIDER_REQUEST_MAX_RETRIES']
    else process.env['BABEL_PROVIDER_REQUEST_MAX_RETRIES'] = neutral
    if (legacy === undefined) delete process.env['BABEL_DEEPINFRA_REQUEST_MAX_RETRIES']
    else process.env['BABEL_DEEPINFRA_REQUEST_MAX_RETRIES'] = legacy
  }
})

test('OpenRouter HTTP failures identify the selected provider', async () => {
  const { OpenRouterApiRunner } = await import('./openRouterApi.js')
  const previousFetch = globalThis.fetch
  try {
    globalThis.fetch = async () => new Response('{}', { status: 401 })
    const runner = new OpenRouterApiRunner('fixture-model', {}, { explicitCredential: 'fixture-only', env: {} })
    await assert.rejects(runner.execute('fixture', z.object({ ok: z.boolean() })), error => {
      assert.equal(error instanceof Error, true)
      assert.match((error as Error).message, /\[openrouter\]/)
      assert.doesNotMatch((error as Error).message, /deepinfra/i)
      return true
    })
  } finally {
    globalThis.fetch = previousFetch
  }
})
