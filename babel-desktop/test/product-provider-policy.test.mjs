import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {configureCredentialProtection,connectionCredentialReadiness,saveProviderCredential} from '../native/credentials.mjs';
import {saveProviderRoute,refreshModelCatalog} from '../native/provider-routing.mjs';
import {saveDesktopProviderRoute} from '../native/provider-route-save.mjs';
import {checkConnection} from '../native/provider-auth.mjs';
import {fixtureProtection} from './credential-fixture.mjs';

configureCredentialProtection(fixtureProtection);

test('legacy provider records are preserved but are not presented as usable product connections',async()=>{
  const config=mkdtempSync(join(tmpdir(),'babel-desktop-product-policy-'));
  try{
    saveProviderCredential({provider:'deepseek',scope:'private',configDirectory:config,apiKey:'synthetic-fixture-token'});
    saveProviderRoute({configDirectory:config,provider:'deepseek',model:'deepseek-v4-pro'});
    const before=readFileSync(join(config,'desktop-routing.json'));
    const route={provider:'deepseek',model:'deepseek-v4-pro'};
    assert.equal(connectionCredentialReadiness({route,configDirectory:config}).state,'unsupported_provider');
    await assert.rejects(()=>saveDesktopProviderRoute({options:{...route,scope:'private'},configDirectory:config,
      preferences:{projectRoot:null,projectCredentialRoot:null},savePreferences:async()=>{}}),/supported|approved/i);
    assert.deepEqual(readFileSync(join(config,'desktop-routing.json')),before);
  }finally{rmSync(config,{recursive:true,force:true});}
});

test('offline Desktop does not make provider authentication or model-discovery requests',async()=>{
  const config=mkdtempSync(join(tmpdir(),'babel-desktop-offline-'));const old=process.env.BABEL_OFFLINE;let calls=0;
  try{
    process.env.BABEL_OFFLINE='1';
    const fetchImpl=async()=>{calls++;return new Response('{}',{status:200});};
    const status=await checkConnection({provider:'openrouter',configDirectory:config,fetchImpl});
    assert.equal(status.state,'unavailable');assert.equal(status.reason,'offline');
    await assert.rejects(()=>refreshModelCatalog({provider:'openrouter',configDirectory:config,fetchImpl}),/offline/i);
    assert.equal(calls,0);
  }finally{
    if(old===undefined)delete process.env.BABEL_OFFLINE;else process.env.BABEL_OFFLINE=old;
    rmSync(config,{recursive:true,force:true});
  }
});
