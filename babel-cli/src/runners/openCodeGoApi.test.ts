import assert from 'node:assert/strict'
import test from 'node:test'
import { z } from 'zod'

import {
  OPENCODE_GO_BASE_URL,
  OPENCODE_GO_MODELS,
  OPENCODE_GO_USER_AGENT,
  OpenCodeGoApiRunner,
  OpenCodeGoError,
} from './openCodeGoApi.js'

const originalFetch = globalThis.fetch

test.afterEach(() => {
  globalThis.fetch = originalFetch
  delete process.env['BABEL_DEEPINFRA_REQUEST_MAX_RETRIES']
})

test('OpenCode Go admits only the canonical direct model identifiers', () => {
  assert.deepEqual(OPENCODE_GO_MODELS, [
    'deepseek-v4-flash',
    'mimo-v2.5',
    'longcat-2.0',
  ])
})

test('OpenCode Go pins endpoint, model, stable session, and invocation attribution', async () => {
  const sessions: string[] = []
  const userAgents: string[] = []
  let observedUrl = ''
  let observedBody: Record<string, unknown> = {}
  globalThis.fetch = (async (input, init) => {
    observedUrl = String(input)
    sessions.push(String((init?.headers as Record<string, string>)['x-opencode-session'] ?? ''))
    userAgents.push(String((init?.headers as Record<string, string>)['User-Agent'] ?? ''))
    observedBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    return new Response(JSON.stringify({
      model: 'mimo-v2.5',
      choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
    }), { status: 200 })
  }) as typeof fetch

  const runner = new OpenCodeGoApiRunner('mimo-v2.5', {}, {
    credentialSource: 'explicit-test',
    explicitCredential: 'synthetic-go-key',
    sessionId: 'session-for-one-conversation',
  })
  assert.deepEqual(await runner.execute('first', z.object({ ok: z.literal(true) })), { ok: true })
  assert.deepEqual(await runner.execute('second', z.object({ ok: z.literal(true) })), { ok: true })

  assert.equal(observedUrl, `${OPENCODE_GO_BASE_URL}/chat/completions`)
  assert.equal(observedBody.model, 'mimo-v2.5')
  assert.deepEqual(sessions, ['session-for-one-conversation', 'session-for-one-conversation'])
  assert.deepEqual(userAgents, [OPENCODE_GO_USER_AGENT, OPENCODE_GO_USER_AGENT])
  assert.equal(runner.getLastOpenCodeSessionId(), 'session-for-one-conversation')
  assert.equal(runner.getLastInvocationMetadata()?.provider, 'opencode-go')
  assert.equal(runner.getLastInvocationMetadata()?.observed_model_id, 'mimo-v2.5')
  assert.equal(runner.getLastInvocationMetadata()?.total_tokens, 18)
})

test('OpenCode Go rejects non-canonical and substituted models without fallback', async () => {
  assert.throws(
    () => new OpenCodeGoApiRunner('glm-5.3-flash', {}, {
      credentialSource: 'explicit-test',
      explicitCredential: 'synthetic-go-key',
    }),
    (error: unknown) => error instanceof OpenCodeGoError && error.code === 'MODEL_UNAVAILABLE',
  )
  globalThis.fetch = (async () => new Response(JSON.stringify({
    model: 'longcat-2.0',
    choices: [{ message: { content: '{"ok":true}' } }],
  }), { status: 200 })) as typeof fetch
  const runner = new OpenCodeGoApiRunner('mimo-v2.5', {}, {
    credentialSource: 'explicit-test',
    explicitCredential: 'synthetic-go-key',
  })
  await assert.rejects(
    runner.execute('respond', z.object({ ok: z.literal(true) })),
    (error: unknown) => error instanceof OpenCodeGoError && error.code === 'MODEL_ATTRIBUTION_FAILURE',
  )
})

test('OpenCode Go rejects missing response identity for structured and raw calls', async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify({
    choices: [{ message: { content: '{"ok":true}' } }],
  }), { status: 200 })) as typeof fetch
  const structured = new OpenCodeGoApiRunner('mimo-v2.5', {}, {
    credentialSource: 'explicit-test',
    explicitCredential: 'synthetic-go-key',
  })
  await assert.rejects(
    structured.execute('respond', z.object({ ok: z.literal(true) })),
    (error: unknown) => error instanceof OpenCodeGoError && error.code === 'MODEL_ATTRIBUTION_FAILURE',
  )

  const raw = new OpenCodeGoApiRunner('mimo-v2.5', {}, {
    credentialSource: 'explicit-test',
    explicitCredential: 'synthetic-go-key',
  })
  await assert.rejects(
    raw.executeRaw('respond'),
    (error: unknown) => error instanceof OpenCodeGoError && error.code === 'MODEL_ATTRIBUTION_FAILURE',
  )
})

test('OpenCode Go rejects missing response identity from raw streams', async () => {
  globalThis.fetch = (async () => new Response([
    `data: ${JSON.stringify({ choices: [{ delta: { content: 'answer' } }] })}`,
    'data: [DONE]',
    '',
  ].join('\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } })) as typeof fetch
  const runner = new OpenCodeGoApiRunner('mimo-v2.5', {}, {
    credentialSource: 'explicit-test',
    explicitCredential: 'synthetic-go-key',
  })

  await assert.rejects(
    async () => {
      for await (const _chunk of runner.executeRawStream('respond')) {
        // Consume the stream so its terminal identity validation executes.
      }
    },
    (error: unknown) => error instanceof OpenCodeGoError && error.code === 'MODEL_ATTRIBUTION_FAILURE',
  )
})

test('OpenCode Go rejects missing response identity from tool streams', async () => {
  globalThis.fetch = (async () => new Response([
    `data: ${JSON.stringify({ choices: [{ delta: { content: 'answer' } }] })}`,
    'data: [DONE]',
    '',
  ].join('\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } })) as typeof fetch
  const runner = new OpenCodeGoApiRunner('mimo-v2.5', {}, {
    credentialSource: 'explicit-test',
    explicitCredential: 'synthetic-go-key',
  })

  await assert.rejects(
    async () => {
      for await (const _event of runner.executeWithToolsStream(
        [{ role: 'user', content: 'respond' }],
        [],
      )) {
        // Consume the stream so its terminal identity validation executes.
      }
    },
    (error: unknown) => error instanceof OpenCodeGoError && error.code === 'MODEL_ATTRIBUTION_FAILURE',
  )
})

test('OpenCode Go does not retain prior usage when a later response omits usage', async () => {
  let calls = 0
  globalThis.fetch = (async () => {
    calls += 1
    return new Response(JSON.stringify({
      model: 'mimo-v2.5',
      choices: [{ message: { content: '{"ok":true}' } }],
      ...(calls === 1 ? { usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } } : {}),
    }), { status: 200 })
  }) as typeof fetch
  const runner = new OpenCodeGoApiRunner('mimo-v2.5', {}, {
    credentialSource: 'explicit-test',
    explicitCredential: 'synthetic-go-key',
  })

  await runner.execute('first', z.object({ ok: z.literal(true) }))
  assert.equal(runner.getLastInvocationMetadata()?.total_tokens, 6)
  await runner.execute('second', z.object({ ok: z.literal(true) }))
  assert.equal(runner.getLastInvocationMetadata()?.observed_model_id, 'mimo-v2.5')
  assert.equal(runner.getLastInvocationMetadata()?.total_tokens, null)
})

test('OpenCode Go makes one non-redirected request when the provider fails', async () => {
  let calls = 0
  let redirect: 'follow' | 'error' | 'manual' | undefined
  globalThis.fetch = (async (_input, init) => {
    calls += 1
    redirect = init?.redirect
    return new Response(JSON.stringify({ error: { message: 'provider failure' } }), { status: 500 })
  }) as typeof fetch
  const runner = new OpenCodeGoApiRunner('mimo-v2.5', {}, {
    credentialSource: 'explicit-test',
    explicitCredential: 'synthetic-go-key',
  })

  await assert.rejects(
    runner.executeRaw('respond'),
    (error: unknown) => error instanceof OpenCodeGoError && error.code === 'PROVIDER_FAILURE',
  )
  assert.equal(calls, 1)
  assert.equal(redirect, 'error')
})

test('OpenCode Go classifies authentication failure without switching provider', async () => {
  process.env['BABEL_DEEPINFRA_REQUEST_MAX_RETRIES'] = '1'
  globalThis.fetch = (async () => new Response(JSON.stringify({
    error: { message: 'unauthorized synthetic-provider-detail' },
  }), { status: 401 })) as typeof fetch
  const runner = new OpenCodeGoApiRunner('deepseek-v4-flash', {}, {
    credentialSource: 'explicit-test',
    explicitCredential: 'synthetic-go-key',
  })

  await assert.rejects(
    runner.executeRaw('respond'),
    (error: unknown) =>
      error instanceof OpenCodeGoError &&
      error.code === 'AUTH_FAILURE' &&
      error.cause === undefined &&
      !error.message.includes('synthetic-provider-detail'),
  )
  assert.equal(runner.getLastInvocationMetadata()?.provider, 'opencode-go')
})
