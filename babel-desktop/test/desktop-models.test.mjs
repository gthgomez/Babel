// License: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {qualifiedProviders,saveProviderRoute,readProviderRoute} from '../native/provider-routing.mjs';
import * as routing from '../native/provider-routing.mjs';
import {execFileSync} from 'node:child_process';

test('manual OpenRouter and Command Code IDs persist outside discovery with honest unknown metadata',async()=>{
  const config=mkdtempSync(join(tmpdir(),'babel-manual-models-'));
  try{
    for(const provider of ['openrouter','command-code']){
      const manualModelId='Vendor/Unlisted-Case',model=`${provider}/${manualModelId}`;
      saveProviderRoute({configDirectory:config,provider,model,manualModelId,enabledModels:[model]});
      assert.deepEqual(readProviderRoute(config),{provider,model});
      await routing.refreshModelCatalog({configDirectory:config,provider:'openrouter',fetchImpl:async()=>({ok:true,text:async()=>JSON.stringify({data:[]})})});
      const saved=qualifiedProviders(config).find(p=>p.id===provider);
      const entry=saved.routes.find(m=>m.id===model);
      assert.equal(saved.defaultModel,model);assert.equal(entry.enabled,true);
      assert.equal(entry.source,'manual');assert.equal(entry.qualification,'unverified');
      assert.equal(entry.modelId,manualModelId);assert.equal(entry.inputPrice,undefined);
      assert.equal(entry.contextWindow,undefined);assert.equal(entry.capabilities,undefined);
      const policy=JSON.parse(readFileSync(join(config,'model-policy.json'),'utf8')).models[model];
      assert.equal(policy.native_tool_use,undefined);assert.equal(policy.enabled,true);
      assert.equal(JSON.parse(readFileSync(join(config,'desktop-model-catalog.json'),'utf8')).models.some(m=>m.id===model),false);
      const secondId='Vendor/Second',second=`${provider}/${secondId}`;
      saveProviderRoute({configDirectory:config,provider,model:second,manualModelId:secondId,enabledModels:[second]});
      const restarted=JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',`import {qualifiedProviders,readProviderRoute} from ${JSON.stringify(new URL('../native/provider-routing.mjs',import.meta.url).href)}; const config=process.argv[1]; console.log(JSON.stringify({route:readProviderRoute(config),provider:qualifiedProviders(config).find(p=>p.id===${JSON.stringify(provider)})}));`,config],{encoding:'utf8'}));
      assert.deepEqual(restarted.route,{provider,model:second});
      assert.equal(restarted.provider.defaultModel,second);
      assert.equal(restarted.provider.routes.find(m=>m.id===model).enabled,false);
      assert.equal(restarted.provider.routes.find(m=>m.id===second).enabled,true);
      saveProviderRoute({configDirectory:config,provider,model,enabledModels:[model]});
    }
    const openrouter=qualifiedProviders(config).find(p=>p.id==='openrouter');
    assert.equal(openrouter.defaultModel,'openrouter/Vendor/Unlisted-Case');
  }finally{rmSync(config,{recursive:true,force:true});}
});

test('public catalog byte ceiling cancels streaming before EOF and leaves no cache',async()=>{
  const config=mkdtempSync(join(tmpdir(),'babel-model-stream-limit-'));
  let pulls=0,cancelled=false;
  try{
    const response=new Response(new ReadableStream({
      pull(controller){pulls++;if(pulls<=10)controller.enqueue(new Uint8Array(2*1024*1024));else controller.close();},
      cancel(){cancelled=true;},
    }));
    await assert.rejects(()=>routing.refreshModelCatalog({configDirectory:config,provider:'openrouter',fetchImpl:async()=>response}),/size limit/);
    assert.equal(cancelled,true);
    assert.ok(pulls<=4,'Oversized response must not be drained to EOF (one prefetched chunk is allowed)');
    assert.equal(existsSync(join(config,'desktop-model-catalog.json')),false);
  }finally{rmSync(config,{recursive:true,force:true});}
});

test('desktop catalog matches CLI provider identities and exposes multiple actual OpenRouter routes',()=>{
  const providers=qualifiedProviders();
  assert.ok(providers.find(provider=>provider.id==='openrouter').routes.length>=3);
  assert.ok(providers.some(provider=>provider.id==='opencode-go'));
  assert.ok(!providers.some(provider=>provider.id==='opencode'));
  assert.ok(providers.find(provider=>provider.id==='deepinfra').routes.every(route=>route.id!=='deepseek-v4-flash'));
});

test('public model discovery supports tool-capable choices and exact CLI policy identities',async()=>{
  const config=mkdtempSync(join(tmpdir(),'babel-model-discovery-'));
  try {
    const fetchImpl=async(url,options)=>{
      assert.equal(url,'https://openrouter.ai/api/v1/models');
      assert.equal(options.redirect,'error');
      assert.equal(options.headers.Authorization,undefined);
      return {ok:true,status:200,text:async()=>JSON.stringify({data:[
        {id:'deepseek/deepseek-v4-pro',name:'DeepSeek Pro',context_length:32768,supported_parameters:['tools'],pricing:{prompt:'0.000001',completion:'0.000002'}},
        {id:'vendor/tool-model',name:'Unqualified Model',supported_parameters:['tools']},
        {id:'vendor/text-only',name:'Text Only',supported_parameters:[]},
      ]})};
    };
    await routing.refreshModelCatalog({configDirectory:config,provider:'openrouter',fetchImpl});
    const model=qualifiedProviders(config).find(p=>p.id==='openrouter').routes.find(m=>m.id==='deepseek-v4-pro-openrouter');
    assert.ok(model);assert.equal(model.modelId,'deepseek/deepseek-v4-pro');
    const discovered=qualifiedProviders(config).flatMap(p=>p.routes);
    assert.equal(discovered.find(m=>m.id==='openrouter/vendor/tool-model').qualification,'unverified');
    assert.equal(discovered.find(m=>m.id==='openrouter/vendor/text-only').capabilities.tools,false);
    saveProviderRoute({configDirectory:config,provider:'openrouter',model:model.id,enabledModels:[model.id]});
    const policy=JSON.parse(readFileSync(join(config,'model-policy.json'),'utf8'));
    assert.equal(policy.models[model.id].provider,'openrouter');
    assert.equal(policy.models[model.id].model_id,'deepseek/deepseek-v4-pro');
    assert.equal(model.inputPrice,1);
  } finally {rmSync(config,{recursive:true,force:true});}
});

test('switching providers preserves their saved default and enabled models',()=>{
  const config=mkdtempSync(join(tmpdir(),'babel-provider-defaults-'));
  try {
    saveProviderRoute({configDirectory:config,provider:'openrouter',model:'deepseek-v4-pro-openrouter',enabledModels:['deepseek-v4-pro-openrouter']});
    saveProviderRoute({configDirectory:config,provider:'opencode-go',model:'opencode-go/deepseek-v4.1-flash'});
    const provider=qualifiedProviders(config).find(p=>p.id==='openrouter');
    assert.equal(provider.defaultModel,'deepseek-v4-pro-openrouter');
    assert.equal(provider.routes.find(m=>m.id==='glm-5.3-flash').enabled,false);
    const policy=JSON.parse(readFileSync(join(config,'model-policy.json'),'utf8'));
    assert.equal(policy.models['glm-5.3-flash'].enabled,false);
  }finally{rmSync(config,{recursive:true,force:true});}
});

test('enabled/default model preferences persist and reject a disabled default without overwriting',()=>{
  const config=mkdtempSync(join(tmpdir(),'babel-desktop-models-'));
  try {
    const options={configDirectory:config,provider:'openrouter',model:'glm-5.3-flash',enabledModels:['glm-5.3-flash','deepseek-v4-pro-openrouter']};
    saveProviderRoute(options);
    const settings=JSON.parse(readFileSync(join(config,'desktop-routing.json'),'utf8'));
    assert.deepEqual(settings.enabledModels,options.enabledModels);
    assert.deepEqual(readProviderRoute(config),{provider:options.provider,model:options.model});
    const before=readFileSync(join(config,'desktop-routing.json'));
    assert.throws(()=>saveProviderRoute({...options,enabledModels:['deepseek-v4-pro-openrouter']}),/default.*enabled/i);
    assert.deepEqual(readFileSync(join(config,'desktop-routing.json')),before);
  } finally {rmSync(config,{recursive:true,force:true});}
});
