// License: Apache-2.0
// Provider transports match the CLI authority registry. Model identities come
// from its model policy and explicitly refreshed provider metadata.
import {existsSync,readFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const desktop=dirname(dirname(fileURLToPath(import.meta.url)));
export function defaultModelPolicy() {
  const paths=[join(desktop,'..','babel-runtime','cli','resources','config','model-policy.json'),join(desktop,'..','config','model-policy.json')];
  const path=paths.find(path=>existsSync(path));
  if(!path)throw new Error('The bundled model catalog is missing. Repair Babel Desktop.');
  return JSON.parse(readFileSync(path,'utf8'));
}
const descriptors={
  openrouter:{label:'OpenRouter',requiresApiKey:true,envName:'OPENROUTER_API_KEY',manualModels:true},
  'command-code':{label:'Command Code',requiresApiKey:true,envName:'COMMAND_CODE_API_KEY',manualModels:true,catalogRefresh:false},
  deepseek:{label:'DeepSeek',requiresApiKey:true,envName:'DEEPSEEK_API_KEY'},
  deepinfra:{label:'DeepInfra',requiresApiKey:true,envName:'DEEPINFRA_API_KEY'},
  'opencode-go':{label:'OpenCode Go',requiresApiKey:true,envName:'BABEL_OPENCODE_GO_API_KEY'},
  ollama:{label:'Ollama',requiresApiKey:false,local:true},
};
export const MODEL_ID_PATTERN=/^[A-Za-z0-9][A-Za-z0-9._/:+-]{0,199}$/;
/** An explicit transport choice, with no claim about model availability or capabilities. */
export function manualProviderModel(provider,modelId){
  if(!['openrouter','command-code'].includes(provider))throw new Error('Manual model IDs require OpenRouter or Command Code.');
  if(typeof modelId!=='string'||!MODEL_ID_PATTERN.test(modelId)||!MODEL_ID_PATTERN.test(`${provider}/${modelId}`))throw new Error('Enter a valid model ID; the provider-bound route must be at most 200 characters.');
  return {id:`${provider}/${modelId}`,provider,modelId,label:modelId,source:'manual',qualification:'unverified',enabled:true,selectable:true};
}
export function listDesktopProviderDescriptors(extraModels=[]) {
  const policy=defaultModelPolicy();
  const routes=Object.entries(policy.models??{}).filter(([,m])=>descriptors[m.provider]&&m.enabled!==false).map(([id,m])=>({id,modelId:m.model_id,provider:m.provider,label:m.model_id,contextWindow:m.context_window,inputPrice:m.estimated_cost_per_1m_input,outputPrice:m.estimated_cost_per_1m_output,enabled:true}));
  for(const model of extraModels){
    if(!descriptors[model.provider]||!MODEL_ID_PATTERN.test(model.id)||!MODEL_ID_PATTERN.test(model.modelId))continue;
    const existing=routes.find(route=>route.id===model.id&&route.provider===model.provider&&route.modelId===model.modelId);
    if(existing){
      if(model.source==='manual')routes.splice(routes.indexOf(existing),1,{...model});
      else Object.assign(existing,{...model,enabled:existing.enabled});
      continue;
    }
    if(!routes.some(route=>route.id===model.id))routes.push({...model});
  }
  return Object.entries(descriptors).map(([id,spec])=>({id,provider:id,...spec,routes:routes.filter(route=>route.provider===id)}));
}
export const DESKTOP_ROUTE_CATALOG=Object.freeze(Object.fromEntries(listDesktopProviderDescriptors().map(spec=>[spec.id,spec])));
export function normalizeProviderRoute({provider,model,manualModelId}={},extraModels=[]) {
  if(manualModelId!==undefined){
    const manual=manualProviderModel(provider,manualModelId);
    if(model!==manual.id)throw new Error('Manual model ID conflicts with the selected provider-bound route.');
    const conflict=listDesktopProviderDescriptors(extraModels).flatMap(spec=>spec.routes).find(route=>route.id===manual.id&&(route.provider!==provider||route.modelId!==manualModelId));
    if(conflict)throw new Error('Manual model ID conflicts with an existing route identity.');
    extraModels=[...extraModels,manual];
  }
  const spec=listDesktopProviderDescriptors(extraModels).find(spec=>spec.id===provider);
  if(!spec)throw new Error('Select a supported, qualified provider route.');
  const requested=typeof model==='string'?model.trim():'';
  const route=spec.routes.find(route=>route.id===requested);
  if(!route)throw new Error(`Model route "${requested}" is not supported for ${spec.label}. Refresh models and select one.`);
  if(route.adapterSupport==='unsupported'||route.capabilities?.conversation===false)throw new Error(route.unavailableReason||'This model needs a compatible Babel adapter.');
  return {provider,model:route.id};
}
