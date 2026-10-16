// License: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync,existsSync,readFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {runInNewContext} from 'node:vm';
import * as credentials from '../native/credentials.mjs';
import {fixtureProtection} from './credential-fixture.mjs';
credentials.configureCredentialProtection(fixtureProtection);
const source=readFileSync(new URL('../native/main.mjs',import.meta.url),'utf8');
function contextBinding(preferences,authority){
 const code=source.slice(source.indexOf('const credentialBindings='),source.indexOf('function validateSender'));
 return runInNewContext(code+';({credentialBindings,credentialRequestContext})',{preferences,projectAuthority:authority,runtimeEnvironment:()=>({BABEL_CONFIG_DIR:join(tmpdir(),'binding-config')})});
}
test('native credential binding rejects destination drift and trust revoked during admission',async()=>{
 const preferences={projectRoot:join(tmpdir(),'project-a')};let release;
 const authority={generation:0,admit:async()=>new Promise(resolve=>{release=()=>resolve({});}),isCurrent:()=>true};
 const {credentialBindings,credentialRequestContext}=contextBinding(preferences,authority);
 const pending=credentialRequestContext({provider:'deepseek',scope:'project'});
 preferences.projectRoot=join(tmpdir(),'project-b');release();await assert.rejects(()=>pending,/authority changed/);
 credentialBindings.set('old',{provider:'deepseek',scope:'private',configDirectory:join(tmpdir(),'binding-config'),projectRoot:join(tmpdir(),'project-a'),generation:0});
 await assert.rejects(()=>credentialRequestContext({provider:'deepseek',scope:'private',binding:'old'},true),/destination changed/);
});
test('project replacement/removal preserve unrelated variables and never affect private storage',async()=>{
 const root=mkdtempSync(join(tmpdir(),'babel-project-lifecycle-'));
 try{
  const project=join(root,'project'),config=join(root,'config');mkdirSync(project);mkdirSync(config);
  const {spawnSync}=await import('node:child_process');assert.equal(spawnSync('git',['init','-q',project],{stdio:'ignore'}).status,0);
  writeFileSync(join(project,'.gitignore'),'.env\n');
  const original='BabelProjectLifecycleFixture0000',next='BabelProjectReplacementFixture0000';
  credentials.saveProviderCredential({provider:'deepseek',scope:'project',projectRoot:project,apiKey:original});
  writeFileSync(join(project,'.env'),readFileSync(join(project,'.env'),'utf8')+'# keep\nUNRELATED=value\nOPENROUTER_API_KEY=BabelOtherProviderFixture0000\n',{mode:0o600});
  credentials.saveProviderCredential({provider:'deepseek',scope:'project',projectRoot:project,apiKey:next,operation:'replace'});
  assert.equal(readFileSync(join(project,'.env'),'utf8').includes(original),false);
  credentials.removeProviderCredential({provider:'deepseek',scope:'project',projectRoot:project});
  const text=readFileSync(join(project,'.env'),'utf8');assert.match(text,/# keep\nUNRELATED=value\nOPENROUTER_API_KEY=/);assert.equal(text.includes('DEEPSEEK_API_KEY'),false);
  assert.equal(existsSync(join(config,'desktop-credentials.json')),false);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('encrypted legacy migration can retry after interruption before commit and returns no secret',()=>{
 const config=mkdtempSync(join(tmpdir(),'babel-interrupted-migration-'));
 try{
  const token='BabelMigrationRetryFixture0000';writeFileSync(join(config,'.env'),'DEEPSEEK_API_KEY='+token+'\n',{mode:0o600});
  writeFileSync(join(config,'desktop-credentials.json.babel-lock'),'');
  assert.throws(()=>credentials.migrateProviderCredential({provider:'deepseek',configDirectory:config,confirm:true}),/already running/);
  assert.equal(existsSync(join(config,'desktop-credentials.json')),false);
  rmSync(join(config,'desktop-credentials.json.babel-lock'));
  const result=credentials.migrateProviderCredential({provider:'deepseek',configDirectory:config,confirm:true});
  assert.equal(JSON.stringify(result).includes(token),false);
  assert.equal(credentials.migrateProviderCredential({provider:'deepseek',configDirectory:config,confirm:true}).migrated,false);
 }finally{rmSync(config,{recursive:true,force:true});}
});

test('owned CLI selects only the explicitly opted matching project and standalone cannot resurrect private removals',async()=>{
 const root=mkdtempSync(join(tmpdir(),'babel-native-scope-'));
 try{
  const project=join(root,'project'),configDirectory=join(root,'config');mkdirSync(project);mkdirSync(configDirectory);
  const {spawnSync}=await import('node:child_process');assert.equal(spawnSync('git',['init','-q',project],{stdio:'ignore'}).status,0);writeFileSync(join(project,'.gitignore'),'.env\n');
  const privateValue='BabelPrivateScopedFixture0000',projectValue='BabelProjectScopedFixture0000';
  credentials.saveProviderCredential({provider:'deepseek',apiKey:privateValue,configDirectory});
  credentials.saveProviderCredential({provider:'deepseek',apiKey:projectValue,scope:'project',projectRoot:project});
  const {applyOwnedCliCredentialEnvironment,applyCliCredentialScope}=await import('../native/childEnv.mjs');
  const selected=applyOwnedCliCredentialEnvironment({BABEL_DESKTOP_PROVIDER:'deepseek'},{configDirectory,projectRoot:project,projectCredentialRoot:project});assert.equal(selected.DEEPSEEK_API_KEY===projectValue,true);
  const other=applyOwnedCliCredentialEnvironment({BABEL_DESKTOP_PROVIDER:'deepseek'},{configDirectory,projectRoot:project,projectCredentialRoot:join(root,'another')});assert.equal(other.DEEPSEEK_API_KEY===privateValue,true);
  credentials.removeProviderCredential({provider:'deepseek',scope:'private',configDirectory});
  credentials.removeProviderCredential({provider:'deepseek',scope:'project',projectRoot:project});
  assert.throws(()=>applyCliCredentialScope({BABEL_DESKTOP_PROVIDER:'deepseek'},{configDirectory,args:['run','--project-root',project],cwd:project,preferences:{projectRoot:project,projectCredentialRoot:project}}),/standalone|Desktop/);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('standalone model overrides cannot resurrect any protected-store-owned provider',async()=>{
 const config=mkdtempSync(join(tmpdir(),'babel-standalone-cross-provider-'));
 try{
  credentials.saveProviderCredential({provider:'deepseek',apiKey:'fixture-private',configDirectory:config});
  credentials.removeProviderCredential({provider:'deepseek',scope:'private',configDirectory:config});
  const {saveProviderRoute}=await import('../native/provider-routing.mjs');saveProviderRoute({configDirectory:config,provider:'openrouter',model:'deepseek-v4-pro-openrouter'});
  const {applyCliCredentialScope}=await import('../native/childEnv.mjs');
  assert.throws(()=>applyCliCredentialScope({},{configDirectory:config,args:['run','--model','deepseek-v4-pro'],cwd:config}),/standalone|Desktop/);
 }finally{rmSync(config,{recursive:true,force:true});}
});

test('multiline dotenv data cannot be imported or edited as a top-level provider key',async()=>{
 const root=mkdtempSync(join(tmpdir(),'babel-multiline-credential-'));
 try{
  const project=join(root,'project'),config=join(root,'config');mkdirSync(project);mkdirSync(config);
  const {spawnSync}=await import('node:child_process');assert.equal(spawnSync('git',['init','-q',project],{stdio:'ignore'}).status,0);writeFileSync(join(project,'.gitignore'),'.env\n');
  for(const [separator,quote,escapedTail] of [['=','"',''],[': ',"'",''],['=','`',''],['=','"',String.fromCharCode(92,92,34)],['=\n','"','']]){
  const original=`BANNER${separator}${quote}hello${escapedTail}\nDEEPSEEK_API_KEY=fixture-embedded\nworld${quote}\n`;
  writeFileSync(join(project,'.env'),original,{mode:0o600});writeFileSync(join(config,'.env'),original,{mode:0o600});
  const selected={provider:'deepseek',scope:'project',projectRoot:project,configDirectory:config};
  assert.throws(()=>credentials.providerCredentialStatus(selected),/ambiguous|multiline|unsupported/i);
  assert.throws(()=>credentials.removeProviderCredential(selected),/ambiguous|multiline|unsupported/i);
  assert.throws(()=>credentials.saveProviderCredential({...selected,apiKey:'fixture-new',operation:'replace'}),/ambiguous|multiline|unsupported/i);
  assert.throws(()=>credentials.applyNativeCredentialEnvironment({},selected),/ambiguous|multiline|unsupported/i);
  assert.throws(()=>credentials.migrateProviderCredential({provider:'deepseek',configDirectory:config,confirm:true}),/ambiguous|multiline|unsupported/i);
  assert.equal(readFileSync(join(project,'.env'),'utf8'),original);assert.equal(readFileSync(join(config,'.env'),'utf8'),original);
  assert.equal(existsSync(join(config,'desktop-credentials.json')),false);
  }
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('an empty protected store cannot restore retained legacy keys or permit standalone fallback',async()=>{
 const config=mkdtempSync(join(tmpdir(),'babel-empty-protected-store-'));
 try{
  writeFileSync(join(config,'.env'),'DEEPSEEK_API_KEY=fixture-legacy\n',{mode:0o600});
  credentials.migrateProviderCredential({provider:'deepseek',configDirectory:config,confirm:true});
  credentials.removeProviderCredential({provider:'deepseek',scope:'private',configDirectory:config});
  const store=join(config,'desktop-credentials.json');writeFileSync(store,'',{mode:0o600});
  assert.throws(()=>credentials.applyNativeCredentialEnvironment({},{provider:'deepseek',configDirectory:config}),/invalid|read-only|unsupported/i);
  assert.throws(()=>credentials.providerCredentialStatus({provider:'deepseek',configDirectory:config}),/invalid|read-only|unsupported/i);
  assert.throws(()=>credentials.migrateProviderCredential({provider:'deepseek',configDirectory:config,confirm:true}),/invalid|read-only|unsupported/i);
  assert.throws(()=>credentials.assertStandaloneCredentialCompatibility(config),/invalid|read-only|unsupported/i);
  assert.throws(()=>credentials.saveProviderCredential({provider:'openrouter',configDirectory:config,apiKey:'fixture-new'}),/invalid|read-only|unsupported/i);
  assert.equal(readFileSync(store,'utf8'),'');
 }finally{rmSync(config,{recursive:true,force:true});}
});

test('credential reads reject growth and same-size mutation at the opened-file boundary',async t=>{
 const fs=await import('node:fs');const {syncBuiltinESMExports}=await import('node:module');
 const config=mkdtempSync(join(tmpdir(),'babel-credential-read-race-'));
 const path=join(config,'desktop-credentials.json');
 try{
  const original=fs.default.fstatSync;
  for(const grow of [false,true]){
   writeFileSync(path,JSON.stringify({schemaVersion:1,entries:{},migrations:{},note:'a'}),{mode:0o600});
   let calls=0,maxBuffer=0;
   const originalRead=fs.default.readSync;
   const readReplacement=t.mock.method(fs.default,'readSync',function(fd,buffer,...args){maxBuffer=Math.max(maxBuffer,buffer.length);return originalRead(fd,buffer,...args);});
   const replacement=t.mock.method(fs.default,'fstatSync',function(fd,...args){
    const info=original(fd,...args);
    if(++calls===1){if(grow)fs.appendFileSync(path,' '.repeat(300000));else{const bytes=fs.readFileSync(path,'utf8');fs.writeFileSync(path,bytes.replace('\"note\":\"a\"','\"note\":\"b\"'));fs.utimesSync(path,new Date(),new Date(Date.now()+10000));}}
    return info;
   });syncBuiltinESMExports();
   try{assert.throws(()=>credentials.providerCredentialStatus({provider:'deepseek',configDirectory:config}),/changed|large/i);assert.equal(maxBuffer<=256*1024,true,'Credential reader exceeded its fixed allocation budget');}
   finally{replacement.mock.restore();readReplacement.mock.restore();syncBuiltinESMExports();}
  }
 }finally{rmSync(config,{recursive:true,force:true});}
});
