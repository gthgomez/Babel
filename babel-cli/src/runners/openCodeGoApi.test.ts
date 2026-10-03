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
    'deepseek-v4.1-flash',
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

test('exact V4.1 refuses missing shared budget before resolving a credential', () => {
  assert.throws(() => new OpenCodeGoApiRunner('deepseek-v4.1-flash', { maxTokens: 32 }, { credentialSource: 'explicit-test', explicitCredential: 'synthetic' }), /budget/i)
})

test('Go budget persists reservations and rejects contention, exhaustion and job reuse', async (t) => {
  const { mkdtemp, readFile, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { OpenCodeGoBudget } = await import('./openCodeGoBudget.js')
  const dir = await mkdtemp(join(tmpdir(), 'synthetic-go-budget-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'usage.json')
  const a = new OpenCodeGoBudget({ statePath: path, jobId: 'synthetic-job', limitUsd: 0.000002 })
  const b = new OpenCodeGoBudget({ statePath: path, jobId: 'synthetic-job', limitUsd: 0.000002 })
  await a.reserve(1, 1)
  await assert.rejects(b.reserve(1, 1), /budget/i)
  const state = JSON.parse(await readFile(path, 'utf8'))
  assert.equal(state.reservedNanoUsd, 1500)
  assert.equal(state.attempts, 1)
  await assert.rejects(new OpenCodeGoBudget({ statePath: path, jobId: 'different-job', limitUsd: 0.000002 }).reserve(1, 1), /budget/i)
  await writeFile(path + '.lock', 'synthetic-lock')
  await assert.rejects(a.reserve(1, 1), /budget/i)
  assert.equal(await readFile(path + '.lock', 'utf8'), 'synthetic-lock')
  assert.throws(() => new OpenCodeGoBudget({ statePath: path, jobId: 'job', limitUsd: 2.01 }), /budget/i)
})

test('V4.1 reserves exact body cost for every operation and never refunds unknown or cancelled usage', async (t) => {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { OpenCodeGoBudget } = await import('./openCodeGoBudget.js')
  const dir = await mkdtemp(join(tmpdir(), 'synthetic-go-operations-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'usage.json')
  const budget = new OpenCodeGoBudget({ statePath: path, jobId: 'job', limitUsd: 2 })
  const runner = new OpenCodeGoApiRunner('deepseek-v4.1-flash', { maxTokens: 16 }, { budget, credentialSource: 'explicit-test', explicitCredential: 'synthetic-placeholder', benchmarkRunId: 'stable-job' })
  let expected = 0
  let fail = false
  const sessions: string[] = []
  globalThis.fetch = (async (url, init) => {
    assert.equal(url, `${OPENCODE_GO_BASE_URL}/chat/completions`)
    assert.equal(init?.redirect, 'error')
    const serialized = String(init?.body)
    expected += Buffer.byteLength(serialized, 'utf8') * 300 + 16 * 1200
    const state = JSON.parse(await readFile(path, 'utf8'))
    assert.equal(state.reservedNanoUsd, expected, 'reservation must precede network dispatch')
    sessions.push((init?.headers as Record<string, string>)['x-opencode-session'] ?? '')
    assert.equal(state.jobId, 'job')
    assert.equal(JSON.stringify(state).includes('synthetic-placeholder'), false)
    assert.equal(JSON.stringify(state).includes('秘密'), false)
    if (fail) throw new DOMException('synthetic cancelled', 'AbortError')
    const body = JSON.parse(serialized)
    if (body.stream) return new Response(`data: ${JSON.stringify({ model: 'deepseek-v4.1-flash', choices: [{ delta: { content: 'answer' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
    return new Response(JSON.stringify({ model: 'deepseek-v4.1-flash', choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }], ...(sessions.length === 1 ? { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } : {}) }))
  }) as typeof fetch
  await runner.execute('秘密', z.object({ ok: z.literal(true) }))
  await runner.executeRaw('秘密')
  for await (const _chunk of runner.executeRawStream('秘密')) { /* consume */ }
  for await (const _event of runner.executeWithToolsStream([{ role: 'user', content: '秘密' }], [])) { /* consume */ }
  fail = true
  await assert.rejects(runner.executeRaw('秘密'))
  const state = JSON.parse(await readFile(path, 'utf8'))
  assert.equal(state.attempts, 5)
  assert.equal(state.reservedNanoUsd, expected)
  assert.deepEqual(sessions, Array(5).fill('stable-job'))
})

test('shared Go ledger prevents overspend across runner instances without network retry', async (t) => {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { OpenCodeGoBudget } = await import('./openCodeGoBudget.js')
  const dir = await mkdtemp(join(tmpdir(), 'synthetic-go-shared-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const statePath = join(dir, 'usage.json')
  const options = { statePath, jobId: 'same-job', limitUsd: 0.0002 }
  const a = new OpenCodeGoApiRunner('deepseek-v4.1-flash', { maxTokens: 32 }, { budget: new OpenCodeGoBudget(options), credentialSource: 'explicit-test', explicitCredential: 'synthetic' })
  const b = new OpenCodeGoApiRunner('deepseek-v4.1-flash', { maxTokens: 32 }, { budget: new OpenCodeGoBudget(options), credentialSource: 'explicit-test', explicitCredential: 'synthetic' })
  let calls = 0
  globalThis.fetch = (async () => { calls++; return new Response('synthetic failure', { status: 500 }) }) as typeof fetch
  const results = await Promise.allSettled([a.executeRaw('x'), b.executeRaw('x')])
  assert.equal(results.every(x => x.status === 'rejected'), true)
  assert.equal(calls, 1)
  assert.equal(JSON.parse(await readFile(statePath, 'utf8')).attempts, 1)
  await assert.rejects(b.executeRaw('x'))
  assert.equal(calls, 1)
})

test('Go transport forwards execution envelope without weakening gateway binding', async () => {
  const { OpenCodeGoBudget } = await import('./openCodeGoBudget.js')
  assert.throws(() => new OpenCodeGoApiRunner('deepseek-v4.1-flash', { maxTokens: 16 }, {
    budget: new OpenCodeGoBudget({ statePath: '/tmp/synthetic-unused-ledger.json', jobId: 'unused', limitUsd: 2 }),
    credentialSource: 'explicit-test', explicitCredential: 'synthetic',
    executionEnvelope: { provider: { gateway: 'deepinfra' } } as never,
  }), /gateway.*does not match/)
})

test('Go validates pinned request before any reservation or dispatch', async (t) => {
  const { mkdtemp, access, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { OpenCodeGoBudget } = await import('./openCodeGoBudget.js')
  const dir = await mkdtemp(join(tmpdir(), 'synthetic-go-invalid-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'budget.json')
  class Probe extends OpenCodeGoApiRunner { send(url: string, init: RequestInit): Promise<Response> { return this.dispatchFetch(url, init) } }
  const runner = new Probe('deepseek-v4.1-flash', { maxTokens: 16 }, { budget: new OpenCodeGoBudget({ statePath: path, jobId: 'job', limitUsd: 2 }), credentialSource: 'explicit-test', explicitCredential: 'synthetic' })
  globalThis.fetch = (async () => { throw new Error('invalid request reached network') }) as typeof fetch
  const endpoint = `${OPENCODE_GO_BASE_URL}/chat/completions`
  const valid = { method: 'POST', redirect: 'error' as const, body: JSON.stringify({ model: 'deepseek-v4.1-flash', max_tokens: 16 }) }
  await assert.rejects(runner.send('https://opencode.ai/zen/v1/chat/completions', valid))
  for (const body of [{ model: 'deepseek-v4-flash', max_tokens: 16 }, { model: 'deepseek-v4.1-flash' }, { model: 'deepseek-v4.1-flash', max_tokens: 17 }, { model: 'deepseek-v4.1-flash', max_tokens: -1 }]) {
    await assert.rejects(runner.send(endpoint, { ...valid, body: JSON.stringify(body) }))
  }
  await assert.rejects(runner.send(endpoint, { ...valid, redirect: 'follow' }))
  await assert.rejects(access(path))
})

test('Go ledger shares a durable reservation with another process', async (t) => {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const { OpenCodeGoBudget } = await import('./openCodeGoBudget.js')
  const dir = await mkdtemp(join(tmpdir(), 'synthetic-go-process-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const statePath = join(dir, 'budget.json')
  const options = { statePath, jobId: 'same-job', limitUsd: 0.000002 }
  const moduleUrl = new URL('./openCodeGoBudget.ts', import.meta.url).href
  const script = `import { OpenCodeGoBudget } from ${JSON.stringify(moduleUrl)}; await new OpenCodeGoBudget(${JSON.stringify(options)}).reserve(1,1)`
  await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], { cwd: new URL('../../', import.meta.url) })
  await assert.rejects(new OpenCodeGoBudget(options).reserve(1, 1))
  const state = JSON.parse(await readFile(statePath, 'utf8'))
  assert.equal(state.reservedNanoUsd, 1500)
  assert.equal(state.attempts, 1)
  const concurrentOptions = { ...options, statePath: join(dir, 'concurrent.json') }
  const concurrentScript = `import { OpenCodeGoBudget } from ${JSON.stringify(moduleUrl)}; await new OpenCodeGoBudget(${JSON.stringify(concurrentOptions)}).reserve(1,1)`
  const children = await Promise.allSettled(Array.from({ length: 2 }, () => promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', concurrentScript], { cwd: new URL('../../', import.meta.url) })))
  assert.equal(children.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(JSON.parse(await readFile(concurrentOptions.statePath, 'utf8')).attempts, 1)
})

test('Go does not dispatch or debit a request cancelled before entry', async (t) => {
  const { mkdtemp, access, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { OpenCodeGoBudget } = await import('./openCodeGoBudget.js')
  const dir = await mkdtemp(join(tmpdir(), 'synthetic-go-aborted-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'budget.json')
  const runner = new OpenCodeGoApiRunner('deepseek-v4.1-flash', { maxTokens: 16 }, { budget: new OpenCodeGoBudget({ statePath: path, jobId: 'job', limitUsd: 2 }), credentialSource: 'explicit-test', explicitCredential: 'synthetic' })
  let calls = 0
  globalThis.fetch = (async () => { calls++; throw Error('cancelled request reached network') }) as typeof fetch
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(runner.executeRaw('synthetic', undefined, undefined, controller.signal))
  assert.equal(calls, 0)
  await assert.rejects(access(path))
})
