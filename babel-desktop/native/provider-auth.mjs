// License: Apache-2.0
// Native provider authentication check. Fixed endpoints only: the renderer never
// supplies a URL, and a 200 here establishes authorization at that moment, not
// model entitlement, tool support, spending capacity or successful inference.
import {applyNativeCredentialEnvironment,providerCredentialStatus} from './credentials.mjs';

/** Documented, non-inference authorization endpoints. */
export const AUTH_ENDPOINTS=Object.freeze({openrouter:'https://openrouter.ai/api/v1/key'});

/** Environment names owned by the native credential authority. */
const PROVIDER_KEY_NAMES=Object.freeze({
  openrouter:'OPENROUTER_API_KEY',deepseek:'DEEPSEEK_API_KEY',deepinfra:'DEEPINFRA_API_KEY',
  'command-code':'COMMAND_CODE_API_KEY','opencode-go':'BABEL_OPENCODE_GO_API_KEY',
});

/** Distinct outcomes. `unavailable` never means the key was revoked. */
export const AUTH_STATES=Object.freeze([
  'not_checked','authenticated','unauthorized','permission_denied','payment_required','rate_limited','unavailable',
]);

const REQUEST_TIMEOUT_MS=8000;
const BODY_LIMIT=16*1024;

function bounded(value,max=200){
  if(typeof value!=='string')return null;
  const text=value.replace(/[\r\n\t]+/g,' ').trim();
  return text?text.slice(0,max):null;
}

/** Map an HTTP status to a reason. Only 401 means the request was unauthorized. */
export function authReasonForStatus(status){
  if(status===200)return 'authenticated';
  if(status===401)return 'unauthorized';
  if(status===402)return 'payment_required';
  if(status===403)return 'permission_denied';
  if(status===429)return 'rate_limited';
  return 'unavailable';
}

/**
 * Extract only bounded, non-secret metadata from a documented 200 body.
 * Raw provider bodies, headers and authorization echoes never leave this module.
 */
export function projectAuthMetadata(provider,body){
  if(provider!=='openrouter')return {};
  try{
    const parsed=JSON.parse(body);
    const data=parsed?.data;
    if(!data||typeof data!=='object'||Array.isArray(data))return {};
    const projected={};
    const label=bounded(data.label,80);
    if(label)projected.label=label;
    // This is documented usage metadata, never a credential or balance claim.
    if(Number.isFinite(data.limit))projected.limit=data.limit;
    if(Number.isFinite(data.usage))projected.usage=data.usage;
    if(data.limit===null)projected.limit=null;
    if(typeof data.is_free_tier==='boolean')projected.freeTier=data.is_free_tier;
    return projected;
  }catch{return {};}
}

async function readBoundedBody(response){
  const declared=Number(response.headers?.get?.('content-length'));
  if(Number.isFinite(declared)&&declared>BODY_LIMIT){await response.body?.cancel?.();return '';}
  const reader=response.body?.getReader?.();
  if(!reader){const text=await response.text();return text.length>BODY_LIMIT?text.slice(0,BODY_LIMIT):text;}
  let bytes=0;const chunks=[];
  try{
    for(;;){
      const {done,value}=await reader.read();if(done)break;
      bytes+=value.byteLength;
      if(bytes>BODY_LIMIT){await reader.cancel();return Buffer.concat(chunks).toString('utf8');}
      chunks.push(value);
    }
    return Buffer.concat(chunks,bytes).toString('utf8');
  }finally{reader.releaseLock();}
}

/**
 * Check the credential native authority actually selected for this provider and
 * scope. Never accepts a renderer-supplied key or endpoint.
 *
 * @returns a structured, serializable envelope; it never throws for provider or
 *          network outcomes so the caller can always render a truthful state.
 */
export async function checkConnection({
  provider,scope='private',configDirectory,projectRoot,
  fetchImpl=fetch,now=()=>new Date().toISOString(),
}={}){
  const endpoint=Object.hasOwn(AUTH_ENDPOINTS,provider)?AUTH_ENDPOINTS[provider]:null;
  if(!endpoint)return envelope({provider,state:'unavailable',reason:'unsupported_provider',checkedAt:now()});
  let status;
  try{status=providerCredentialStatus({provider,scope,configDirectory,projectRoot});}
  catch(error){return envelope({provider,state:'unavailable',reason:'credential_unreadable',checkedAt:now()});}
  if(!status.present)return envelope({provider,state:'not_checked',reason:'no_credential',checkedAt:now(),storage:status.storage,revision:status.credentialIdentity});
  // Resolve the selected credential in this process only; it is never returned.
  let key=null;
  try{key=resolveKey({provider,scope,configDirectory,projectRoot});}
  catch{return envelope({provider,state:'unavailable',reason:'credential_unreadable',checkedAt:now(),storage:status.storage,revision:status.credentialIdentity});}
  if(!key)return envelope({provider,state:'not_checked',reason:'no_credential',checkedAt:now(),storage:status.storage,revision:status.credentialIdentity});

  let response;
  try{
    response=await fetchImpl(endpoint,{
      method:'GET',
      headers:{Authorization:`Bearer ${key}`,Accept:'application/json'},
      // A redirect could move the credential to another origin.
      redirect:'error',
      signal:AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  }catch(error){
    const code=error?.name==='TimeoutError'||error?.name==='AbortError'?'timeout':'network_error';
    return envelope({provider,state:'unavailable',reason:code,checkedAt:now(),storage:status.storage,revision:status.credentialIdentity});
  }
  const reason=authReasonForStatus(response.status);
  let metadata={};
  if(reason==='authenticated'){
    try{metadata=projectAuthMetadata(provider,await readBoundedBody(response));}
    catch{metadata={};}
  }else{
    // Drain without retaining any provider text.
    try{await response.body?.cancel?.();}catch{/* nothing to release */}
  }
  return envelope({provider,state:reason,reason,checkedAt:now(),storage:status.storage,revision:status.credentialIdentity,...metadata});
}

function envelope(value){
  const state=AUTH_STATES.includes(value.state)?value.state:'unavailable';
  return {
    schemaVersion:1,
    provider:value.provider,
    state,
    reason:value.reason??state,
    checkedAt:value.checkedAt??null,
    // Equality identity of the credential measured, never the key or a key hash.
    observedRevision:value.revision??null,
    storage:value.storage??'unknown',
    // A key check never establishes model or inference readiness.
    modelQualified:false,
    inferenceQualified:false,
    ...(value.label?{label:value.label}:{}),
    ...(value.limit!==undefined?{limit:value.limit}:{}),
    ...(value.usage!==undefined?{usage:value.usage}:{}),
    ...(value.freeTier!==undefined?{freeTier:value.freeTier}:{}),
  };
}

/** Resolve the exact credential the native authority owns for this selection. */
function resolveKey({provider,scope,configDirectory,projectRoot}){
  const name=PROVIDER_KEY_NAMES[provider];
  if(!name)return null;
  const env={};
  applyNativeCredentialEnvironment(env,{provider,scope,configDirectory,projectRoot});
  return env[name]??null;
}

/** A stale observation must never condemn a newer stored key. */
export function reconcileAuthentication(observed,currentIdentity){
  if(!observed||typeof observed!=='object')return {state:'not_checked',reason:'not_checked',checkedAt:null,observedRevision:null};
  const state=AUTH_STATES.includes(observed.state)?observed.state:'not_checked';
  // Authorization belongs only to the credential it was measured on. A legacy
  // plaintext key has no revision but still has a nonsecret file identity.
  const measured=observed.observedRevision??observed.observedIdentity??null;
  const same=Boolean(measured)&&measured===currentIdentity;
  if(!same&&['authenticated','unauthorized','permission_denied','payment_required'].includes(state)){
    return {state:'not_checked',reason:'credential_changed',checkedAt:observed.checkedAt??null,observedRevision:observed.observedRevision??null};
  }
  return {state,reason:observed.reason??state,checkedAt:observed.checkedAt??null,observedRevision:observed.observedRevision??null};
}
