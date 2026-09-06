import assert from 'node:assert/strict'
import test from 'node:test'
import { z } from 'zod'
import {
  OPENCODE_DEFAULT_BASE_URL,
  OpenCodeApiRunner,
} from './openCodeApi.js'
import { OpenCodeGoApiRunner, OPENCODE_GO_DEFAULT_BASE_URL, OpenCodeGoError } from '../claude-babel-astra-lab/openCodeGoApi.js'
import { resolveOpenCodeGoCredential, OpenCodeGoCredentialError } from '../claude-babel-astra-lab/credentialResolver.js'
import { homedir } from 'node:os'
import { join } from 'node:path'

const originalFetch = globalThis.fetch

test.afterEach(() => {
  globalThis.fetch = originalFetch
  delete process.env['BABEL_OPENCODE_BASE_URL']
  delete process.env['BABEL_OPENCODE_GO_BASE_URL']
  delete process.env['BABEL_DEEPINFRA_REQUEST_TIMEOUT_MS']
  delete process.env['BABEL_DEEPINFRA_REQUEST_MAX_RETRIES']
})

test('OpenCode Zen uses the declared credential variable and sampling body', async () => {
  let observedUrl = ''
  let observedAuthorization = ''
  let observedBody: Record<string, unknown> = {}
  globalThis.fetch = (async (input, init) => {
    observedUrl = String(input)
    observedAuthorization = String((init?.headers as Record<string, string>)?.Authorization ?? '')
    observedBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    return new Response(
      JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }),
      { status: 200 },
    )
  }) as typeof fetch

  const runner = new OpenCodeApiRunner(
    'x-preview-f-free',
    { maxTokens: 321, temperature: 0.25 },
    { apiKeyEnvVar: 'CUSTOM_OPENCODE_KEY', env: { CUSTOM_OPENCODE_KEY: 'synthetic-zen-key' } },
  )
  const result = await runner.execute('respond', z.object({ ok: z.literal(true) }))

  assert.deepEqual(result, { ok: true })
  assert.equal(observedUrl, `${OPENCODE_DEFAULT_BASE_URL}/chat/completions`)
  assert.equal(observedAuthorization, 'Bearer synthetic-zen-key')
  assert.equal(observedBody.model, 'x-preview-f-free')
  assert.equal(observedBody.max_tokens, 321)
  assert.equal(observedBody.temperature, 0.25)
})

test('OpenCodeApiRunner respects BABEL_OPENCODE_BASE_URL', async () => {
  let observedUrl = ''
  globalThis.fetch = (async (input) => {
    observedUrl = String(input)
    return new Response(
      JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }),
      { status: 200 },
    )
  }) as typeof fetch

  process.env['BABEL_OPENCODE_BASE_URL'] = 'https://zen-proxy.example.internal/v1/'
  const runner = new OpenCodeApiRunner(
    'x-preview-f-free',
    {},
    { explicitCredential: 'synthetic-zen-key' },
  )
  await runner.execute('respond', z.object({ ok: z.literal(true) }))

  assert.equal(observedUrl, 'https://zen-proxy.example.internal/v1/chat/completions')
})

test('OpenCode Go credential resolver uses the approved helper source in memory', () => {
  let invoked = false
  const resolution = resolveOpenCodeGoCredential({
    source: 'opencode-auth-helper',
    helperPath: join(homedir(), '.claude', 'get-auth-token.js'),
    execFileSyncImpl: ((file: string, args?: readonly string[]) => {
      invoked = file === process.execPath && args?.[0] === join(homedir(), '.claude', 'get-auth-token.js')
      return 'synthetic-helper-credential\n'
    }) as never,
  })
  assert.equal(invoked, true)
  assert.equal(resolution.authStatus, 'PRESENT')
  assert.equal(resolution.credentialSource, 'opencode-auth-helper')
  assert.equal(resolution.credential, 'synthetic-helper-credential')
})

test('OpenCode Go credential resolver redacts helper failures', () => {
  assert.throws(
    () => resolveOpenCodeGoCredential({
      source: 'opencode-auth-helper',
      helperPath: join(homedir(), '.claude', 'get-auth-token.js'),
      execFileSyncImpl: (() => { throw Object.assign(new Error('helper failed: secret-value'), { status: 7, stderr: 'secret-value' }) }) as never,
    }),
    (error: unknown) => {
      assert.equal(error instanceof OpenCodeGoCredentialError, true)
      assert.equal((error as Error).message.includes('secret-value'), false)
      assert.deepEqual((error as OpenCodeGoCredentialError).diagnostic, {
        helper_present: true,
        exit_code: 7,
        stderr_present: true,
        timed_out: false,
      })
      return true
    },
  )
})

test('OpenCode Go benchmark source does not fall back to an unrelated environment key', () => {
  process.env['OPENCODE_API_KEY'] = 'unrelated-env-value'
  try {
    assert.throws(
      () => resolveOpenCodeGoCredential({ source: 'opencode-auth-helper', helperPath: 'C:\\missing\\get-auth-token.js' }),
      (error: unknown) => error instanceof OpenCodeGoCredentialError && error.code === 'AUTH_FAILURE',
    )
  } finally {
    delete process.env['OPENCODE_API_KEY']
  }
})

test('OpenCode Go pins the exact model, route, session, usage, and provider identity', async () => {
  let observedUrl = ''
  let observedBody: Record<string, unknown> = {}
  let observedSession = ''
  globalThis.fetch = (async (input, init) => {
    observedUrl = String(input)
    const headers = init?.headers as Record<string, string>
    observedSession = headers['x-opencode-session'] ?? ''
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
    benchmarkRunId: 'run-test-1',
  })
  const result = await runner.execute('respond', z.object({ ok: z.literal(true) }))

  assert.deepEqual(result, { ok: true })
  assert.equal(observedUrl, `${OPENCODE_GO_DEFAULT_BASE_URL}/chat/completions`)
  assert.equal(observedBody.model, 'mimo-v2.5')
  assert.match(observedSession, /^run-test-1-[0-9a-f-]{36}$/)
  assert.equal(runner.getLastOpenCodeSessionId(), observedSession)
  assert.equal(runner.getLastInvocationMetadata()?.provider, 'opencode-go')
  assert.equal(runner.getLastInvocationMetadata()?.observed_model_id, 'mimo-v2.5')
  assert.equal(runner.getLastInvocationMetadata()?.total_tokens, 18)
})

test('OpenCode Go rejects unknown or substituted models without fallback', async () => {
  assert.throws(
    () => new OpenCodeGoApiRunner('glm-5.3-flash', {}, { credentialSource: 'explicit-test', explicitCredential: 'synthetic-go-key' }),
    (error: unknown) => error instanceof OpenCodeGoError && error.code === 'MODEL_UNAVAILABLE',
  )
  let calls = 0
  globalThis.fetch = (async () => {
    calls += 1
    return new Response(JSON.stringify({ model: 'longcat-2.0', choices: [{ message: { content: '{"ok":true}' } }] }), { status: 200 })
  }) as typeof fetch
  const runner = new OpenCodeGoApiRunner('mimo-v2.5', {}, { credentialSource: 'explicit-test', explicitCredential: 'synthetic-go-key' })
  await assert.rejects(
    runner.execute('respond', z.object({ ok: z.literal(true) })),
    (error: unknown) => error instanceof OpenCodeGoError && error.code === 'MODEL_ATTRIBUTION_FAILURE',
  )
  assert.equal(calls, 1)
})

test('OpenCode Go classifies auth and quota failures and never switches provider', async () => {
  process.env['BABEL_DEEPINFRA_REQUEST_MAX_RETRIES'] = '1'
  const statuses = [401, 429]
  for (const status of statuses) {
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: { message: status === 401 ? 'unauthorized' : 'quota exhausted' } }), { status })) as typeof fetch
    const runner = new OpenCodeGoApiRunner('mimo-v2.5', {}, { credentialSource: 'explicit-test', explicitCredential: 'synthetic-go-key' })
    await assert.rejects(
      runner.executeRaw('respond'),
      (error: unknown) => error instanceof OpenCodeGoError && error.code === (status === 401 ? 'AUTH_FAILURE' : 'GO_QUOTA_EXHAUSTED'),
    )
    assert.equal(runner.getLastInvocationMetadata()?.provider, 'opencode-go')
  }
})

test('OpenCode Go classifies timeout and external cancellation', async () => {
  process.env['BABEL_DEEPINFRA_REQUEST_MAX_RETRIES'] = '1'
  globalThis.fetch = (async (_input, init) => await new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
  })) as typeof fetch
  const timeoutRunner = new OpenCodeGoApiRunner('mimo-v2.5', {}, { credentialSource: 'explicit-test', explicitCredential: 'synthetic-go-key', requestTimeoutMs: 10 })
  await assert.rejects(timeoutRunner.executeRaw('respond'), (error: unknown) => error instanceof OpenCodeGoError && error.code === 'TIMEOUT')

  const controller = new AbortController()
  const cancelRunner = new OpenCodeGoApiRunner('mimo-v2.5', {}, { credentialSource: 'explicit-test', explicitCredential: 'synthetic-go-key' })
  const pending = cancelRunner.executeRaw('respond', undefined, undefined, controller.signal)
  controller.abort()
  await assert.rejects(pending, (error: unknown) => error instanceof OpenCodeGoError && (error.code === 'ABORTED' || error.code === 'TIMEOUT'))
})

test('OpenCode Go tool-use certification preserves tools, exact model, and session attribution', async () => {
  let observedBody: Record<string, unknown> = {}
  let observedSession = ''
  globalThis.fetch = (async (_input, init) => {
    observedBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    observedSession = String((init?.headers as Record<string, string>)['x-opencode-session'] ?? '')
    const sse = [
      `data: ${JSON.stringify({ model: 'mimo-v2.5', choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'read_fixture', arguments: '{"path":"README.md"}' } }] }, finish_reason: 'tool_calls' }] })}`,
      `data: ${JSON.stringify({ model: 'mimo-v2.5', usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 } })}`,
      'data: [DONE]',
      '',
    ].join('\n')
    return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }) as typeof fetch

  const runner = new OpenCodeGoApiRunner('mimo-v2.5', {}, {
    credentialSource: 'explicit-test',
    explicitCredential: 'synthetic-go-key',
    benchmarkRunId: 'tool-cert-1',
  })
  const events = []
  for await (const event of runner.executeWithToolsStream!([
    { role: 'user', content: 'Use the fixture reader.' },
  ], [{
    type: 'function',
    function: { name: 'read_fixture', description: 'Read one fixture file.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  }], undefined, undefined, 'required')) {
    events.push(event)
  }
  assert.equal((observedBody.model), 'mimo-v2.5')
  assert.equal((observedBody.tool_choice), 'required')
  assert.equal(Array.isArray(observedBody.tools), true)
  assert.match(observedSession, /^tool-cert-1-[0-9a-f-]{36}$/)
  assert.deepEqual(events.find((event) => event.type === 'tool_use'), {
    type: 'tool_use', id: 'call-1', name: 'read_fixture', input: { path: 'README.md' },
  })
  assert.equal(events.at(-1)?.type, 'done')
  assert.equal(runner.getLastInvocationMetadata()?.provider, 'opencode-go')
  assert.equal(runner.getLastInvocationMetadata()?.observed_model_id, 'mimo-v2.5')
})
