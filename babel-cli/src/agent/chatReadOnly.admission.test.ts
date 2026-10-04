import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import type { OpenCodeGoBudget } from '../runners/openCodeGoBudget.js'
import {
  isSyntheticProviderFixtureReady, prepareSyntheticProviderFixture,
  removeSyntheticProviderFixture, summarizeSyntheticProviderOutput,
} from '../testinfra/synthetic-provider-fixture.mjs'

if (!isSyntheticProviderFixtureReady()) {
  test('ordinary no-change admission contracts execute in a synthetic-only subprocess', async t => {
    const fixture = prepareSyntheticProviderFixture()
    const child = spawn(process.execPath, [
      '--import', new URL('../testinfra/synthetic-provider-fixture.mjs', import.meta.url).href,
      '--import', import.meta.resolve('tsx'), '--test-reporter=tap', '--test', fileURLToPath(import.meta.url),
    ], { cwd: fixture.cwd, env: fixture.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', chunk => { output += String(chunk) })
    child.stderr.on('data', chunk => { output += String(chunk) })
    const code = await new Promise<number>(resolve => {
      child.once('error', () => resolve(1))
      child.once('close', value => resolve(value ?? 1))
    })
    const diagnostic = summarizeSyntheticProviderOutput(output, code)
    t.diagnostic(diagnostic)
    assert.equal(code, 0, 'isolated ordinary-admission regressions must pass')
    const inventory = JSON.parse(diagnostic) as { tests: number; passed: number; failed: number; skipped: number }
    assert.equal(inventory.tests, 4)
    assert.equal(inventory.passed, 4)
    assert.equal(inventory.failed, 0)
    assert.equal(inventory.skipped, 0)
    removeSyntheticProviderFixture(fixture.root)
  })
} else {
  const { ChatEngine } = await import('./chatEngine.js')
  const { OpenCodeGoApiRunner } = await import('../runners/openCodeGoApi.js')
  const { runCliChatTask } = await import('../interactive/execution/chatCore.js')
  const { MODEL_PRICING_REGISTRY } = await import('../services/modelPricingRegistry.js')
  const task = 'Explain this file without changing it.'
  const routes = [
    { name: 'Go4.1 controlled budget seam', key: 'opencode-go/deepseek-v4.1-flash',
      model: 'deepseek-v4.1-flash', endpoint: 'https://opencode.ai/zen/go/v1/chat/completions' },
    { name: 'OpenRouter existing-provider control', key: 'glm-5.3-flash',
      model: 'z-ai/glm-5.3-flash', endpoint: 'https://openrouter.ai/api/v1/chat/completions' },
  ] as const

  function fixture(t: TestContext) {
    const root = mkdtempSync(join(tmpdir(), 'babel-admission-'))
    const keys = ['BABEL_LIVE', 'BABEL_HEADLESS', 'BABEL_READ_ONLY', 'BABEL_EXECUTION_PROFILE']
    const prior = new Map(keys.map(key => [key, process.env[key]]))
    const priorFetch = globalThis.fetch
    t.after(() => {
      globalThis.fetch = priorFetch
      for (const [key, value] of prior) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    })
    process.env['BABEL_LIVE'] = '1'
    process.env['BABEL_HEADLESS'] = '1'
    process.env['BABEL_EXECUTION_PROFILE'] = 'safe_repo'
    delete process.env['BABEL_READ_ONLY']
    const target = join(root, 'fixture.txt')
    writeFileSync(target, 'unchanged\n')
    return { root, target }
  }

  function currentGoRunner(t: TestContext) {
    // No model inference: this source control bypasses only the unrelated native
    // budget prerequisite to exercise task admission; it is not a product cell.
    const budget = { reserve: async () => {} } as unknown as OpenCodeGoBudget
    const syntheticKey = 'deepseek:deepseek-v4.1-flash'
    const priorPricing = MODEL_PRICING_REGISTRY[syntheticKey]
    // Fixture accounting only: zero-cost injected responses, no Go price claim.
    MODEL_PRICING_REGISTRY[syntheticKey] = { provider: 'deepseek', modelId: 'deepseek-v4.1-flash',
      inputCostPer1M: 0, outputCostPer1M: 0, sourceUrl: 'fixture:synthetic-only', verifiedAt: 'synthetic-fixture' }
    t.after(() => { if (priorPricing) MODEL_PRICING_REGISTRY[syntheticKey] = priorPricing
      else delete MODEL_PRICING_REGISTRY[syntheticKey] })
    return new OpenCodeGoApiRunner('deepseek-v4.1-flash', {}, { budget })
  }

  for (const route of routes) {
    test(`${route.name}: ordinary prepared no-change task denies native write without an injected read-only flag`, async t => {
      const { root, target } = fixture(t)
      const bodies: Array<{ messages?: Array<{ role: string; tool_call_id?: string; content: string }> }> = []
      globalThis.fetch = (async (input, init) => {
        if (String(input) !== route.endpoint) throw new Error('unexpected synthetic route')
        const body = JSON.parse(String(init?.body)) as { model: string; messages?: Array<{ role: string; tool_call_id?: string; content: string }> }
        assert.equal(body.model, route.model)
        bodies.push(body)
        if (bodies.length > 2) throw new Error('controlled proposals exhausted')
        const delta = bodies.length === 1 ? {
          tool_calls: [{ index: 0, id: 'ordinary-denied-write', type: 'function', function: {
            name: 'write_file', arguments: JSON.stringify({ path: target, content: 'forbidden' }),
          } }],
        } : { content: 'The fixture contains unchanged text; the write proposal was denied.' }
        return new Response(`data: ${JSON.stringify({ model: route.model, choices: [{ delta,
          finish_reason: bodies.length === 1 ? 'tool_calls' : 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream' } })
      }) as typeof fetch
      const result = await runCliChatTask({ task, projectRoot: root, model: route.key, outputFormat: 'json',
        ...(route.key.startsWith('opencode-go') ? {
          engineFactory: options => new ChatEngine({ ...options, providerRunner: currentGoRunner(t) }),
        } : {}),
      })
      assert.equal(readFileSync(target, 'utf8'), 'unchanged\n')
      assert.equal(result.payload['terminal_outcome'], 'NO_CHANGE_REQUIRED')
      assert.equal(result.exitCode, 0)
      const denial = bodies[1]?.messages?.find(message => message.tool_call_id === 'ordinary-denied-write')
      assert.equal(denial?.role, 'tool')
      assert.ok(/denied|read.only|not allowed/i.test(denial?.content ?? ''))
      assert.equal(process.env['BABEL_READ_ONLY'], undefined)
    })

    test(`${route.name}: a fresh mutating task does not inherit the prior read-only admission`, async t => {
      const { root, target } = fixture(t)
      let primaryCalls = 0
      globalThis.fetch = (async (input, init) => {
        if (String(input) !== route.endpoint) throw new Error('unexpected synthetic route')
        const body = JSON.parse(String(init?.body)) as { model: string; stream?: boolean }
        assert.equal(body.model, route.model)
        if (body.stream !== true) return Response.json({ model: route.model,
          choices: [{ message: { content: '{"verdict":"reject","confidence":0.9,"reasons":["verification absent"]}' } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 } })
        primaryCalls++
        if (primaryCalls > 5) throw new Error('controlled proposals exhausted')
        const firstTask = primaryCalls <= 2
        const delta = primaryCalls === 1 || primaryCalls === 3 ? {
          tool_calls: [{ index: 0, id: `fresh-task-write-${primaryCalls}`, type: 'function', function: {
            name: 'write_file', arguments: JSON.stringify({ path: target, content: firstTask ? 'forbidden' : 'allowed' }),
          } }],
        } : { content: firstTask ? 'No change was needed; the write was denied.'
          : 'The authorized edit is present; verification has not run.' }
        return new Response(`data: ${JSON.stringify({ model: route.model, choices: [{ delta,
          finish_reason: primaryCalls === 1 || primaryCalls === 3 ? 'tool_calls' : 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream' } })
      }) as typeof fetch
      const engine = new ChatEngine({ task, projectRoot: root, model: route.key,
        ...(route.key.startsWith('opencode-go') ? { providerRunner: currentGoRunner(t) } : {}) })
      for await (const _event of engine.submitMessageStream(task, 'explain')) { /* drain */ }
      assert.equal(readFileSync(target, 'utf8'), 'unchanged\n')
      assert.equal(engine.getTurnRuntimeSnapshot()?.effectiveOperation, 'READ_ONLY')
      for await (const _event of engine.submitMessageStream('Fix fixture.txt so it contains allowed.', 'execute')) { /* drain */ }
      assert.equal(readFileSync(target, 'utf8'), 'allowed')
      assert.equal(engine.getTurnRuntimeSnapshot()?.effectiveOperation, 'MUTATING')
      engine.closeAdmissionStore()
    })
  }
}
