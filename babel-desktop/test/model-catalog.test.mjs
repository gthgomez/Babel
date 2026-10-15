// License: Apache-2.0 — see LICENSE
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {refreshModelCatalog,qualifiedProviders,saveProviderRoute,readProviderRoute} from '../native/provider-routing.mjs';

const response=data=>({ok:true,status:200,text:async()=>JSON.stringify(data)});
test('OpenRouter discovers new text, vision and embedding entries without qualifying them by discovery',async()=>{
  const config=mkdtempSync(join(tmpdir(),'babel-full-catalog-'));
  try{
    await refreshModelCatalog({configDirectory:config,provider:'openrouter',fetchImpl:async()=>response({data:[
      {id:'vendor/new-code',architecture:{input_modalities:['text','image'],output_modalities:['text']},supported_parameters:['tools'],pricing:{prompt:'0.000001',completion:'0.000003'}},
      {id:'vendor/embedding',architecture:{input_modalities:['text'],output_modalities:['embeddings']}},
      {id:'vendor/plain-text',architecture:{input_modalities:['text'],output_modalities:['text']},supported_parameters:[]},
    ]})});
    const routes=qualifiedProviders(config).find(p=>p.id==='openrouter').routes;
    const code=routes.find(m=>m.modelId==='vendor/new-code');
    assert.ok(code);assert.equal(code.qualification,'unverified');assert.equal(code.capabilities.tools,true);assert.equal(code.capabilities.vision,true);
    assert.equal(code.enabled,false);assert.equal(code.inputPrice,1);
    const embedding=routes.find(m=>m.modelId==='vendor/embedding');
    assert.ok(embedding);assert.equal(embedding.selectable,false);assert.match(embedding.unavailableReason,/text conversation/i);
    assert.throws(()=>saveProviderRoute({configDirectory:config,provider:'openrouter',model:embedding.id}),/text conversation/i);
    saveProviderRoute({configDirectory:config,provider:'openrouter',model:code.id});
    const policy=JSON.parse(readFileSync(join(config,'model-policy.json'),'utf8'));
    assert.equal(policy.models[code.id].native_tool_use,true);
    const text=routes.find(m=>m.modelId==='vendor/plain-text');
    saveProviderRoute({configDirectory:config,provider:'openrouter',model:text.id});
    assert.equal(JSON.parse(readFileSync(join(config,'model-policy.json'),'utf8')).models[text.id].native_tool_use,false);
  }finally{rmSync(config,{recursive:true,force:true});}
});
test('refresh removal and offline failure preserve defaults and mark availability honestly',async()=>{
  const config=mkdtempSync(join(tmpdir(),'babel-catalog-offline-'));
  try{
    const item={id:'vendor/new-code',architecture:{output_modalities:['text']},supported_parameters:['tools']};
    await refreshModelCatalog({configDirectory:config,provider:'openrouter',fetchImpl:async()=>response({data:[item]})});
    const route=qualifiedProviders(config).find(p=>p.id==='openrouter').routes.find(m=>m.modelId===item.id);
    assert.ok(route);
    saveProviderRoute({configDirectory:config,provider:'openrouter',model:route.id});
    await assert.rejects(()=>refreshModelCatalog({configDirectory:config,provider:'openrouter',fetchImpl:async()=>{throw new Error('fixture transport failure');}}),/refresh/i);
    assert.equal(readProviderRoute(config).model,route.id);
    assert.equal(qualifiedProviders(config).find(p=>p.id==='openrouter').catalog.status,'cached');
    await refreshModelCatalog({configDirectory:config,provider:'openrouter',fetchImpl:async()=>response({data:[]})});
    assert.equal(readProviderRoute(config).model,route.id);
    const removed=qualifiedProviders(config).find(p=>p.id==='openrouter').routes.find(m=>m.id===route.id);
    assert.equal(removed.enabled,true);assert.equal(removed.selectable,false);assert.match(removed.unavailableReason,/no longer listed/i);
  }finally{rmSync(config,{recursive:true,force:true});}
});
test('DeepInfra discovers all modalities and normalizes documented cents per token',async()=>{
  const config=mkdtempSync(join(tmpdir(),'babel-deepinfra-catalog-'));
  try{
    await refreshModelCatalog({configDirectory:config,provider:'deepinfra',fetchImpl:async(url,options)=>{
      assert.equal(url,'https://api.deepinfra.com/models/list');assert.equal(options.headers.Authorization,undefined);
      return response([{model_name:'vendor/text',type:'text-generation',max_tokens:32768,pricing:{cents_per_input_token:0.00001,cents_per_output_token:0.00002}},
        {model_name:'vendor/unknown'},
        {model_name:'vendor/image',type:'text-to-image'},{model_name:'vendor/old',type:'text-generation',deprecated:1,replaced_by:'vendor/text'}]);
    }});
    const routes=qualifiedProviders(config).find(p=>p.id==='deepinfra').routes;
    assert.equal(routes.find(m=>m.modelId==='vendor/text').inputPrice,0.1);
    assert.equal(routes.find(m=>m.modelId==='vendor/text').capabilities.tools,null);
    assert.equal(routes.find(m=>m.modelId==='vendor/image').selectable,false);
    assert.equal(routes.find(m=>m.modelId==='vendor/old').selectable,false);
    assert.equal(routes.find(m=>m.modelId==='vendor/unknown').capabilities.conversation,null);
  }finally{rmSync(config,{recursive:true,force:true});}
});
test('DeepSeek discovery confines optional authorization to its fixed metadata endpoint',async()=>{
  const config=mkdtempSync(join(tmpdir(),'babel-deepseek-catalog-'));
  try{
    await refreshModelCatalog({configDirectory:config,provider:'deepseek',credential:'synthetic-only',fetchImpl:async(url,options)=>{
      assert.equal(url,'https://api.deepseek.com/models');assert.equal(options.headers.Authorization,'Bearer synthetic-only');assert.equal(options.redirect,'error');
      return response({data:[{id:'deepseek-fixture',context_window:4096,input_modalities:['text','image'],output_modalities:['text']}]});
    }});
    const model=qualifiedProviders(config).find(p=>p.id==='deepseek').routes.find(m=>m.modelId==='deepseek-fixture');
    assert.equal(model.contextWindow,4096);assert.equal(model.capabilities.vision,true);assert.equal(model.capabilities.tools,null);
    assert.ok(!readFileSync(join(config,'desktop-model-catalog.json'),'utf8').includes('synthetic-only'));
  }finally{rmSync(config,{recursive:true,force:true});}
});
test('Go discovery lists adapter gaps and Ollama tags do not prove local execution or tools',async()=>{
  const config=mkdtempSync(join(tmpdir(),'babel-catalog-support-'));
  try{
    await refreshModelCatalog({configDirectory:config,provider:'opencode-go',fetchImpl:async()=>response({data:[{id:'unsupported-protocol-model'}]})});
    const gap=qualifiedProviders(config).find(p=>p.id==='opencode-go').routes.find(m=>m.modelId==='unsupported-protocol-model');
    assert.ok(gap);assert.equal(gap.selectable,false);assert.match(gap.unavailableReason,/adapter/i);
    await refreshModelCatalog({configDirectory:config,provider:'ollama',fetchImpl:async()=>response({models:[{name:'fixture:latest'},{name:'fixture:cloud',remote_host:'https://ollama.com'}]})});
    const routes=qualifiedProviders(config).find(p=>p.id==='ollama').routes;
    assert.equal(routes.find(m=>m.modelId==='fixture:latest').locality,'unknown');
    assert.equal(routes.find(m=>m.modelId==='fixture:latest').capabilities.tools,null);
    assert.equal(routes.find(m=>m.modelId==='fixture:latest').accountAvailability,'installed');
    assert.equal(routes.find(m=>m.modelId==='fixture:cloud').locality,'cloud');
  }finally{rmSync(config,{recursive:true,force:true});}
});
test('newer catalog schemas are read-only and unknown legacy fields survive refresh',async()=>{
  const config=mkdtempSync(join(tmpdir(),'babel-catalog-schema-'));
  try{
    const path=join(config,'desktop-model-catalog.json');
    for(const payload of [{schemaVersion:2,models:[],futureField:'preserve'},{schemaVersion:2,entries:[{future:'layout'}]}]){
      const newer=JSON.stringify(payload);
      writeFileSync(path,newer);
      await assert.rejects(()=>refreshModelCatalog({configDirectory:config,provider:'deepinfra',fetchImpl:async()=>{throw new Error('must not fetch');}}),/newer Babel/);
      assert.equal(readFileSync(path,'utf8'),newer);
      assert.equal(qualifiedProviders(config).find(p=>p.id==='deepinfra').catalog.status,'incompatible');
    }
    writeFileSync(path,JSON.stringify({models:[],futureField:'preserve'}));
    await refreshModelCatalog({configDirectory:config,provider:'deepinfra',fetchImpl:async()=>response([])});
    assert.equal(JSON.parse(readFileSync(path,'utf8')).futureField,'preserve');
  }finally{rmSync(config,{recursive:true,force:true});}
});
