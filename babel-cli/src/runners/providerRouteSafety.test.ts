import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { ProviderInvocationCompleted, ToolStreamEvent } from './base.js'
import {
  isSyntheticProviderFixtureReady, prepareSyntheticProviderFixture,
  removeSyntheticProviderFixture, summarizeSyntheticProviderOutput,
} from '../testinfra/synthetic-provider-fixture.mjs'

if (!isSyntheticProviderFixtureReady()) {
  test('provider route safety runs with isolated credentials and blocked network', async t => {
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
    const summary = summarizeSyntheticProviderOutput(output, code)
    t.diagnostic(summary)
    assert.equal(code, 0, summary)
    assert.ok(JSON.parse(summary).passed > 0, 'the isolated child must actually run the contracts')
  })
} else {
  const { ProviderEngine } = await import('./providerEngine.js')
  const { resolveChatModelPolicy } = await import('../agent/chatModelPolicy.js')
  const { resolveChatDeliberationRunner, resolveChatSynthesisRunner, resolveChatFallbackRunner } = await import('../agent/chatEngineProviderRuntime.js')
  const originalFetch = globalThis.fetch
  test.beforeEach(() => {
    process.env['BABEL_PROVIDER_REQUEST_MAX_RETRIES'] = '1'
    process.env['BABEL_PROVIDER_REQUEST_TIMEOUT_MS'] = '1000'
    process.env['BABEL_PROVIDER_STREAM_IDLE_TIMEOUT_MS'] = '80'
  })
  test.afterEach(() => { globalThis.fetch = originalFetch })

  const routes = [
    { provider: 'openrouter', model: 'deepseek/deepseek-v4.1-flash-1017', envVar: 'OPENROUTER_API_KEY', endpoint: 'https://openrouter.ai/api/v1/chat/completions' },
    { provider: 'command-code', model: 'deepseek/deepseek-v4.1-flash', envVar: 'COMMAND_CODE_API_KEY', endpoint: 'https://api.commandcode.ai/provider/v1/chat/completions' },
  ] as const
  const toolDelta = { tool_calls: [{ index: 0, id: 'call-fixture', type: 'function', function: { name: 'read_file', arguments: '{"path":"fixture.txt"}' } }] }
  const response = (model: string | null, delta: object, terminal = true): Response => new Response(
    `data: ${JSON.stringify({ ...(model ? { model } : {}), choices: [{ delta, finish_reason: 'tool_calls' }] })}\n\n${terminal ? 'data: [DONE]\n\n' : ''}`,
    { headers: { 'content-type': 'text/event-stream' } },
  )

  for (const route of routes) {
    const runner = () => new ProviderEngine({ provider: route.provider, modelId: route.model, env: { [route.envVar]: 'synthetic-route-credential' }, requireExactModelId: true })

    test(`${route.provider} explicit Chat stages invoke only the selected adapter and model with unknown usage preserved`, async () => {
      process.env[route.envVar] = 'synthetic-route-credential'
      const backend = route.provider === 'openrouter' ? 'deepseek-v4.1-flash-openrouter' : 'command-code/deepseek-v4.1-flash'
      const { policy } = resolveChatModelPolicy({ model: backend })
      const requests: Array<{ endpoint: string; model: string; authenticated: boolean }> = []
      globalThis.fetch = async (input, init) => {
        requests.push({ endpoint: String(input), model: JSON.parse(String(init?.body)).model,
          authenticated: new Headers(init?.headers).get('authorization') === 'Bearer synthetic-route-credential' })
        return new Response(JSON.stringify({ model: route.model, choices: [{ message: { content: 'fixture' }, finish_reason: 'stop' }] }))
      }
      for (const factory of [resolveChatDeliberationRunner, resolveChatSynthesisRunner]) {
        const api = factory(null, policy)
        assert.equal(await api.executeRaw('Inspect'), 'fixture')
        assert.equal(api.getLastInvocationMetadata()?.provider, route.provider)
        assert.equal(api.getLastInvocationMetadata()?.observed_model_id, route.model)
        assert.equal(api.getLastInvocationMetadata()?.total_tokens, null)
        assert.equal(api.getLastInvocationMetadata()?.estimated_cost_usd, null)
        assert.equal(api.getLastInvocationMetadata()?.cost_precision, 'unknown')
      }
      assert.deepEqual(requests, [0, 1].map(() => ({ endpoint: route.endpoint, model: route.model, authenticated: true })))
      assert.ok(policy.stagePolicies.every(stage => stage.orderedBackends.every(entry => entry.provider === route.provider && entry.providerModelId === route.model)))
      assert.equal(resolveChatFallbackRunner(null, {}, policy), null)
    })

    test(`${route.provider} missing credentials cannot borrow another provider credential`, () => {
      let requests = 0
      globalThis.fetch = async () => { requests++; return response(route.model, toolDelta) }
      assert.throws(() => new ProviderEngine({ provider: route.provider, modelId: route.model,
        env: route.provider === 'openrouter' ? { COMMAND_CODE_API_KEY: 'fixture-other-key' } : { OPENROUTER_API_KEY: 'fixture-other-key' },
      }), error => error instanceof Error && error.message.includes(route.envVar) && !error.message.includes('fixture-other-key'))
      assert.equal(requests, 0)
    })

    test(`${route.provider} admits a matching native tool response with exact request and receipt identity`, async () => {
      let endpoint = ''
      let sentModel = ''
      globalThis.fetch = async (input, init) => {
        endpoint = String(input)
        sentModel = JSON.parse(String(init?.body)).model
        return response(route.model, toolDelta)
      }
      const api = runner()
      const events: ToolStreamEvent[] = []
      const completed: ProviderInvocationCompleted[] = []
      for await (const event of api.executeWithToolsStream([{ role: 'user', content: 'Inspect' }], [], undefined, undefined, 'auto', {
        onInvocationCompleted: value => { completed.push(value) },
      })) events.push(event)
      assert.equal(endpoint, route.endpoint)
      assert.equal(sentModel, route.model)
      assert.deepEqual(events.map(event => event.type), ['tool_use', 'done'])
      assert.equal(completed.length, 1)
      assert.equal(completed[0]?.status, 'delivered')
      assert.equal(completed[0]?.provider, route.provider)
      assert.equal(completed[0]?.observed_model_id, route.model)
    })

    for (const status of [401, 429]) test(`${route.provider} HTTP ${status} fails on the selected route without credential leakage`, async () => {
      let requests = 0
      globalThis.fetch = async () => { requests++; return new Response(JSON.stringify({ error: { message: 'fixture rejection' } }), { status }) }
      const completed: ProviderInvocationCompleted[] = []
      const events: ToolStreamEvent[] = []
      for await (const event of runner().executeWithToolsStream([{ role: 'user', content: 'Inspect' }], [], undefined, undefined, 'auto', {
        onInvocationCompleted: value => { completed.push(value) },
      })) events.push(event)
      assert.deepEqual(events.map(event => event.type), ['error'])
      assert.equal(requests, 1)
      assert.equal(completed.length, 1)
      assert.equal(completed[0]?.status, 'failed')
      assert.equal(completed[0]?.provider, route.provider)
      assert.equal(completed[0]?.model, route.model)
      assert.equal(completed[0]?.failure_receipt?.http_status, status)
      assert.equal(JSON.stringify({ events, completed }).includes('synthetic-route-credential'), false)
    })

    test(`${route.provider} rate-limit recovery retries only the same exact route`, async () => {
      process.env['BABEL_PROVIDER_REQUEST_MAX_RETRIES'] = '2'
      const requests: Array<{ endpoint: string; model: string }> = []
      globalThis.fetch = async (input, init) => {
        requests.push({ endpoint: String(input), model: JSON.parse(String(init?.body)).model })
        return requests.length === 1
          ? new Response('fixture rate limit', { status: 429, headers: { 'retry-after': '0' } })
          : response(route.model, toolDelta)
      }
      const completed: ProviderInvocationCompleted[] = []
      const events: ToolStreamEvent[] = []
      for await (const event of runner().executeWithToolsStream([{ role: 'user', content: 'Inspect' }], [], undefined, undefined, 'auto', {
        onInvocationCompleted: value => { completed.push(value) },
      })) events.push(event)
      assert.deepEqual(requests, [0, 1].map(() => ({ endpoint: route.endpoint, model: route.model })))
      assert.deepEqual(events.map(event => event.type), ['tool_use', 'done'])
      assert.equal(completed.length, 1)
      assert.equal(completed[0]?.status, 'delivered')
    })

    test(`${route.provider} request timeout fails once without tool delivery or fallback`, async () => {
      process.env['BABEL_PROVIDER_REQUEST_TIMEOUT_MS'] = '40'
      let requests = 0
      globalThis.fetch = async (_input, init) => {
        requests++
        return new Promise<Response>((_resolve, reject) => {
          const cancel = () => reject(new DOMException('fixture timeout', 'AbortError'))
          if (init?.signal?.aborted) cancel()
          else init?.signal?.addEventListener('abort', cancel, { once: true })
        })
      }
      const completed: ProviderInvocationCompleted[] = []
      const events: ToolStreamEvent[] = []
      for await (const event of runner().executeWithToolsStream([{ role: 'user', content: 'Inspect' }], [], undefined, undefined, 'auto', {
        onInvocationCompleted: value => { completed.push(value) },
      })) events.push(event)
      assert.equal(requests, 1)
      assert.deepEqual(events.map(event => event.type), ['error'])
      assert.equal(completed.length, 1)
      assert.equal(completed[0]?.status, 'failed')
      assert.equal(completed[0]?.provider, route.provider)
      assert.equal(completed[0]?.failure_receipt?.failure_stage, 'request')
      assert.equal(completed[0]?.failure_receipt?.partial_model_output, false)
    })

    for (const failure of ['eof', 'reset', 'cancel', 'idle'] as const) test(`${route.provider} partial tool output plus ${failure} never emits executable tools or completion`, async () => {
      let requests = 0
      let bodyCancelled = false
      const abort = new AbortController()
      globalThis.fetch = async () => {
        requests++
        if (failure === 'eof') return response(route.model, toolDelta, false)
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ model: route.model, choices: [{ delta: { ...toolDelta, content: 'partial' } }] })}\n\n`))
          },
          pull(controller) { if (failure === 'reset') controller.error(new Error('fixture stream reset')) },
          cancel() { bodyCancelled = true },
        }))
      }
      const completed: ProviderInvocationCompleted[] = []
      const events: ToolStreamEvent[] = []
      for await (const event of runner().executeWithToolsStream([{ role: 'user', content: 'Inspect' }], [], undefined, abort.signal, 'auto', {
        onInvocationCompleted: value => { completed.push(value) },
      })) {
        events.push(event)
        // The buffered tool fragments remain unadmitted when cancellation arrives.
        if (failure === 'cancel' && event.type === 'text_delta') abort.abort()
      }
      assert.equal(requests, 1)
      assert.equal(events.some(event => event.type === 'error'), true)
      assert.equal(events.some(event => event.type === 'done' || event.type === 'tool_use'), false)
      assert.equal(completed.length, 1)
      assert.equal(completed[0]?.status, 'failed')
      assert.equal(completed[0]?.failure_receipt?.partial_model_output, true)
      assert.equal(completed[0]?.failure_receipt?.retryable, false)
      assert.equal(completed[0]?.failure_receipt?.tool_call_count, 1)
      if (failure === 'cancel' || failure === 'idle') assert.equal(bodyCancelled, true)
    })

    for (const observed of ['other-provider/model', null]) for (const payload of ['tools', 'text'] as const) for (const terminal of [false, true]) {
      test(`${route.provider} rejects ${observed === null ? 'missing' : 'substituted'} identity before emitting ${payload} completion (${terminal ? 'complete' : 'interrupted'} stream)`, async () => {
        let requests = 0
        globalThis.fetch = async () => { requests++; return response(observed, payload === 'tools' ? toolDelta : { content: 'unverified text' }, terminal) }
        const api = runner()
        const events: ToolStreamEvent[] = []
        const completed: ProviderInvocationCompleted[] = []
        const phases: string[] = []
        await assert.rejects(async () => {
          for await (const event of api.executeWithToolsStream([{ role: 'user', content: 'Inspect' }], [], undefined, undefined, 'auto', {
            onInvocationCompleted: value => { completed.push(value) },
            onInvocationPhase: value => { phases.push(value.phase) },
          })) events.push(event)
        }, /model|identity/i)
        assert.deepEqual(events.filter(event => event.type === 'tool_use' || event.type === 'done').map(event => event.type), [])
        assert.equal(phases.includes('response_normalized'), false)
        assert.equal(completed.length, 1)
        assert.equal(completed[0]?.status, 'failed')
        assert.equal(completed[0]?.failure_receipt?.failure_stage, terminal ? 'response_normalization' : 'stream')
        assert.equal(api.getLastInvocationMetadata()?.observed_model_id, observed)
        assert.equal(api.getLastInvocationMetadata()?.sent_model_id, route.model)
        assert.equal(requests, 1)
      })
    }
  }
}
