// License: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync,existsSync,mkdirSync,linkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import * as credentials from '../native/credentials.mjs';
import {fixtureProtection} from './credential-fixture.mjs';
const TOKEN='BabelCredentialLifecycleFixture0000',SECOND='BabelCredentialReplacementFixture0000';
credentials.configureCredentialProtection?.(fixtureProtection);
function fixture(body){const configDirectory=mkdtempSync(join(tmpdir(),'babel-credential-lifecycle-'));try{return body(configDirectory);}finally{rmSync(configDirectory,{recursive:true,force:true});}}
function save(configDirectory,extra={}){return credentials.saveProviderCredential({provider:'deepseek',scope:'private',apiKey:TOKEN,configDirectory,...extra});}

test('private add uses protected bytes and replacement/removal preserve another provider',()=>fixture(config=>{
  const result=save(config);assert.equal(result.configured,true);
  assert.equal(existsSync(join(config,'.env')),false);
  assert.equal(existsSync(join(config,'desktop-credentials.json')),true);
  assert.equal(readFileSync(join(config,'desktop-credentials.json'),'utf8').includes(TOKEN),false);
  save(config,{provider:'openrouter'});
  assert.throws(()=>save(config),/already/);
  save(config,{operation:'replace',apiKey:SECOND});
  const env={};credentials.applyNativeCredentialEnvironment(env,{configDirectory:config,provider:'deepseek'});
  assert.equal(env.DEEPSEEK_API_KEY===SECOND,true);assert.equal(env.OPENROUTER_API_KEY,undefined);
  credentials.removeProviderCredential({configDirectory:config,provider:'deepseek',scope:'private'});
  assert.equal(credentials.hasProviderCredential({configDirectory:config,provider:'deepseek'}),false);
  assert.equal(credentials.hasProviderCredential({configDirectory:config,provider:'openrouter'}),true);
}));

test('unavailable and insecure OS backends fail closed without plaintext fallback or secret errors',()=>fixture(config=>{
  for(const protection of [{isEncryptionAvailable:()=>false},{...fixtureProtection,getSelectedStorageBackend:()=> 'basic_text'},{...fixtureProtection,encryptString(){throw new Error(TOKEN);}}]){
    credentials.configureCredentialProtection?.(protection);
    let error;try{save(config);}catch(value){error=value;}
    assert.equal(Boolean(error),true);assert.equal(String(error).includes(TOKEN),false);
    assert.equal(existsSync(join(config,'.env')),false);
  }
  credentials.configureCredentialProtection?.(fixtureProtection);
}));

test('future and malformed protected stores are preserved and reject mutations',()=>fixture(config=>{
  const path=join(config,'desktop-credentials.json');
  for(const data of ['{invalid',JSON.stringify({schemaVersion:99,entries:{}})]){
    writeFileSync(path,data,{mode:0o600});
    assert.throws(()=>save(config),/read-only|unsupported|invalid/i);
    assert.equal(readFileSync(path,'utf8'),data);
  }
}));

test('explicit per-provider legacy migration retains original bytes and cannot resurrect a removed key',()=>fixture(config=>{
  const original=`# recovery fixture\nDEEPSEEK_API_KEY=${TOKEN}\nOPENROUTER_API_KEY=${SECOND}\nUNRELATED=preserved\n`;
  writeFileSync(join(config,'.env'),original,{mode:0o600});
  assert.throws(()=>save(config,{operation:'replace'}),/migrat/i);
  const result=credentials.migrateProviderCredential({configDirectory:config,provider:'deepseek',confirm:true});
  assert.equal(result.migrated,true);assert.equal(readFileSync(join(config,'.env'),'utf8')===original,true);
  credentials.removeProviderCredential({configDirectory:config,provider:'deepseek',scope:'private'});
  assert.equal(credentials.hasProviderCredential({configDirectory:config,provider:'deepseek'}),false);
  credentials.migrateProviderCredential({configDirectory:config,provider:'deepseek',confirm:true});
  assert.equal(credentials.hasProviderCredential({configDirectory:config,provider:'deepseek'}),false);
  const env={DEEPSEEK_API_KEY:'ambient',OPENROUTER_API_KEY:'ambient'};
  credentials.applyNativeCredentialEnvironment(env,{configDirectory:config,provider:'deepseek'});
  assert.equal(env.DEEPSEEK_API_KEY,undefined);assert.equal(env.OPENROUTER_API_KEY,undefined);
  assert.equal(env.BABEL_DESKTOP_CREDENTIALS_RESOLVED,'1');
  assert.equal(credentials.hasProviderCredential({configDirectory:config,provider:'openrouter'}),true);
}));

test('hardlinked protected store is rejected without touching linked evidence',()=>fixture(config=>{
  const evidence=join(config,'evidence');writeFileSync(evidence,'{}',{mode:0o600});
  linkSync(evidence,join(config,'desktop-credentials.json'));
  assert.throws(()=>save(config),/unsafe|unlinked/i);
  assert.equal(readFileSync(evidence,'utf8'),'{}');
}));

test('native credential handoff strips unselected registered and auxiliary credentials',()=>fixture(config=>{
  save(config);
  const names=['OPENCODE_API_KEY','OPENAI_API_KEY','ANTHROPIC_API_KEY','GEMINI_API_KEY','GROQ_API_KEY','BABEL_COMPACTION_API_KEY','BABEL_OPENCODE_GO_HELPER'];
  const env=Object.fromEntries(names.map(name=>[name,'synthetic-ambient-value']));
  credentials.applyNativeCredentialEnvironment(env,{configDirectory:config,provider:'deepseek'});
  for(const name of names)assert.equal(env[name],undefined,'Unselected native credential was inherited');
  assert.equal(env.DEEPSEEK_API_KEY===TOKEN,true);
}));
