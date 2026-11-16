import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {applyCliCredentialScope} from '../native/childEnv.mjs';
import {saveProviderRoute} from '../native/provider-routing.mjs';
import {fixtureProtection} from './credential-fixture.mjs';
import {configureCredentialProtection,configureSharedCredentialService,saveProviderCredential,shareProviderCredential,
  providerCredentialStatus,connectionCredentialReadiness,removeProviderCredential,applyNativeCredentialEnvironment,assertStandaloneCredentialCompatibility} from '../native/credentials.mjs';

configureCredentialProtection(fixtureProtection);
function fixture(){
  const configDirectory=join(mkdtempSync(join(tmpdir(),'babel-shared-desktop-')),'config');
  const accounts=new Map();let revision=0;
  const service={
    register({id,provider,key}){if(accounts.has(id))throw Error('collision');accounts.set(id,{provider,key,ref:`fixture-${++revision}`});return accounts.get(id).ref;},
    reference(id,provider){const account=accounts.get(id);if(!account||account.provider!==provider)throw Error('missing');return account.ref;},
    read(id,provider){const account=accounts.get(id);if(!account||account.provider!==provider||!account.key)throw Error('missing');return account.key;},
    replace(id,provider,key){const account=accounts.get(id);if(!account||account.provider!==provider)throw Error('missing');account.key=key;account.ref=`fixture-${++revision}`;return account.ref;},
    remove(id,provider,onRemoved){const account=accounts.get(id);if(!account||account.provider!==provider)throw Error('missing');account.key=null;onRemoved?.();return true;},
  };
  configureSharedCredentialService(service);
  return {configDirectory,accounts};
}
const key='fixtureKey01';

test('explicit sharing keeps the encrypted recovery copy but both interfaces use the shared account',()=>{
  const {configDirectory}=fixture();
  saveProviderCredential({provider:'openrouter',apiKey:key,configDirectory});
  assert.throws(()=>shareProviderCredential({provider:'openrouter',configDirectory,model:'vendor/model'}),/confirm/i);
  assert.throws(()=>assertStandaloneCredentialCompatibility(configDirectory),/Desktop-managed/i);
  const receipt=shareProviderCredential({provider:'openrouter',configDirectory,model:'vendor/model',confirm:true});
  assert.equal(receipt.shared,true);
  assert.equal(providerCredentialStatus({provider:'openrouter',configDirectory}).storage,'shared-os');
  const raw=readFileSync(join(configDirectory,'desktop-credentials.json'),'utf8');
  assert.equal(raw.includes(key),false);
  assert.equal(JSON.parse(raw).schemaVersion,2);
  assert.equal(assertStandaloneCredentialCompatibility(configDirectory).openrouter,receipt.connectionId);
  saveProviderRoute({configDirectory,provider:'openrouter',model:'deepseek-v4-flash-openrouter'});
  const home=mkdtempSync(join(tmpdir(),'babel-shared-home-'));
  const cliEnv={USERPROFILE:home,HOME:home,OPENROUTER_API_KEY:'wrong-account'};
  applyCliCredentialScope(cliEnv,{args:['doctor'],cwd:home,configDirectory});
  assert.equal(cliEnv.BABEL_CONNECTION,receipt.connectionId);
  assert.equal(cliEnv.BABEL_PREFERENCES_FILE,join(home,'.babel','preferences.json'));
  assert.equal(cliEnv.OPENROUTER_API_KEY,undefined);
  assert.equal(cliEnv.BABEL_DESKTOP_CREDENTIALS_RESOLVED,'1');
  assert.equal(cliEnv.BABEL_DESKTOP_PROVIDER,undefined);
  assert.equal(cliEnv.BABEL_DESKTOP_MODEL_ROUTE,undefined);
  assert.equal(cliEnv.BABEL_MODEL,'deepseek/deepseek-v4-flash-0731');
  const env={OPENROUTER_API_KEY:'wrong-account'};
  applyNativeCredentialEnvironment(env,{provider:'openrouter',configDirectory});
  assert.equal(env.OPENROUTER_API_KEY,key);
  saveProviderCredential({provider:'openrouter',apiKey:'fixtureKey02',configDirectory,operation:'replace_protected'});
  applyNativeCredentialEnvironment(env,{provider:'openrouter',configDirectory});
  assert.equal(env.OPENROUTER_API_KEY,'fixtureKey02');
  removeProviderCredential({provider:'openrouter',scope:'private',configDirectory});
  applyNativeCredentialEnvironment(env,{provider:'openrouter',configDirectory});
  assert.equal(env.OPENROUTER_API_KEY,undefined);
  assert.throws(()=>assertStandaloneCredentialCompatibility(configDirectory),/Desktop-managed/i);
});

test('a missing shared account never falls back to retained ciphertext or ambient keys',()=>{
  const {configDirectory,accounts}=fixture();
  saveProviderCredential({provider:'openrouter',apiKey:key,configDirectory});
  const shared=shareProviderCredential({provider:'openrouter',configDirectory,confirm:true});
  accounts.delete(shared.connectionId);
  const env={OPENROUTER_API_KEY:'wrong-account'};
  assert.throws(()=>applyNativeCredentialEnvironment(env,{provider:'openrouter',configDirectory}),/missing|unavailable/i);
  assert.equal(env.OPENROUTER_API_KEY,undefined);
  assert.equal(providerCredentialStatus({provider:'openrouter',configDirectory}).configured,false);
});

test('shared metadata alone does not claim the protected key was checked',()=>{
  const {configDirectory,accounts}=fixture();
  saveProviderCredential({provider:'openrouter',apiKey:key,configDirectory});
  const shared=shareProviderCredential({provider:'openrouter',configDirectory,confirm:true});
  // Simulate a deleted or locked key while its connection metadata survives.
  accounts.get(shared.connectionId).key=null;
  const status=providerCredentialStatus({provider:'openrouter',configDirectory});
  assert.equal(status.sharedReady,null);
  assert.equal(connectionCredentialReadiness({route:{provider:'openrouter',model:'fixture'},configDirectory}).state,'configured_unverified');
  const env={OPENROUTER_API_KEY:'wrong-account'};
  assert.throws(()=>applyNativeCredentialEnvironment(env,{provider:'openrouter',configDirectory}),/missing|unavailable/i);
  assert.equal(env.OPENROUTER_API_KEY,undefined);
});
