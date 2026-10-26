import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  isSyntheticProviderFixtureReady, prepareSyntheticProviderFixture,
  removeSyntheticProviderFixture, summarizeSyntheticProviderOutput,
} from '../testinfra/synthetic-provider-fixture.mjs'

if (!isSyntheticProviderFixtureReady()) {
  test('Command Code API contracts run without ambient credentials or network', async t => {
    const fixture = prepareSyntheticProviderFixture()
    t.after(() => removeSyntheticProviderFixture(fixture.root))
    const child = spawn(process.execPath, [
      '--import', new URL('../testinfra/synthetic-provider-fixture.mjs', import.meta.url).href,
      '--import', import.meta.resolve('tsx'), '--import', new URL('../testinfra/register-no-ambient-inference.mjs', import.meta.url).href,
      '--test', '--test-reporter=tap', fileURLToPath(import.meta.url),
    ], { cwd: fixture.cwd, env: fixture.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', chunk => { output += String(chunk) })
    child.stderr.on('data', chunk => { output += String(chunk) })
    const code = await new Promise<number>(resolve => {
      child.once('error', () => resolve(1))
      child.once('close', value => resolve(value ?? 1))
    })
    t.diagnostic(summarizeSyntheticProviderOutput(output, code))
    assert.equal(code, 0, 'isolated Command Code contracts must pass')
  })
} else {
  const { z } = await import('zod')
  const { ProviderEngine } = await import('./providerEngine.js')
  const { CommandCodeApiRunner } = await import('./commandCodeApi.js')
  const { getProviderSpec, isProviderId } = await import('./providerRegistry.js')
  const { getProviderCredentialStatus } = await import('./credentialHub.js')
  const { resolveChatModelPolicy } = await import('../agent/chatModelPolicy.js')
  const { resolveChatDeliberationRunner, resolveChatSynthesisRunner, resolveChatFallbackRunner, resolveChatFallbackOrFail } = await import('../agent/chatEngineProviderRuntime.js')
  const { ChatEngine } = await import('../agent/chatEngine.js')
  const { resolveOrCreateCriticRunner, resolveOrCreateCriticProRunner } = await import('../agent/chatEngineCriticBudget.js')
  const model = 'deepseek/deepseek-v4.1-flash'
  const backendKey = 'command-code/deepseek-v4.1-flash'
  const credential = 'synthetic-command-code-credential'
  const originalFetch = globalThis.fetch
  process.env['COMMAND_CODE_API_KEY'] = credential
  test.afterEach(() => { globalThis.fetch = originalFetch })
  const runner = () => new ProviderEngine({ provider: 'command-code', modelId: model, sampling: { maxTokens: 128 }, env: { COMMAND_CODE_API_KEY: credential } })
  const buffered = (observedModel = model, usage: Record<string, number> = { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 }) =>
    new Response(JSON.stringify({ model: observedModel, choices: [{ message: { content: '{"ok":true}' } }], usage }))
  const sse = (delta: object) => new Response(`data: ${JSON.stringify({ model, choices: [{ delta, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 } })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })

  test('registers Command Code with its own credential and native operation capability', () => {
    assert.equal(isProviderId('command-code'), true)
    assert.equal(getProviderSpec('command-code').credentialEnvVar, 'COMMAND_CODE_API_KEY')
    assert.equal(getProviderSpec('command-code').operations.includes('native_tool_stream'), true)
    assert.deepEqual(getProviderCredentialStatus('command-code', {}), { provider: 'command-code', envVar: 'COMMAND_CODE_API_KEY', configured: false, required: true })
  })

  test('missing Command Code credentials never borrow another provider key or dispatch', () => {
    let dispatches = 0
    globalThis.fetch = async () => { dispatches++; return buffered() }
    assert.throws(() => new ProviderEngine({ provider: 'command-code', modelId: model, env: { OPENROUTER_API_KEY: 'synthetic-other' } }), /COMMAND_CODE_API_KEY/)
    assert.equal(dispatches, 0)
  })

  test('structured requests use the Command Code endpoint, key and truthful accounting', async () => {
    let url = ''
    let authenticated = false
    let maxTokens: unknown
    let redirect: unknown
    globalThis.fetch = async (input, init) => {
      url = String(input)
      authenticated = new Headers(init?.headers).get('Authorization') === `Bearer ${credential}`
      maxTokens = JSON.parse(String(init?.body)).max_tokens
      redirect = init?.redirect
      return buffered()
    }
    const api = runner()
    assert.deepEqual(await api.execute('Reply with JSON', z.object({ ok: z.literal(true) })), { ok: true })
    assert.equal(url, 'https://api.commandcode.ai/provider/v1/chat/completions')
    assert.equal(authenticated, true)
    assert.equal(maxTokens, 128)
    assert.equal(redirect, 'error')
    assert.equal(api.getLastInvocationMetadata()?.provider, 'command-code')
    assert.equal(api.getLastInvocationMetadata()?.observed_model_id, model)
    assert.equal(api.getLastInvocationMetadata()?.cost_precision, 'conservative')
  })

  test('native tool proposal and tool-result continuation share the same API route', async () => {
    const api = runner()
    let calls = 0
    let sawToolResult = false
    globalThis.fetch = async (_input, init) => {
      calls++
      const body = JSON.parse(String(init?.body))
      sawToolResult ||= body.messages.some((message: { role: string; content: string }) => message.role === 'tool' && message.content === '5')
      return calls === 1 ? sse({ tool_calls: [{ index: 0, id: 'call-add', type: 'function', function: { name: 'add_numbers', arguments: '{"a":2,"b":3}' } }] }) : sse({ content: 'TOOL_OK_5' })
    }
    const first = []
    for await (const event of api.executeWithToolsStream([{ role: 'user', content: 'Add' }], [])) first.push(event)
    assert.ok(first.some(event => event.type === 'tool_use' && event.name === 'add_numbers'))
    const second = []
    for await (const event of api.executeWithToolsStream([
      { role: 'user', content: 'Add' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'call-add', type: 'function', function: { name: 'add_numbers', arguments: '{"a":2,"b":3}' } }] },
      { role: 'tool', content: '5', tool_call_id: 'call-add' },
    ], [])) second.push(event)
    assert.equal(sawToolResult, true)
    assert.ok(second.some(event => event.type === 'text_delta' && event.text === 'TOOL_OK_5'))
    assert.equal(api.getLastInvocationMetadata()?.provider, 'command-code')
  })

  test('a substituted response model is rejected', async () => {
    globalThis.fetch = async () => buffered('another-model')
    await assert.rejects(runner().executeRaw('Reply'), /model.*(mismatch|expected|requested)/i)
  })

  test('explicit Chat selection pins all stages while default selection remains available', () => {
    const { policy } = resolveChatModelPolicy({ model: backendKey })
    assert.equal(policy.provider, 'command-code')
    assert.equal(policy.providerModelId, model)
    assert.ok(policy.stagePolicies.every(stage => stage.primaryProvider === 'command-code' && stage.orderedBackends.every(backend => backend.provider === 'command-code' && backend.providerModelId === model)))
    assert.equal(resolveChatModelPolicy({}).policy.provider, 'openrouter')
  })

  test('offline selection rejects the remote Command Code API route', () => {
    const previous = process.env['BABEL_OFFLINE']
    process.env['BABEL_OFFLINE'] = '1'
    try {
      assert.throws(() => resolveChatModelPolicy({ model: backendKey }), /Command Code.*offline/i)
    } finally {
      if (previous === undefined) delete process.env['BABEL_OFFLINE']
      else process.env['BABEL_OFFLINE'] = previous
    }
  })

  test('actual embedded ChatEngine always binds its Command Code critic provider', () => {
    const { policy } = resolveChatModelPolicy({ model: backendKey })
    const selected = new CommandCodeApiRunner(model, { maxTokens: 128 })
    const previous = process.env['BABEL_OFFLINE']
    process.env['BABEL_OFFLINE'] = '1'
    try {
      const engine = new ChatEngine({ task: 'Inspect the supplied fixture.', projectRoot: process.env['BABEL_PROJECT_ROOT']!, model: backendKey, providerRunner: selected, providerPolicy: policy })
      const host = engine as unknown as { activeSubmissionGeneration: number; criticState(onThought: undefined, generation: number): { primaryProvider?: string; primaryModel?: string } }
      const state = host.criticState(undefined, host.activeSubmissionGeneration)
      assert.throws(() => host.criticState(undefined, host.activeSubmissionGeneration + 1), /retired submission/)
      assert.equal(state.primaryProvider, 'command-code')
      assert.equal(resolveOrCreateCriticRunner(state.primaryModel!, null, () => selected, state.primaryProvider).runner, selected)
    } finally {
      if (previous === undefined) delete process.env['BABEL_OFFLINE']
      else process.env['BABEL_OFFLINE'] = previous
    }
  })

  test('deliberation and synthesis both construct Command Code runners', async () => {
    const { policy } = resolveChatModelPolicy({ model: backendKey })
    globalThis.fetch = async () => buffered()
    for (const factory of [resolveChatDeliberationRunner, resolveChatSynthesisRunner]) {
      const api = factory(null, policy)
      await api.executeRaw('Reply')
      assert.equal(api.getLastInvocationMetadata()?.provider, 'command-code')
    }
    assert.equal(resolveChatFallbackRunner(null, {}, policy), null)
  })

  test('cached runners from another provider or model cannot override a selected Command Code route', async () => {
    const { OpenRouterApiRunner } = await import('./openRouterApi.js')
    const { policy } = resolveChatModelPolicy({ model: backendKey })
    globalThis.fetch = async () => buffered()
    for (const factory of [resolveChatDeliberationRunner, resolveChatSynthesisRunner]) {
      for (const cached of [new OpenRouterApiRunner(model), new CommandCodeApiRunner('other-model')]) {
        const selected = factory(cached, policy)
        await selected.executeRaw('Reply')
        assert.equal(selected.getLastInvocationMetadata()?.provider, 'command-code')
        assert.equal(selected.getLastInvocationMetadata()?.requested_model_id, model)
      }
    }
  })

  test('a Command Code failure never invokes cross-provider failover', async () => {
    const { policy } = resolveChatModelPolicy({ model: backendKey })
    let fallbackCalls = 0
    const events = resolveChatFallbackOrFail({ err: new Error('HTTP 503'), turn: 0, ownerGeneration: 1, options: { model: backendKey }, modelPolicy: policy, isSubmissionCurrent: () => true, cancelled: () => null, failed: error => ({ type: 'failed', error }), tryFailover: () => { fallbackCalls++; return null }, resolveFallback: () => { fallbackCalls++; return null }, installFailover: () => {} })
    const first = await events.next()
    assert.equal(first.done, false)
    if (first.done) assert.fail('provider failure must be emitted')
    assert.equal(first.value.type, 'failed')
    assert.equal(fallbackCalls, 0)
  })

  test('critic phases reuse the selected Command Code runner', () => {
    const { policy } = resolveChatModelPolicy({ model: backendKey })
    const selected = resolveChatDeliberationRunner(null, policy)
    assert.equal(resolveOrCreateCriticRunner('unrelated-model', null, () => selected, 'command-code').runner, selected)
    assert.equal(resolveOrCreateCriticProRunner('unrelated-model', null, () => selected, 'command-code').runner, selected)
  })

  test('absent provider usage stays unknown despite published pricing', async () => {
    globalThis.fetch = async () => buffered(model, {})
    const api = runner()
    await api.executeRaw('Reply')
    assert.equal(api.getLastInvocationMetadata()?.cost_precision, 'unknown')
    assert.equal(api.getLastInvocationMetadata()?.estimated_cost_usd, null)
  })

  test('actual ChatEngine still denies credential reads proposed by Command Code', async () => {
    const { policy } = resolveChatModelPolicy({ model: backendKey })
    let dispatches = 0
    let deniedResultDelivered = false
    let executions = 0
    globalThis.fetch = async (_input, init) => {
      dispatches++
      const body = JSON.parse(String(init?.body))
      deniedResultDelivered ||= body.messages.some((message: { role: string; content: string }) => message.role === 'tool' && /denied|protected_path|credential/i.test(message.content))
      return dispatches === 1 ? sse({ tool_calls: [{ index: 0, id: 'call-denied', type: 'function', function: { name: 'read_file', arguments: '{"path":".env"}' } }] }) : sse({ content: 'Credential access was denied.' })
    }
    const engine = new ChatEngine({ task: 'Report whether you can read the requested file.', projectRoot: process.env['BABEL_PROJECT_ROOT']!, providerRunner: new CommandCodeApiRunner(model, { maxTokens: 128 }), providerPolicy: policy, model: backendKey, operation: 'READ_ONLY', maxTurns: 3, runtimeMode: 'direct', toolExecutorForTesting: { mapAction: () => [], execute: async action => { executions++; return { action, terminal: false, results: [{ exit_code: 0, stdout: 'unexpected', stderr: '' }] } } } })
    await engine.submitMessage('Read .env if permitted, otherwise explain the denial.', {})
    assert.equal(executions, 0)
    assert.equal(deniedResultDelivered, true)
    assert.ok(dispatches >= 2)
  })
}
