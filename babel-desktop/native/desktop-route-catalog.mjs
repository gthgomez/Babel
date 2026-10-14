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
  openrouter:{label:'OpenRouter',requiresApiKey:true,envName:'OPENROUTER_API_KEY'},
  deepseek:{label:'DeepSeek',requiresApiKey:true,envName:'DEEPSEEK_API_KEY'},
  deepinfra:{label:'DeepInfra',requiresApiKey:true,envName:'DEEPINFRA_API_KEY'},
  'opencode-go':{label:'OpenCode Go',requiresApiKey:true,envName:'BABEL_OPENCODE_GO_API_KEY'},
  ollama:{label:'Ollama',requiresApiKey:false,local:true},
};
export const MODEL_ID_PATTERN=/^[A-Za-z0-9][A-Za-z0-9._/:+-]{0,159}$/;
export function listDesktopProviderDescriptors(extraModels=[]) {
  const policy=defaultModelPolicy();
  const routes=Object.entries(policy.models??{}).filter(([,m])=>descriptors[m.provider]&&m.enabled!==false).map(([id,m])=>({id,modelId:m.model_id,provider:m.provider,label:m.model_id,contextWindow:m.context_window,inputPrice:m.estimated_cost_per_1m_input,outputPrice:m.estimated_cost_per_1m_output,enabled:true}));
  for(const model of extraModels){
    if(!descriptors[model.provider]||!MODEL_ID_PATTERN.test(model.id)||!MODEL_ID_PATTERN.test(model.modelId))continue;
    const existing=routes.find(route=>route.id===model.id&&route.provider===model.provider&&route.modelId===model.modelId);
    if(existing){Object.assign(existing,{...model,enabled:existing.enabled});continue;}
    if(model.provider==='ollama'&&!routes.some(route=>route.id===model.id))routes.push({...model});
  }
  return Object.entries(descriptors).map(([id,spec])=>({id,provider:id,...spec,routes:routes.filter(route=>route.provider===id)}));
}
export const DESKTOP_ROUTE_CATALOG=Object.freeze(Object.fromEntries(listDesktopProviderDescriptors().map(spec=>[spec.id,spec])));
export function normalizeProviderRoute({provider,model}={},extraModels=[]) {
  const spec=listDesktopProviderDescriptors(extraModels).find(spec=>spec.id===provider);
  if(!spec)throw new Error('Select a supported, qualified provider route.');
  const requested=typeof model==='string'?model.trim():'';
  const route=spec.routes.find(route=>route.id===requested);
  if(!route)throw new Error(`Model route "${requested}" is not supported for ${spec.label}. Refresh models and select one.`);
  return {provider,model:route.id};
}
