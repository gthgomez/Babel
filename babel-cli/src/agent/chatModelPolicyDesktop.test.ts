import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveChatModelPolicy } from './chatModelPolicy.js'
import { normalizeModelName } from '../cli/helpers.js'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { isSyntheticProviderFixtureReady, prepareSyntheticProviderFixture, removeSyntheticProviderFixture, summarizeSyntheticProviderOutput } from '../testinfra/synthetic-provider-fixture.mjs'

if (!isSyntheticProviderFixtureReady()) {
  test('manual model native acceptance uses an isolated provider fixture', async t => {
    const fixture = prepareSyntheticProviderFixture()
    t.after(() => removeSyntheticProviderFixture(fixture.root))
    const child = spawn(process.execPath, [
      '--experimental-wasm-modules', '--import', new URL('../testinfra/synthetic-provider-fixture.mjs', import.meta.url).href,
      '--import', import.meta.resolve('tsx'), '--import', new URL('../testinfra/register-no-ambient-inference.mjs', import.meta.url).href,
      '--test', '--test-reporter=tap', '--test-name-pattern=^manual configured model IDs', fileURLToPath(import.meta.url),
    ], { cwd: fixture.cwd, env: fixture.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', chunk => { output += String(chunk) })
    child.stderr.on('data', chunk => { output += String(chunk) })
    const code = await new Promise<number>(resolve => { child.once('error', () => resolve(1)); child.once('close', value => resolve(value ?? 1)) })
    const diagnostic = summarizeSyntheticProviderOutput(output, code)
    t.diagnostic(diagnostic)
    if (code !== 0) t.diagnostic(output)
    assert.equal(code, 0)
    assert.deepEqual(JSON.parse(diagnostic), { exitCode: 0, tests: 1, passed: 1, failed: 0, skipped: 0, isolationRejected: false, networkDispatchBlocked: false })
  })
} else {
  test('manual configured model IDs stay exact across native stages and useful unbudgeted tasks', async t => {
    const { mkdtempSync, writeFileSync, readFileSync } = await import('node:fs')
    const { execFileSync } = await import('node:child_process')
    const { initMinimalGitProject } = await import('../testUtils/chatAdmissionFixture.js')
    const { runCliChatTask } = await import('../interactive/execution/chatCore.js')
    const { resolveChatDeliberationRunner, resolveChatSynthesisRunner } = await import('./chatEngineProviderRuntime.js')
    const { chatSessionDir } = await import('../cli/runsLayout.js')
    const { loadThreadEventLogFromDir } = await import('./threadEventLog.js')
    const { globalCostTracker } = await import('../services/costTracker.js')
    const { resolveModelByKey } = await import('../modelPolicy.js')
    const routing = await import(new URL('../../../babel-desktop/native/provider-routing.mjs', import.meta.url).href)
    const config = join(process.env['BABEL_SYNTHETIC_PROVIDER_FIXTURE_ROOT']!, 'config')
    const originalFetch = globalThis.fetch
    t.after(() => { globalThis.fetch = originalFetch })
    process.env['COMMAND_CODE_API_KEY'] = 'synthetic-command-code-credential'
    delete process.env['BABEL_OFFLINE']
    let current: ReturnType<typeof resolveChatSynthesisRunner> | null = null
    for (const provider of ['openrouter', 'command-code']) {
      const manualModelId = 'Vendor/Unlisted-Case', key = `${provider}/${manualModelId}`
      routing.saveProviderRoute({ configDirectory: config, provider, model: key, manualModelId, enabledModels: [key] })
      routing.applyProviderRoute(process.env, config)
      const policy = resolveChatModelPolicy({ model: normalizeModelName(key)! }).policy
      assert.equal(policy.providerModelId, manualModelId)
      assert.equal(policy.waterfall[0]?.estimatedCostPer1MInput, undefined)
      assert.throws(() => resolveModelByKey({ key, liveOnly: true }), /LIVE_MODEL_POLICY/)
      const policyPath = join(config, 'model-policy.json')
      const savedPolicy = readFileSync(policyPath, 'utf8')
      const disabledPolicy = JSON.parse(savedPolicy)
      disabledPolicy.models[key].enabled = false
      writeFileSync(policyPath, JSON.stringify(disabledPolicy))
      assert.throws(() => resolveChatModelPolicy({ model: key }), /disabled/)
      writeFileSync(policyPath, savedPolicy)
      const enterprisePath = join(config, 'manual-enterprise-policy.json')
      writeFileSync(enterprisePath, JSON.stringify({ model_policy: { disallowed_backends: [key] } }))
      process.env['BABEL_ENTERPRISE_POLICY_PATH'] = enterprisePath
      assert.throws(() => resolveChatModelPolicy({ model: key }), /ENTERPRISE_POLICY/)
      delete process.env['BABEL_ENTERPRISE_POLICY_PATH']
      const endpoint = provider === 'openrouter' ? 'https://openrouter.ai/api/v1/chat/completions' : 'https://api.commandcode.ai/provider/v1/chat/completions'
      const reply = (delta: object, finish = 'stop', observed = manualModelId) => new Response(`data: ${JSON.stringify({ model: observed, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
      let stageRequests = 0
      globalThis.fetch = async (input, init) => {
        assert.equal(String(input), endpoint)
        assert.equal(JSON.parse(String(init?.body)).model, manualModelId)
        stageRequests++
        return new Response(JSON.stringify({ model: manualModelId, choices: [{ message: { content: 'Exact selected model response.' }, finish_reason: 'stop' }] }), { headers: { 'content-type': 'application/json' } })
      }
      for (const stage of policy.stagePolicies) {
        assert.equal(stage.primaryProvider, provider)
        assert.equal(stage.primaryProviderModelId, manualModelId)
        assert.equal(stage.orderedBackends.length, 1)
        current = resolveChatDeliberationRunner(current, policy)
        assert.equal(await current.executeRaw('Explain the fixture.'), 'Exact selected model response.')
        current = resolveChatSynthesisRunner(current, policy)
      }
      assert.equal(stageRequests, policy.stagePolicies.length)
      globalThis.fetch = async () => new Response(JSON.stringify({ model: 'different/model', choices: [{ message: { content: 'Wrong identity.' }, finish_reason: 'stop' }] }), { headers: { 'content-type': 'application/json' } })
      await assert.rejects(current!.executeRaw('Explain the fixture.'), /model mismatch/)

      const root = mkdtempSync(join(config, 'manual-project-'))
      initMinimalGitProject(root)
      writeFileSync(join(root, 'README.md'), '# Manual model fixture\n\nPurpose: preserve the cobalt-lantern marker.\n')
      execFileSync('git', ['add', 'README.md'], { cwd: root })
      execFileSync('git', ['commit', '-qm', 'fixture input'], { cwd: root })
      const task = 'Explain README.md and its stated purpose without changing any files.'
      const expectedAnswer = 'README.md states that this fixture preserves the cobalt-lantern marker. No files were changed.'
      for (const finite of [false, true]) {
        globalCostTracker.resetSession()
        if (finite) process.env['BABEL_CHAT_MAX_COST'] = '0.001'
        else delete process.env['BABEL_CHAT_MAX_COST']
        let requests = 0
        globalThis.fetch = async (input, init) => {
          assert.equal(String(input), endpoint)
          const body = JSON.parse(String(init?.body))
          assert.equal(body.model, manualModelId)
          assert.ok(++requests <= (finite ? 1 : 2))
          if (requests === 1) return reply({ tool_calls: [{ index: 0, id: 'manual-read', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'README.md' }) } }] }, 'tool_calls')
          const observation = body.messages.find((message: { role: string; tool_call_id?: string }) => message.role === 'tool' && message.tool_call_id === 'manual-read')
          assert.match(String(observation?.content), /cobalt-lantern/)
          assert.match(String(observation?.content), /exit_code: 0/)
          return reply({ content: expectedAnswer })
        }
        const result = await runCliChatTask({ task, model: normalizeModelName(key)!, projectRoot: root, outputFormat: 'json' })
        assert.equal(requests, finite ? 1 : 2)
        assert.equal(result.exitCode === 0, !finite)
        assert.equal(result.payload[finite ? 'reason_code' : 'terminal_outcome'], finite ? 'cost_accounting_incomplete' : 'NO_CHANGE_REQUIRED')
        if (!finite) {
          const answer = result.payload['answer']
          assert.ok(answer && typeof answer === 'object' && 'answer' in answer)
          assert.equal(answer.answer, expectedAnswer, 'the native result must retain the useful provider answer')
          const thread = loadThreadEventLogFromDir(chatSessionDir(result.payload['session_id'] as string))
          const terminal = thread?.events.filter(event => event.kind === 'turn_ended').at(-1)
          assert.equal(terminal?.response?.kind, 'answer')
          assert.equal(terminal?.response?.content, expectedAnswer, 'the durable transcript must retain the useful answer')
        }
        const budget = JSON.parse(readFileSync(join(chatSessionDir(result.payload['session_id'] as string), 'task-budget.json'), 'utf8'))
        assert.deepEqual(budget.grant.costCap, finite ? { kind: 'finite', usd: 0.001 } : { kind: 'unlimited' })
        assert.ok((globalCostTracker.getTaskSummary(budget.taskOwnerId).unknownChargeCount ?? 0) > 0)
      }
      delete process.env['BABEL_CHAT_MAX_COST']
      delete process.env['BABEL_DESKTOP_PROVIDER']
      delete process.env['BABEL_DESKTOP_MODEL_ROUTE']
      assert.equal(resolveChatModelPolicy({ model: key }).policy.providerModelId, manualModelId)
      let mismatches = 0
      globalThis.fetch = async (input, init) => {
        assert.equal(String(input), endpoint)
        assert.equal(JSON.parse(String(init?.body)).model, manualModelId)
        assert.equal(++mismatches, 1, 'invalid response identity cannot retry or substitute another route')
        return reply({ content: 'Wrong identity.' }, 'stop', 'different/model')
      }
      const mismatch = await runCliChatTask({ task, model: key, projectRoot: root, outputFormat: 'json' })
      assert.notEqual(mismatch.exitCode, 0)
      assert.equal(mismatches, 1)
    }
  })
}

test('Desktop investigation and mutation keep the admitted runner across independent tasks', async (t) => {
  const config = await mkdtemp(join(tmpdir(), 'babel-desktop-phase-boundary-'))
  t.after(() => rm(config, { recursive: true, force: true }))
  const settings = {
    BABEL_STATE_DIR: join(config, 'state'), BABEL_CACHE_DIR: join(config, 'cache'), BABEL_RUNS_DIR: join(config, 'runs'),
    BABEL_CHAT_INVESTIGATE_MODEL: 'glm-5.3-flash', BABEL_CHAT_MUTATE_MODEL: 'deepseek-v4-pro-openrouter',
    OPENROUTER_API_KEY: 'synthetic-only', DEEPINFRA_API_KEY: 'synthetic-only', BABEL_OPENCODE_GO_API_KEY: 'synthetic-only',
  }
  const names = [...Object.keys(settings), 'BABEL_MODEL_POLICY_PATH', 'BABEL_CONFIG_DIR', 'BABEL_DESKTOP_PROVIDER', 'BABEL_DESKTOP_MODEL_ROUTE', 'BABEL_OFFLINE', 'BABEL_LITE_OFFLINE']
  const prior = Object.fromEntries(names.map(name => [name, process.env[name]]))
  t.after(() => { for (const name of names) { if (prior[name] === undefined) delete process.env[name]; else process.env[name] = prior[name] } })
  Object.assign(process.env, settings)
  delete process.env['BABEL_OFFLINE']
  const routing = await import(new URL('../../../babel-desktop/native/provider-routing.mjs', import.meta.url).href)
  const { ChatEngine } = await import('./chatEngine.js')
  const { DeepInfraApiRunner } = await import('../runners/deepInfraApi.js')
  const admittedRunner = new DeepInfraApiRunner('Qwen/Qwen3-235B-A22B-Instruct-2507', 'DEEPINFRA_API_KEY', {}, { explicitCredential: 'synthetic-only' })
  await routing.refreshModelCatalog({ configDirectory: config, provider: 'ollama', fetchImpl: async () => ({ ok: true, text: async () => JSON.stringify({ models: [{ name: 'qwen3:latest' }] }) }) })
  for (const [provider, model] of [['openrouter', 'deepseek-v4-flash-openrouter'], ['deepseek', 'deepseek-v4-pro'], ['deepinfra', 'qwen3'], ['opencode-go', 'opencode-go/deepseek-v4.1-flash'], ['ollama', 'ollama/qwen3:latest']] as const) {
    routing.saveProviderRoute({ configDirectory: config, provider, model, enabledModels: [model] })
    routing.applyProviderRoute(process.env, config)
    const engine = new ChatEngine({ task: 'Inspect the public fixture', projectRoot: config, model, providerRunner: admittedRunner })
    const routed = engine as unknown as { _lastPhase: string | null; resolveRoutedRunner(): unknown }
    for (const task of ['Inspect the public fixture', 'Explain the next independent fixture']) {
      engine.applyUserSubmission({ userInput: task, continueTask: false })
      for (const phase of [null, 'investigate', 'mutate']) {
        routed._lastPhase = phase
        assert.equal(routed.resolveRoutedRunner(), admittedRunner, `${provider} ${phase} ${task}`)
      }
    }
  }
})

test('profiled CLI rejects enabled models belonging to another provider', async (t) => {
  const routing = await import(new URL('../../../babel-desktop/native/provider-routing.mjs', import.meta.url).href)
  const config = await mkdtemp(join(tmpdir(), 'babel-desktop-provider-boundary-'))
  t.after(() => rm(config, { recursive: true, force: true }))
  const names = ['BABEL_MODEL_POLICY_PATH', 'BABEL_CONFIG_DIR', 'BABEL_DESKTOP_PROVIDER', 'BABEL_DESKTOP_MODEL_ROUTE', 'BABEL_OFFLINE', 'BABEL_LITE_OFFLINE']
  const prior = Object.fromEntries(names.map(name => [name, process.env[name]]))
  t.after(() => { for (const name of names) { if (prior[name] === undefined) delete process.env[name]; else process.env[name] = prior[name] } })
  delete process.env['BABEL_OFFLINE']
  const routes = [['deepinfra', 'qwen3'], ['deepseek', 'deepseek-v4-pro'], ['opencode-go', 'opencode-go/deepseek-v4.1-flash'], ['openrouter', 'deepseek-v4-pro-openrouter']] as const
  for (const [provider, model] of routes) routing.saveProviderRoute({ configDirectory: config, provider, model, enabledModels: [model] })
  for (const [provider, model] of routes) {
    routing.saveProviderRoute({ configDirectory: config, provider, model, enabledModels: [model] })
    routing.applyProviderRoute(process.env, config)
    assert.equal(resolveChatModelPolicy({ model }).policy.provider, provider)
    for (const [otherProvider, otherModel] of routes) {
      // Bare DeepSeek names are documented OpenRouter aliases in its profile.
      if (otherProvider !== provider && !(provider === 'openrouter' && otherProvider === 'deepseek')) {
        assert.throws(() => resolveChatModelPolicy({ model: otherModel }), /selected provider/)
      }
    }
  }
  assert.equal(resolveChatModelPolicy({ model: 'deepseek-v4-pro' }).policy.provider, 'openrouter')
})

test('Desktop discovery and saves resolve through the actual Chat policy with exact identity',async(t)=>{
  const routing=await import(new URL('../../../babel-desktop/native/provider-routing.mjs',import.meta.url).href)
  const config=await mkdtemp(join(tmpdir(),'babel-desktop-chat-policy-'))
  t.after(()=>rm(config,{recursive:true,force:true}))
  const names=['BABEL_MODEL_POLICY_PATH','BABEL_CONFIG_DIR','BABEL_DESKTOP_PROVIDER','BABEL_DESKTOP_MODEL_ROUTE','BABEL_OFFLINE','BABEL_LITE_OFFLINE']
  const prior=Object.fromEntries(names.map(name=>[name,process.env[name]]))
  t.after(()=>{for(const name of names){if(prior[name]===undefined)delete process.env[name];else process.env[name]=prior[name]}})
  delete process.env['BABEL_OFFLINE']
  const { parseModelCatalog } = await import(new URL('../../../babel-desktop/native/model-catalog.mjs', import.meta.url).href)
  const catalogPayload = {
    data: [
      { id: 'deepseek/deepseek-v4-pro', supported_parameters: ['tools'] },
      {
        id: 'vendor/new-code',
        architecture: { input_modalities: ['text'], output_modalities: ['text'] },
        supported_parameters: ['tools'],
      },
      { id: 'vendor/embedding', architecture: { input_modalities: ['text'], output_modalities: ['embeddings'] } },
    ],
  }
  const fetchedAt = new Date().toISOString()
  const parsedEntries = parseModelCatalog('openrouter', catalogPayload, [], fetchedAt)
  const discoveredCode = parsedEntries.find((entry: { modelId: string }) => entry.modelId === 'vendor/new-code')
  const discoveredEmbedding = parsedEntries.find((entry: { modelId: string }) => entry.modelId === 'vendor/embedding')
  assert.ok(discoveredCode)
  assert.equal(discoveredCode.qualification, 'unverified')
  assert.equal(discoveredCode.selectable, true)
  assert.ok(discoveredEmbedding)
  assert.equal(discoveredEmbedding.selectable, false)
  await routing.refreshModelCatalog({
    configDirectory: config,
    provider: 'openrouter',
    fetchImpl: async () => ({ ok: true, text: async () => JSON.stringify(catalogPayload) }),
  })
  routing.saveProviderRoute({
    configDirectory: config,
    provider: 'openrouter',
    model: discoveredCode!.id,
    enabledModels: [discoveredCode!.id],
  })
  assert.throws(
    () => routing.saveProviderRoute({ configDirectory: config, provider: 'openrouter', model: discoveredEmbedding!.id }),
    /text conversation/i,
  )
  assert.throws(
    () => routing.saveProviderRoute({ configDirectory: config, provider: 'openrouter', model: 'openrouter/not-in-catalog' }),
    /not supported/,
  )
  await routing.refreshModelCatalog({configDirectory:config,provider:'ollama',fetchImpl:async()=>({ok:true,text:async()=>JSON.stringify({models:[{name:'qwen3:latest'},{name:'MyModel:latest'}]})})})
  for (const [provider, key, model] of [
    ['opencode-go', 'opencode-go/deepseek-v4.1-flash', 'deepseek-v4.1-flash'],
    ['openrouter', 'deepseek-v4-pro-openrouter', 'deepseek/deepseek-v4-pro'],
    ['openrouter', discoveredCode!.id, 'vendor/new-code'],
    ['deepinfra', 'qwen3', 'Qwen/Qwen3-235B-A22B-Instruct-2507'],
    ['deepseek', 'deepseek-v4-pro', 'deepseek-v4-pro'],
    ['ollama', 'ollama/qwen3:latest', 'qwen3:latest'],
    ['ollama', 'ollama/MyModel:latest', 'MyModel:latest'],
  ] as const) {
    routing.saveProviderRoute({configDirectory:config,provider,model:key,enabledModels:[key]})
    const policyPath=join(config,'model-policy.json')
    const policy=JSON.parse(await readFile(policyPath,'utf8'))
    for(const [backend,entry] of Object.entries(policy.models) as [string,{enabled:boolean}][])entry.enabled=backend===key
    await writeFile(policyPath,JSON.stringify(policy))
    // A stray inherited override must not cause Desktop to read a different policy.
    process.env['BABEL_MODEL_POLICY_PATH']=join(config,'unrelated-policy.json')
    routing.applyProviderRoute(process.env,config)
    assert.equal(process.env['BABEL_MODEL_POLICY_PATH'],join(config,'model-policy.json'))
    const result=resolveChatModelPolicy({model:normalizeModelName(key)!})
    assert.equal(result.policy.provider,provider)
    assert.equal(result.policy.providerModelId,model)
  }
})
