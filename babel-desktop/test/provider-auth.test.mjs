// License: Apache-2.0
// Provider authentication attribution. Every case uses an injected transport:
// no test reaches a provider and no fixture contains a live credential.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {configureCredentialProtection,saveProviderCredential} from '../native/credentials.mjs';
import {fixtureProtection} from './credential-fixture.mjs';
import {checkConnection,AUTH_ENDPOINTS,AUTH_STATES,authReasonForStatus,projectAuthMetadata,reconcileAuthentication} from '../native/provider-auth.mjs';
configureCredentialProtection(fixtureProtection);

const KEY='BabelProviderAuthFixture0000';
const OTHER_KEY='BabelProviderAuthRotatedFixture0000';
const NOW='2026-11-11T20:00:00.000Z';

async function fixture(body){
  const config=mkdtempSync(join(tmpdir(),'babel-provider-auth-'));
  try{return await body(config);}finally{rmSync(config,{recursive:true,force:true});}
}
function response(status,body='{}',headers={}){
  return new Response(status===204?null:body,{status,headers});
}
function recorder(){
  const calls=[];
  const impl=async(url,options)=>{
    calls.push({url,options});
    return impl.response??response(200,JSON.stringify({data:{label:'fixture',limit:100,usage:7,is_free_tier:false}}));
  };
  impl.calls=calls;
  impl.response=null;
  impl.respond=value=>{impl.response=value;};
  return impl;
}
const checked=(config,fetchImpl,extra={})=>checkConnection({provider:'openrouter',scope:'private',configDirectory:config,fetchImpl,now:()=>NOW,...extra});

test('a 200 authenticates the key at that moment without qualifying any model',()=>fixture(config=>{
  saveProviderCredential({provider:'openrouter',scope:'private',configDirectory:config,apiKey:KEY});
  const fetchImpl=recorder();
  return checked(config,fetchImpl).then(receipt=>{
    assert.equal(receipt.state,'authenticated');
    assert.equal(receipt.reason,'authenticated');
    assert.equal(receipt.checkedAt,NOW);
    assert.match(receipt.observedRevision,/^[a-f0-9-]{16,64}$/);
    assert.equal(receipt.modelQualified,false);
    assert.equal(receipt.inferenceQualified,false);
    assert.equal(receipt.label,'fixture');
    assert.equal(receipt.limit,100);
    assert.equal(fetchImpl.calls.length,1);
    assert.equal(fetchImpl.calls[0].url,AUTH_ENDPOINTS.openrouter);
    assert.equal(fetchImpl.calls[0].options.method,'GET');
    assert.equal(fetchImpl.calls[0].options.redirect,'error');
    assert.equal(fetchImpl.calls[0].options.headers.Authorization,`Bearer ${KEY}`);
    assert.equal(JSON.stringify(receipt).includes(KEY),false,'No credential may cross the boundary.');
  });
}));

test('status classes stay distinct and only 401 means unauthorized',()=>fixture(async config=>{
  saveProviderCredential({provider:'openrouter',scope:'private',configDirectory:config,apiKey:KEY});
  const expected=new Map([[401,'unauthorized'],[402,'payment_required'],[403,'permission_denied'],[429,'rate_limited'],[500,'unavailable'],[503,'unavailable'],[302,'unavailable']]);
  for(const [status,state] of expected){
    const fetchImpl=recorder();fetchImpl.respond(response(status,JSON.stringify({error:{message:'provider text that must never surface',code:'fixture_code'}})));
    const receipt=await checked(config,fetchImpl);
    assert.equal(receipt.state,state,`HTTP ${status} must map to ${state}`);
    assert.equal(receipt.modelQualified,false);
    const serialized=JSON.stringify(receipt);
    assert.equal(serialized.includes('provider text that must never surface'),false,'Provider bodies must not reach the renderer.');
    assert.equal(serialized.includes('fixture_code'),false);
    assert.equal(serialized.includes(KEY),false);
  }
}));

test('network faults and timeouts are unavailable, never revoked',()=>fixture(async config=>{
  saveProviderCredential({provider:'openrouter',scope:'private',configDirectory:config,apiKey:KEY});
  for(const error of [Object.assign(new Error('fetch failed'),{name:'TypeError'}),Object.assign(new Error('aborted'),{name:'TimeoutError'}),Object.assign(new Error('aborted'),{name:'AbortError'})]){
    const receipt=await checked(config,async()=>{throw error;});
    assert.equal(receipt.state,'unavailable');
    assert.ok(['timeout','network_error'].includes(receipt.reason));
    assert.equal(JSON.stringify(receipt).includes('fetch failed'),false);
  }
}));

test('a redirect is refused rather than forwarding the credential',()=>fixture(async config=>{
  saveProviderCredential({provider:'openrouter',scope:'private',configDirectory:config,apiKey:KEY});
  let sawRedirect='error';
  const receipt=await checked(config,async(_url,options)=>{sawRedirect=options.redirect;throw Object.assign(new Error('redirect'),{name:'TypeError'});});
  assert.equal(sawRedirect,'error');
  assert.equal(receipt.state,'unavailable');
}));

test('no credential is checked without making any network request',()=>fixture(async config=>{
  const fetchImpl=recorder();
  const receipt=await checked(config,fetchImpl);
  assert.equal(receipt.state,'not_checked');
  assert.equal(receipt.reason,'no_credential');
  assert.equal(fetchImpl.calls.length,0,'An absent key must not produce a provider call.');
}));

test('a legacy-only credential is checked as stored, and the result carries no plaintext',()=>fixture(async config=>{
  writeFileSync(join(config,'.env'),`OPENROUTER_API_KEY=${KEY}\n`,{mode:0o600});
  const fetchImpl=recorder();
  const receipt=await checked(config,fetchImpl);
  assert.equal(receipt.state,'authenticated');
  assert.equal(receipt.storage,'legacy-plaintext');
  // A legacy key has no protected revision, so it reports a file identity instead.
  assert.match(receipt.observedRevision,/^legacy:\d+:\d+$/);
  assert.equal(JSON.stringify(receipt).includes(KEY),false);
}));

test('unsupported providers report unsupported rather than pretending a check happened',()=>fixture(async config=>{
  const fetchImpl=recorder();
  const receipt=await checkConnection({provider:'deepseek',scope:'private',configDirectory:config,fetchImpl,now:()=>NOW});
  assert.equal(receipt.state,'unavailable');
  assert.equal(receipt.reason,'unsupported_provider');
  assert.equal(fetchImpl.calls.length,0);
}));

test('an oversized body is not accumulated beyond the bounded read',()=>fixture(async config=>{
  saveProviderCredential({provider:'openrouter',scope:'private',configDirectory:config,apiKey:KEY});
  const receipt=await checked(config,async()=>new Response(JSON.stringify({data:{label:'x'.repeat(64000)}}),{status:200}));
  assert.equal(receipt.state,'authenticated');
  assert.equal((receipt.label??'').length<=80,true);
  assert.equal(JSON.stringify(receipt).length<2000,true);
}));

test('projected metadata is minimal and never echoes unexpected fields',()=>{
  const projected=projectAuthMetadata('openrouter',JSON.stringify({data:{label:'labelled key',limit:50,usage:3,is_free_tier:true,key:'secret-shaped-value',byok_usage_inference:9}}));
  assert.deepEqual(projected,{label:'labelled key',limit:50,usage:3,freeTier:true});
  for(const body of ['not json','','[]','null','{"data":[]}','{"data":{"label":"x".repeat(400)}}']){
    const value=projectAuthMetadata('openrouter',body);
    assert.equal(typeof value,'object');
    assert.equal(JSON.stringify(value).length<200,true);
  }
});

test('status mapping never conflates authorization with entitlement',()=>{
  for(const status of [400,404,405,418,422,499])assert.equal(authReasonForStatus(status),'unavailable');
  assert.equal(authReasonForStatus(401),'unauthorized');
  assert.equal(authReasonForStatus(403),'permission_denied');
  assert.equal(authReasonForStatus(402),'payment_required');
  assert.equal(AUTH_STATES.includes('payment_required'),true);
  assert.equal(AUTH_STATES.includes('invalid_key'),false,'There is no single "invalid key" state.');
});

test('a stale result cannot condemn a newer key, but stays attached to its own revision',()=>{
  const observed={state:'unauthorized',reason:'unauthorized',checkedAt:NOW,observedRevision:'aaa-old-revision'};
  const reconciled=reconcileAuthentication(observed,'bbb-new-revision');
  assert.equal(reconciled.state,'not_checked');
  assert.equal(reconciled.reason,'credential_changed');
  assert.equal(reconciled.observedRevision,'aaa-old-revision','The original observation is preserved, not rewritten.');
  const same=reconcileAuthentication(observed,'aaa-old-revision');
  assert.equal(same.state,'unauthorized');
  assert.deepEqual(reconcileAuthentication(null,'x'),{state:'not_checked',reason:'not_checked',checkedAt:null,observedRevision:null});
});

test('a legacy key can report an authenticated result through its nonsecret file identity',()=>fixture(async config=>{
  writeFileSync(join(config,'.env'),`OPENROUTER_API_KEY=${KEY}\n`,{mode:0o600});
  const receipt=await checked(config,recorder());
  assert.equal(receipt.state,'authenticated');
  assert.match(receipt.observedRevision,/^legacy:\d+:\d+$/,'A legacy credential needs an identity that is not the key and not a key hash.');
  assert.equal(receipt.observedRevision.includes(KEY),false);
  // The same identity reconciles to the same result.
  assert.equal(reconcileAuthentication(receipt,receipt.observedRevision).state,'authenticated');
  // An out-of-band edit invalidates the observation.
  writeFileSync(join(config,'.env'),`OPENROUTER_API_KEY=${OTHER_KEY}\n\n`,{mode:0o600});
  const fresh=await checked(config,recorder());
  assert.notEqual(fresh.observedRevision,receipt.observedRevision);
  const reconciled=reconcileAuthentication(receipt,fresh.observedRevision);
  assert.equal(reconciled.state,'not_checked');
  assert.equal(reconciled.reason,'credential_changed');
}));

test('a 200 is reported with an explicit checked time so the UI can distinguish it from "not checked"',()=>fixture(async config=>{
  saveProviderCredential({provider:'openrouter',scope:'private',configDirectory:config,apiKey:KEY});
  const receipt=await checked(config,recorder());
  assert.equal(receipt.state,'authenticated');
  assert.equal(receipt.checkedAt,NOW);
  assert.equal(Date.parse(receipt.checkedAt)>0,true);
  assert.equal(receipt.schemaVersion,1);
}));
