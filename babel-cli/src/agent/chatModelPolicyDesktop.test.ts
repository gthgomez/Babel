import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveChatModelPolicy } from './chatModelPolicy.js'

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
  for(const [provider,key,model] of [['openrouter','deepseek-v4-pro-openrouter','deepseek/deepseek-v4-pro'],['opencode-go','opencode-go/deepseek-v4.1-flash','deepseek-v4.1-flash']] as const){
    routing.saveProviderRoute({configDirectory:config,provider,model:key})
    // A stray inherited override must not cause Desktop to read a different policy.
    process.env['BABEL_MODEL_POLICY_PATH']=join(config,'unrelated-policy.json')
    routing.applyProviderRoute(process.env,config)
    assert.equal(process.env['BABEL_MODEL_POLICY_PATH'],join(config,'model-policy.json'))
    const result=resolveChatModelPolicy({model:key})
    assert.equal(result.policy.provider,provider)
    assert.equal(result.policy.providerModelId,model)
  }
})
