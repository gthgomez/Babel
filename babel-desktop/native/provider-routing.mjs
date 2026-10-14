// License: Apache-2.0 - see LICENSE
// Desktop-selected provider/model route persisted in the private Babel profile.
import {existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, lstatSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DESKTOP_ROUTE_CATALOG, listDesktopProviderDescriptors, normalizeProviderRoute,defaultModelPolicy,MODEL_ID_PATTERN} from './desktop-route-catalog.mjs';

const ROUTE_FILE = 'desktop-routing.json';
const CATALOG_BYTE_LIMIT=4*1024*1024;

async function readCatalogBody(response){
  const overflow=()=>new Error('Provider model catalog exceeded the size limit.');
  const declared=Number(response.headers?.get?.('content-length'));
  if(Number.isFinite(declared)&&declared>CATALOG_BYTE_LIMIT){await response.body?.cancel?.();throw overflow();}
  const reader=response.body?.getReader?.();
  // Injected test transports may expose text only; real fetch responses use the bounded reader.
  if(!reader){const text=await response.text();if(Buffer.byteLength(text)>CATALOG_BYTE_LIMIT)throw overflow();return text;}
  let bytes=0;const chunks=[];
  try{
    for(;;){
      const {done,value}=await reader.read();if(done)break;
      bytes+=value.byteLength;
      if(bytes>CATALOG_BYTE_LIMIT){await reader.cancel();throw overflow();}
      chunks.push(value);
    }
    return Buffer.concat(chunks,bytes).toString('utf8');
  }finally{reader.releaseLock();}
}

function writePrivateJson(path,value){
  const temporary=path+'.'+randomUUID()+'.next';
  writeFileSync(temporary,JSON.stringify(value,null,2)+'\n',{mode:0o600,flag:'wx'});
  renameSync(temporary,path);
}

export function qualifiedProviders(configDirectory=null) {
  const providers=listDesktopProviderDescriptors(cachedModels(configDirectory));
  if(configDirectory){
    try {
      const saved=JSON.parse(readFileSync(routingPath(configDirectory),'utf8'));
      for(const provider of providers){
        const preference=saved.providers?.[provider.id] ?? (provider.id===saved.provider?saved:null);
        provider.defaultModel=preference?.model;
        const enabled=preference?.enabledModels;
        if(Array.isArray(enabled))for(const route of provider.routes)route.enabled=enabled.includes(route.id);
      }
    } catch {}
  }
  return providers;
}
export function cachedModels(configDirectory){
  if(!configDirectory)return [];
  try {const path=join(resolve(configDirectory),'desktop-model-catalog.json');const info=lstatSync(path);if(!info.isFile()||info.isSymbolicLink()||info.size>4*1024*1024)return [];const data=JSON.parse(readFileSync(path,'utf8'));return Array.isArray(data.models)?data.models:[];}catch{return [];}
}
/** Public metadata only. Fixed hosts, bounded data, no credentials or inference. */
export async function refreshModelCatalog({configDirectory,provider,fetchImpl=fetch}={}) {
  const endpoints={openrouter:'https://openrouter.ai/api/v1/models','opencode-go':'https://opencode.ai/zen/go/v1/models',ollama:'http://127.0.0.1:11434/api/tags'};
  const endpoint=endpoints[provider];
  if(!endpoint)throw new Error('This provider uses the bundled CLI model catalog.');
  const response=await fetchImpl(endpoint,{headers:{Accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw new Error(`Model catalog request failed (HTTP ${response.status}). Check your connection and retry.`);
  const text=await readCatalogBody(response);
  let data;try{data=JSON.parse(text);}catch{throw new Error('Provider returned an invalid model catalog.');}
  const entries=provider==='ollama'?data.models:data.data;
  if(!Array.isArray(entries)||entries.length>5000)throw new Error('Provider returned an invalid model catalog.');
  const qualified=listDesktopProviderDescriptors().find(spec=>spec.id===provider)?.routes??[];
  const discovered=[];
  for(const entry of entries){
    const modelId=provider==='ollama'?entry.name:entry.id;
    if(typeof modelId!=='string'||!MODEL_ID_PATTERN.test(modelId))continue;
    if(provider==='openrouter'&&!entry.supported_parameters?.includes('tools'))continue;
    const existing=qualified.find(route=>route.modelId===modelId);
    // Public availability is not harness qualification. Keep exact CLI backend keys.
    if(provider!=='ollama'&&!existing)continue;
    const price=name=>{const value=Number(entry.pricing?.[name]);return Number.isFinite(value)&&value>=0?value*1e6:undefined;};
    discovered.push({id:existing?.id??`${provider}/${modelId}`,modelId,provider,label:typeof entry.name==='string'?entry.name.slice(0,160):modelId,enabled:existing?.enabled??false,
      ...(Number.isSafeInteger(entry.context_length)&&entry.context_length>0?{contextWindow:entry.context_length}:{}),inputPrice:price('prompt'),outputPrice:price('completion')});
  }
  const dir=resolve(configDirectory);mkdirSync(dir,{recursive:true,mode:0o700});
  if(lstatSync(dir).isSymbolicLink())throw new Error('Configuration directory is unsafe.');
  const path=join(dir,'desktop-model-catalog.json');
  const models=[...cachedModels(dir).filter(model=>model.provider!==provider),...discovered];
  writePrivateJson(path,{models,updatedAt:new Date().toISOString()});
  return qualifiedProviders(dir).find(spec=>spec.id===provider);
}

function routingPath(configDirectory) {
  if (typeof configDirectory !== 'string' || !configDirectory) throw new Error('Configuration directory is unavailable.');
  return join(resolve(configDirectory), ROUTE_FILE);
}

export function readProviderRoute(configDirectory) {
  const path = routingPath(configDirectory);
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    if (!value || typeof value !== 'object') return null;
    const provider = typeof value.provider === 'string' ? value.provider : null;
    const model = typeof value.model === 'string' ? value.model : null;
    if (!provider || !Object.prototype.hasOwnProperty.call(DESKTOP_ROUTE_CATALOG, provider)) return null;
    if (!model) return null;
    try {
      return normalizeProviderRoute({provider, model},cachedModels(configDirectory));
    } catch {
      return null;
    }
  } catch {
    return null;
  }
}

export function validateProviderRoute({provider, model,enabledModels} = {},configDirectory=null) {
  const extra=cachedModels(configDirectory),route=normalizeProviderRoute({provider, model},extra);
  if(enabledModels!==undefined){
    if(!Array.isArray(enabledModels)||!enabledModels.length||enabledModels.length>1000||!enabledModels.includes(route.model))throw new Error('The default model must be enabled.');
    for(const id of enabledModels)normalizeProviderRoute({provider,model:id},extra);
  }
  return route;
}

export function saveProviderRoute({configDirectory, provider, model,enabledModels} = {}) {
  const extra=cachedModels(configDirectory);
  const route = validateProviderRoute({provider, model,enabledModels},configDirectory);
  if(enabledModels!==undefined){
    if(!Array.isArray(enabledModels)||!enabledModels.length||enabledModels.length>1000||!enabledModels.includes(route.model))throw new Error('The default model must be enabled.');
    for(const id of enabledModels)normalizeProviderRoute({provider,model:id},extra);
  }
  const dir = resolve(configDirectory);
  mkdirSync(dir, {recursive: true, mode: 0o700});
  const info = lstatSync(dir);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Configuration directory is unsafe.');
  const path = join(dir, ROUTE_FILE);
  let previous={};try{const info=lstatSync(path);if(!info.isFile()||info.isSymbolicLink()||info.nlink>1||info.size>256*1024)throw new Error('Routing settings are unsafe.');previous=JSON.parse(readFileSync(path,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
  const enabled=enabledModels?[...new Set(enabledModels)]:[route.model];
  let policy=defaultModelPolicy();
  const policyPath=join(dir,'model-policy.json');
  if(existsSync(policyPath)){const info=lstatSync(policyPath);if(!info.isFile()||info.isSymbolicLink()||info.nlink>1||info.size>4*1024*1024)throw new Error('Model policy is unsafe.');policy=JSON.parse(readFileSync(policyPath,'utf8'));if(!policy.models||typeof policy.models!=='object')throw new Error('Model policy is invalid.');}
  for(const descriptor of listDesktopProviderDescriptors(extra))for(const entry of descriptor.routes){
    if(!policy.models[entry.id])policy.models[entry.id]={provider:entry.provider,model_id:entry.modelId,tier:'standard',enabled:false,native_tool_use:true,
      ...(Number.isFinite(entry.contextWindow)?{context_window:entry.contextWindow}:{}),
      ...(Number.isFinite(entry.inputPrice)?{estimated_cost_per_1m_input:entry.inputPrice}:{}),
      ...(Number.isFinite(entry.outputPrice)?{estimated_cost_per_1m_output:entry.outputPrice}:{})};
    if(entry.provider===provider){
      if(policy.models[entry.id].provider!==provider||policy.models[entry.id].model_id!==entry.modelId)throw new Error('Saved model policy conflicts with the selected provider identity.');
      policy.models[entry.id].enabled=enabled.includes(entry.id);
    }
  }
  writePrivateJson(policyPath,policy);
  writePrivateJson(path,{...route,enabledModels:enabled,providers:{...previous.providers,[provider]:{model:route.model,enabledModels:enabled}},updatedAt:new Date().toISOString()});
  return route;
}

/** Bind auxiliary calls to the validated provider model ID for this run. */
export function applySelectedModelEnvironment(env, model) {
  if (!model || typeof model.modelId !== 'string' || !/^[\w./:+-]{1,200}$/.test(model.modelId)) throw new TypeError('A qualified provider model ID is required');
  env.BABEL_COMPACTION_MODEL=model.modelId;
  env.BABEL_DIFF_CRITIC_MODEL=model.modelId;
  env.BABEL_DIFF_CRITIC_PRO_MODEL=model.modelId;
  // Auxiliary credentials/endpoints cannot override the selected provider.
  delete env.BABEL_COMPACTION_API_KEY;
  delete env.BABEL_COMPACTION_API_BASE;
  return env;
}


/** Apply route env overrides for the CLI child without exposing secrets. */
export function applyProviderRoute(env, configDirectory) {
  const route = readProviderRoute(configDirectory);
  if (!route) return env;
  // The private Desktop policy is the one the Desktop writes, in source and installed runs.
  const policyPath=join(resolve(configDirectory),'model-policy.json');
  if(existsSync(policyPath))env.BABEL_MODEL_POLICY_PATH=policyPath;
  const spec = DESKTOP_ROUTE_CATALOG[route.provider];
  const selectedModel=qualifiedProviders(configDirectory).find(p=>p.id===route.provider)?.routes.find(m=>m.id===route.model);
  if(!selectedModel)throw new Error('The saved model route is unavailable. Choose a model in Settings.');
  applySelectedModelEnvironment(env,selectedModel);
  if (route.provider==='openrouter') {
    env.BABEL_LITE_OFFLINE = '0';
    const entry=qualifiedProviders(configDirectory).find(p=>p.id===route.provider).routes.find(m=>m.id===route.model);
    env.BABEL_COMPACTION_MODEL = entry.modelId;
    env.BABEL_COMPACTION_API_BASE='https://openrouter.ai/api/v1/chat/completions';
    env.BABEL_DIFF_CRITIC_MODEL = entry.modelId;
  }
  if (spec.local) env.BABEL_LITE_OFFLINE = '1';
  else env.BABEL_LITE_OFFLINE = '0';
  env.BABEL_DESKTOP_PROVIDER = route.provider;
  env.BABEL_DESKTOP_MODEL_ROUTE = route.model;
  return env;
}
