import assert from 'node:assert/strict'
import test from 'node:test'
import { z } from 'zod'
import { GroqApiRunner } from './groqApi.js'

/** Exercise the real SDK through native fetch, without allowing a network request. */
async function withResponse<T>(content: unknown, status: number, run: (runner: GroqApiRunner) => Promise<T>): Promise<T> {
  const previousFetch = globalThis.fetch
  let requests = 0
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init)
    assert.equal(new URL(request.url).hostname, 'api.groq.com')
    assert.equal(new URL(request.url).pathname, '/openai/v1/chat/completions')
    assert.equal(request.method, 'POST')
    const body = await request.json() as Record<string, unknown>
    assert.equal(body['model'], 'synthetic-model')
    assert.equal(body['max_tokens'], 64)
    assert.equal(body['temperature'], 0)
    requests++
    return new Response(JSON.stringify(content), { status, headers: { 'content-type': 'application/json' } })
  }
  try {
    const runner = new GroqApiRunner({ explicitCredential: 'synthetic-offline-credential', modelId: 'synthetic-model', maxTokens: 64 })
    const result = await run(runner)
    assert.equal(requests, 1)
    return result
  } finally { globalThis.fetch = previousFetch }
}

test('Groq adapter uses native fetch and validates structured completion output', { timeout: 10_000 }, async () => {
  const output = await withResponse({ choices: [{ message: { role: 'assistant', content: '{"answer":"ok"}' } }] }, 200,
    runner => runner.execute('Synthetic task', z.object({ answer: z.string() })))
  assert.deepEqual(output, { answer: 'ok' })
})

test('Groq adapter preserves provider error reporting with the new SDK', { timeout: 10_000 }, async () => {
  await withResponse({ error: { message: 'Synthetic provider rejection' } }, 401, async runner => {
    await assert.rejects(() => runner.execute('Synthetic task', z.object({ answer: z.string() })), /\[groqApi\] Groq API call failed/)
  })
})

test('Groq adapter rejects empty completion output', { timeout: 10_000 }, async () => {
  await withResponse({ choices: [] }, 200, async runner => {
    await assert.rejects(() => runner.execute('Synthetic task', z.object({ answer: z.string() })), /empty response/)
  })
})

test('Groq adapter retains schema validation after the SDK migration', { timeout: 10_000 }, async () => {
  await withResponse({ choices: [{ message: { role: 'assistant', content: '{"answer":42}' } }] }, 200, async runner => {
    await assert.rejects(() => runner.execute('Synthetic task', z.object({ answer: z.string() })), /Zod validation failed/)
  })
})
