// License: Apache-2.0 — see LICENSE
import {MODEL_ID_PATTERN} from './desktop-route-catalog.mjs';

export const MODEL_CATALOG_ENDPOINTS=Object.freeze({
  openrouter:'https://openrouter.ai/api/v1/models',
  deepseek:'https://api.deepseek.com/models',
  deepinfra:'https://api.deepinfra.com/models/list',
  'opencode-go':'https://opencode.ai/zen/go/v1/models',
  ollama:'http://127.0.0.1:11434/api/tags',
});
const positive=value=>Number.isSafeInteger(value)&&value>0?value:undefined;
const rate=(value,multiplier)=>value!==null&&value!==undefined&&value!==''&&Number.isFinite(Number(value)*multiplier)&&Number(value)>=0?Number(value)*multiplier:undefined;
const modalities=value=>Array.isArray(value)?value.filter(item=>typeof item==='string').slice(0,20):null;
const NON_CONVERSATION_TYPES=new Set(['text-to-image','text-to-speech','embeddings','text-to-video','reranker','automatic-speech-recognition','zero-shot-image-classification','text-to-music']);

/** Project public metadata only. Catalog presence never establishes live qualification. */
export function parseModelCatalog(provider,data,knownRoutes,fetchedAt) {
  const entries=provider==='ollama'?data?.models:provider==='deepinfra'?data:data?.data;
  if(!Array.isArray(entries)||entries.length>5000)throw new Error('Provider returned an invalid model catalog.');
  const seen=new Set(),models=[];
  for(const entry of entries){
    if(!entry||typeof entry!=='object')continue;
    const modelId=provider==='ollama'?entry.name:provider==='deepinfra'?entry.model_name:entry.id;
    if(typeof modelId!=='string'||!MODEL_ID_PATTERN.test(modelId)||seen.has(modelId))continue;
    seen.add(modelId);
    const existing=knownRoutes.find(route=>route.modelId===modelId);
    const input=modalities(entry.architecture?.input_modalities??entry.input_modalities);
    const output=modalities(entry.architecture?.output_modalities??entry.output_modalities);
    const conversation=provider==='deepinfra'?(entry.type==='text-generation'?true:NON_CONVERSATION_TYPES.has(entry.type)?false:null):output?output.includes('text'):null;
    const tools=Array.isArray(entry.supported_parameters)?entry.supported_parameters.includes('tools'):null;
    const deprecated=Boolean(entry.deprecated);
    const adapterSupported=provider!=='opencode-go'||Boolean(existing);
    const unavailableReason=deprecated?'Provider marks this model deprecated.':conversation===false?'This model does not provide text conversation.':!adapterSupported?'This model needs a compatible Babel adapter.':'';
    const id=existing?.id??`${provider}/${modelId}`;
    // Route IDs must fit the same public CLI argument contract as existing routes.
    if(id.length>200)continue;
    models.push({id,modelId,provider,
      label:typeof entry.name==='string'?entry.name.slice(0,160):modelId,
      enabled:existing?.enabled??false,selectable:!unavailableReason,unavailableReason,
      adapterSupport:adapterSupported?'supported':'unsupported',qualification:'unverified',
      accountAvailability:provider==='ollama'?'installed':'unknown',
      locality:provider==='ollama'?(entry.remote_host||entry.remote_model?'cloud':'unknown'):'cloud',
      capabilities:{conversation,tools,vision:input?input.includes('image'):null,inputModalities:input,outputModalities:output},
      deprecated,replacedBy:typeof entry.replaced_by==='string'?entry.replaced_by.slice(0,200):null,
      contextWindow:positive(entry.context_length??entry.context_window??entry.max_tokens),
      inputPrice:provider==='deepinfra'?rate(entry.pricing?.cents_per_input_token,10000):rate(entry.pricing?.prompt,1e6),
      outputPrice:provider==='deepinfra'?rate(entry.pricing?.cents_per_output_token,10000):rate(entry.pricing?.completion,1e6),
      source:MODEL_CATALOG_ENDPOINTS[provider],fetchedAt,
    });
  }
  return models;
}
