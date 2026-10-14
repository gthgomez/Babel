import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveChatModelPolicy } from './chatModelPolicy.js'
import { normalizeModelName } from '../cli/helpers.js'

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
  await routing.refreshModelCatalog({configDirectory:config,provider:'openrouter',fetchImpl:async()=>({ok:true,text:async()=>JSON.stringify({data:[{id:'deepseek/deepseek-v4-pro',supported_parameters:['tools']},{id:'vendor/unqualified',supported_parameters:['tools']}]})})})
  assert.throws(()=>routing.saveProviderRoute({configDirectory:config,provider:'openrouter',model:'openrouter/vendor/unqualified'}),/not supported/)
  await routing.refreshModelCatalog({configDirectory:config,provider:'ollama',fetchImpl:async()=>({ok:true,text:async()=>JSON.stringify({models:[{name:'qwen3:latest'},{name:'MyModel:latest'}]})})})
  for(const [provider,key,model] of [['opencode-go','opencode-go/deepseek-v4.1-flash','deepseek-v4.1-flash'],['openrouter','deepseek-v4-pro-openrouter','deepseek/deepseek-v4-pro'],['deepinfra','qwen3','Qwen/Qwen3-235B-A22B-Instruct-2507'],['deepseek','deepseek-v4-pro','deepseek-v4-pro'],['ollama','ollama/qwen3:latest','qwen3:latest'],['ollama','ollama/MyModel:latest','MyModel:latest']] as const){
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
