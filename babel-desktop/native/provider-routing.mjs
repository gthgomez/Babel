// License: Apache-2.0 - see LICENSE
// Desktop-selected provider/model route persisted in the private Babel profile.
import {existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, lstatSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DESKTOP_ROUTE_CATALOG, listDesktopProviderDescriptors, normalizeProviderRoute,defaultModelPolicy} from './desktop-route-catalog.mjs';
import {MODEL_CATALOG_ENDPOINTS,parseModelCatalog} from './model-catalog.mjs';

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
  const catalog=readCatalogCache(configDirectory);
  for(const provider of providers){
    provider.catalog=catalog.providers?.[provider.id]??{status:'bundled',fetchedAt:null};
    if(catalog.schemaVersion!==undefined&&catalog.schemaVersion!==1){
      provider.catalog={status:'incompatible',fetchedAt:null};
      for(const route of provider.routes){route.selectable=false;route.unavailableReason='This catalog needs a newer Babel version. Existing history remains readable.';}
    }else if(provider.catalog.status==='fresh'&&Date.now()-Date.parse(provider.catalog.fetchedAt)>86400000){
      provider.catalog={...provider.catalog,status:'stale'};
    }
  }
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
  const models=readCatalogCache(configDirectory).models;
  return Array.isArray(models)?models:[];
}
function readCatalogCache(configDirectory){
  if(!configDirectory)return {};
  try {const path=join(resolve(configDirectory),'desktop-model-catalog.json');const info=lstatSync(path);if(!info.isFile()||info.isSymbolicLink()||info.nlink>1||info.size>CATALOG_BYTE_LIMIT)return {};const data=JSON.parse(readFileSync(path,'utf8'));return data&&typeof data==='object'&&!Array.isArray(data)?data:{};}catch{return {};}
}
/** Fixed official metadata endpoints only; never makes an inference request. */
export async function refreshModelCatalog({configDirectory,provider,credential,fetchImpl=fetch}={}) {
  const endpoint=MODEL_CATALOG_ENDPOINTS[provider];
  if(!endpoint)throw new Error('Select a supported provider catalog.');
  if(typeof configDirectory!=='string'||!configDirectory)throw new Error('Configuration directory is unavailable.');
  const dir=resolve(configDirectory);mkdirSync(dir,{recursive:true,mode:0o700});
  if(lstatSync(dir).isSymbolicLink())throw new Error('Configuration directory is unsafe.');
  const path=join(dir,'desktop-model-catalog.json');
  if(existsSync(path)){
    const info=lstatSync(path);
    if(!info.isFile()||info.isSymbolicLink()||info.nlink>1||info.size>CATALOG_BYTE_LIMIT)throw new Error('The catalog cache is unsafe or too large. Existing data was preserved.');
    try{JSON.parse(readFileSync(path,'utf8'));}catch{throw new Error('The catalog cache is invalid. Existing data was preserved.');}
  }
  const previous=readCatalogCache(dir),fetchedAt=new Date().toISOString();
  if(previous.schemaVersion!==undefined&&previous.schemaVersion!==1)throw new Error('This catalog needs a newer Babel version. No data was changed.');
  const known=listDesktopProviderDescriptors().find(spec=>spec.id===provider)?.routes??[];
  let discovered;
  try{
    const headers={Accept:'application/json'};
    if(provider==='deepseek'&&typeof credential==='string'&&credential&&!/[\r\n\0]/.test(credential))headers.Authorization=`Bearer ${credential}`;
    const response=await fetchImpl(endpoint,{headers,redirect:'error',signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw new Error(response.status===401?'Catalog authentication is required. Save a credential for this provider.':`Model catalog request failed (HTTP ${response.status}). Check your connection and retry.`);
    const text=await readCatalogBody(response);
    let data;try{data=JSON.parse(text);}catch{throw new Error('Provider returned an invalid model catalog.');}
    discovered=parseModelCatalog(provider,data,known,fetchedAt);
  }catch(error){
    // Never retain raw fetch errors or provider response bodies in diagnostics/cache.
    if(previous.models)writePrivateJson(path,{...previous,providers:{...previous.providers,[provider]:{...previous.providers?.[provider],status:'cached',lastAttemptAt:fetchedAt}}});
    if(error instanceof Error&&/^(Provider returned|Provider model catalog|Model catalog request|Catalog authentication)/.test(error.message))throw error;
    throw new Error('Model catalog refresh failed. Cached choices are retained; check your connection and retry.');
  }
  const discoveredIds=new Set(discovered.map(model=>model.modelId));
  const oldModels=new Map([...known,...(previous.models??[]).filter(model=>model.provider===provider)].map(model=>[model.id,model]));
  const removed=[...oldModels.values()].filter(model=>!discoveredIds.has(model.modelId)).map(model=>({...model,selectable:false,unavailableReason:'This model is no longer listed by the provider.',accountAvailability:'unavailable'}));
  const models=[...(previous.models??[]).filter(model=>model.provider!==provider),...discovered,...removed];
  const next={...previous,schemaVersion:1,models,providers:{...previous.providers,[provider]:{status:'fresh',source:endpoint,fetchedAt}},updatedAt:fetchedAt};
  if(Buffer.byteLength(JSON.stringify(next,null,2))+1>CATALOG_BYTE_LIMIT)throw new Error('Provider model catalog exceeded the size limit.');
  writePrivateJson(path,next);
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
  const bundled=defaultModelPolicy();
  const catalogAccepted=extra.some(entry=>entry.id===route.model&&entry.provider===provider&&entry.enabled!==false);
  if(!bundled.models?.[route.model]&&!catalogAccepted)throw new Error(`Model route "${route.model}" is not supported for ${DESKTOP_ROUTE_CATALOG[provider]?.label ?? provider}. Refresh models and select one.`);
  const available=qualifiedProviders(configDirectory).find(spec=>spec.id===provider)?.routes.find(entry=>entry.id===model);
  if(available?.selectable===false)throw new Error(available.unavailableReason||'This model is unavailable.');
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
    if(entry.selectable===false)continue;
    if(!policy.models[entry.id])policy.models[entry.id]={provider:entry.provider,model_id:entry.modelId,tier:'standard',enabled:false,native_tool_use:entry.capabilities?.tools===true,
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
