// License: Apache-2.0
// First-run credential decisions from the Desktop plan: a legacy-only profile
// must never claim authenticated first-run success, and a new protected write
// must never destroy the retained legacy recovery file.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync,existsSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {configureCredentialProtection,saveProviderCredential,removeProviderCredential,migrateProviderCredential,providerCredentialStatus,hasProviderCredential,applyNativeCredentialEnvironment,normalizeCredentialOperation} from '../native/credentials.mjs';
import {fixtureProtection} from './credential-fixture.mjs';
configureCredentialProtection(fixtureProtection);

const NEW_KEY='BabelFirstRunNewProtectedKey0000';
const LEGACY_KEY='BabelFirstRunLegacyPlaintext0000';
const OTHER_KEY='BabelFirstRunSecondProviderKey0000';
const digest=value=>createHash('sha256').update(value).digest('hex');

function fixture(body){
  const config=mkdtempSync(join(tmpdir(),'babel-first-run-'));
  try{return body(config);}finally{rmSync(config,{recursive:true,force:true});}
}
function legacyProfile(config,text=`# retained recovery file\nDEEPSEEK_API_KEY=${LEGACY_KEY}\nUNRELATED=preserved\n`){
  writeFileSync(join(config,'.env'),text,{mode:0o600});
  return {text,digest:digest(text)};
}
const status=(config,extra={})=>providerCredentialStatus({provider:'deepseek',scope:'private',configDirectory:config,...extra});

test('legacy-only status reports plaintext storage without claiming authentication',()=>fixture(config=>{
  legacyProfile(config);
  const value=status(config);
  assert.equal(value.present,true);
  assert.equal(value.ownedProtectedEntry,false);
  assert.equal(value.legacyPresent,true);
  assert.equal(value.legacySuperseded,false);
  assert.equal(value.storage,'legacy-plaintext');
  assert.equal(value.migrationAvailable,true);
  assert.equal(value.credentialRevision,null);
  assert.deepEqual(value.authentication,{state:'not_checked',reason:'not_checked',checkedAt:null,observedRevision:null});
  assert.equal(existsSync(join(config,'desktop-credentials.json')),false,'Status must not create protected storage.');
}));

test('a blank key on a legacy-only profile is refused with the explicit decisions, changing nothing',()=>fixture(config=>{
  const legacy=legacyProfile(config);
  for(const operation of ['add_new','replace_protected',undefined]){
    assert.throws(()=>saveProviderCredential({provider:'deepseek',scope:'private',configDirectory:config,apiKey:'',...operation?{operation}:{}}),/legacy plaintext key exists|token/i);
    assert.equal(digest(readFileSync(join(config,'.env'),'utf8')),legacy.digest);
    assert.equal(existsSync(join(config,'desktop-credentials.json')),false);
  }
  assert.equal(status(config).present,true);
}));

test('consented supersede stores the new protected key and leaves the legacy bytes unchanged',()=>fixture(config=>{
  const legacy=legacyProfile(config);
  const result=saveProviderCredential({provider:'deepseek',scope:'private',configDirectory:config,apiKey:NEW_KEY,operation:'supersede_legacy_with_new'});
  assert.equal(result.storage,'os-protected');
  assert.equal(result.credentialChanged,true);
  assert.equal(result.supersededLegacy,true);
  assert.match(result.revision,/^[a-f0-9-]{16,64}$/);
  assert.equal(digest(readFileSync(join(config,'.env'),'utf8')),legacy.digest,'Original recovery bytes must be preserved.');
  const bytes=readFileSync(join(config,'desktop-credentials.json'),'utf8');
  assert.equal(bytes.includes(NEW_KEY),false);
  const after=status(config);
  assert.equal(after.storage,'os-protected');
  assert.equal(after.legacySuperseded,true);
  assert.equal(after.legacyPresent,true,'The retained file is still observable.');
  assert.equal(after.present,true);
  assert.equal(after.authentication.state,'not_checked','A stored key is not an authenticated key.');
  const env={};applyNativeCredentialEnvironment(env,{configDirectory:config,provider:'deepseek'});
  assert.equal(env.DEEPSEEK_API_KEY,NEW_KEY,'The superseded plaintext must never resolve again.');
}));

test('supersede is refused when the provider is unowned by the legacy file',()=>fixture(config=>{
  writeFileSync(join(config,'.env'),`OPENROUTER_API_KEY=${LEGACY_KEY}\n`,{mode:0o600});
  assert.throws(()=>saveProviderCredential({provider:'deepseek',scope:'private',configDirectory:config,apiKey:NEW_KEY,operation:'supersede_legacy_with_new'}),/No legacy plaintext credential/i);
  assert.equal(existsSync(join(config,'desktop-credentials.json')),false);
}));

test('continue_with_legacy is an explicit labelled compatibility mode that copies nothing',()=>fixture(config=>{
  const legacy=legacyProfile(config);
  const result=saveProviderCredential({provider:'deepseek',scope:'private',configDirectory:config,operation:'continue_with_legacy'});
  assert.equal(result.storage,'legacy-plaintext');
  assert.equal(result.legacyAcknowledged,true);
  assert.equal(result.credentialChanged,false);
  assert.equal(result.revision,null);
  assert.equal(readFileSync(join(config,'.env'),'utf8'),legacy.text);
  assert.equal(existsSync(join(config,'desktop-credentials.json')),false,'Legacy continuation must not create a store.');
  const env={};applyNativeCredentialEnvironment(env,{configDirectory:config,provider:'deepseek'});
  assert.equal(env.DEEPSEEK_API_KEY,LEGACY_KEY,'Legacy sessions keep working under an explicit decision.');
}));

test('an acknowledged legacy profile still requires explicit supersede for a protected write',()=>fixture(config=>{
  legacyProfile(config);
  saveProviderCredential({provider:'deepseek',scope:'private',configDirectory:config,operation:'continue_with_legacy'});
  // Acknowledging legacy mode is a runtime decision, not durable consent to
  // overwrite the user's only working credential.
  assert.throws(()=>saveProviderCredential({provider:'deepseek',scope:'private',configDirectory:config,apiKey:NEW_KEY,operation:'add_new'}),/legacy plaintext key exists/i);
  const saved=saveProviderCredential({provider:'deepseek',scope:'private',configDirectory:config,apiKey:NEW_KEY,operation:'supersede_legacy_with_new'});
  assert.equal(saved.supersededLegacy,true);
  const env={};applyNativeCredentialEnvironment(env,{configDirectory:config,provider:'deepseek'});
  assert.equal(env.DEEPSEEK_API_KEY,NEW_KEY);
}));

test('removal tombstones win over the retained legacy file and cannot be resurrected',()=>fixture(config=>{
  legacyProfile(config);
  saveProviderCredential({provider:'deepseek',scope:'private',configDirectory:config,apiKey:NEW_KEY,operation:'supersede_legacy_with_new'});
  const removed=removeProviderCredential({provider:'deepseek',scope:'private',configDirectory:config});
  assert.equal(removed.configured,false);
  const after=status(config);
  assert.equal(after.present,false);
  assert.equal(after.storage,'none');
  assert.equal(after.tombstoned,true);
  assert.equal(after.legacySuperseded,true);
  assert.equal(hasProviderCredential({provider:'deepseek',scope:'private',configDirectory:config}),false);
  const env={};applyNativeCredentialEnvironment(env,{configDirectory:config,provider:'deepseek'});
  assert.equal(env.DEEPSEEK_API_KEY,undefined,'A removed protected key must not resurrect plaintext.');
  // The durable tombstone keeps migration from re-importing the retained file.
  assert.equal(migrateProviderCredential({provider:'deepseek',configDirectory:config,confirm:true}).migrated,false);
  assert.equal(status(config).present,false);
}));

test('an owned protected key keeps route-only updates legitimate and revision-stable',()=>fixture(config=>{
  const first=saveProviderCredential({provider:'deepseek',scope:'private',configDirectory:config,apiKey:NEW_KEY});
  const before=status(config);
  const kept=saveProviderCredential({provider:'deepseek',scope:'private',configDirectory:config,operation:'keep_existing_route_only'});
  assert.equal(kept.credentialChanged,false);
  assert.equal(kept.revision,first.revision,'A route-only update must not change the credential revision.');
  assert.equal(status(config).credentialRevision,before.credentialRevision);
  assert.equal(status(config).present,true);
}));

test('a replace re-save gets a new revision and never turns into a confusing add error',()=>fixture(config=>{
  const first=saveProviderCredential({provider:'deepseek',scope:'private',configDirectory:config,apiKey:NEW_KEY});
  const second=saveProviderCredential({provider:'deepseek',scope:'private',configDirectory:config,apiKey:OTHER_KEY,operation:'replace_protected'});
  assert.equal(second.credentialChanged,true);
  assert.notEqual(second.revision,first.revision);
  assert.equal(status(config).credentialRevision,second.revision);
  assert.equal(status(config).present,true);
  const env={};applyNativeCredentialEnvironment(env,{configDirectory:config,provider:'deepseek'});
  assert.equal(env.DEEPSEEK_API_KEY,OTHER_KEY);
}));

test('migration records a durable revision and the retained file never changes',()=>fixture(config=>{
  const legacy=legacyProfile(config);
  const migrated=migrateProviderCredential({provider:'deepseek',configDirectory:config,confirm:true});
  assert.equal(migrated.migrated,true);
  assert.match(migrated.revision,/^[a-f0-9-]{16,64}$/);
  assert.equal(status(config).credentialRevision,migrated.revision);
  assert.equal(digest(readFileSync(join(config,'.env'),'utf8')),legacy.digest);
  assert.equal(migrateProviderCredential({provider:'deepseek',configDirectory:config,confirm:true}).migrated,false);
}));

test('revisions survive restart because they are read from the durable store',()=>fixture(config=>{
  const saved=saveProviderCredential({provider:'deepseek',scope:'private',configDirectory:config,apiKey:NEW_KEY});
  const persisted=JSON.parse(readFileSync(join(config,'desktop-credentials.json'),'utf8'));
  assert.equal(persisted.revisions.deepseek,saved.revision,'The receipt must match what is durable.');
  assert.equal(persisted.schemaVersion,1);
  const reopened=status(config);
  assert.equal(reopened.credentialRevision,saved.revision);
}));

test('a schema-v1 store written by an earlier build is read and upgraded in place',()=>fixture(config=>{
  const previous=saveProviderCredential({provider:'deepseek',scope:'private',configDirectory:config,apiKey:NEW_KEY});
  const legacyStore=JSON.parse(readFileSync(join(config,'desktop-credentials.json'),'utf8'));
  delete legacyStore.revisions;delete legacyStore.superseded;
  writeFileSync(join(config,'desktop-credentials.json'),JSON.stringify(legacyStore),{mode:0o600});
  const read=status(config);
  assert.equal(read.present,true);
  assert.equal(read.credentialRevision,null,'A pre-revision store reports unknown, never a invented revision.');
  const replaced=saveProviderCredential({provider:'deepseek',scope:'private',configDirectory:config,apiKey:OTHER_KEY,operation:'replace_protected'});
  assert.match(replaced.revision,/^[a-f0-9-]{16,64}$/);
  assert.notEqual(replaced.revision,previous.revision);
}));

test('unknown revision or supersede markers fail closed instead of guessing',()=>fixture(config=>{
  saveProviderCredential({provider:'deepseek',scope:'private',configDirectory:config,apiKey:NEW_KEY});
  const path=join(config,'desktop-credentials.json');
  for(const mutation of [{revisions:{deepseek:'not-a-revision'}},{superseded:{deepseek:'yes'}},{revisions:{openrouter:'a'.repeat(32)}},{superseded:{openrouter:true}}]){
    const value={schemaVersion:1,entries:{deepseek:JSON.parse(readFileSync(path,'utf8')).entries.deepseek},migrations:{},...mutation};
    writeFileSync(path,JSON.stringify(value),{mode:0o600});
    assert.throws(()=>status(config),/invalid|unsupported|read-only/i);
    assert.throws(()=>saveProviderCredential({provider:'deepseek',scope:'private',configDirectory:config,apiKey:OTHER_KEY,operation:'replace_protected'}),/invalid|unsupported|read-only/i);
  }
}));

test('legacy operations from earlier builds still reach the same guarded behaviour',()=>fixture(config=>{
  assert.equal(normalizeCredentialOperation('add'),'add_new');
  assert.equal(normalizeCredentialOperation('replace'),'replace_protected');
  assert.equal(normalizeCredentialOperation('remove'),'remove');
  assert.equal(normalizeCredentialOperation('add_new'),'add_new');
  assert.throws(()=>normalizeCredentialOperation('invented'),/explicit credential action/i);
  const first=saveProviderCredential({provider:'deepseek',scope:'private',configDirectory:config,apiKey:NEW_KEY,operation:'add'});
  assert.equal(first.present,true);
  const replaced=saveProviderCredential({provider:'deepseek',scope:'private',configDirectory:config,apiKey:OTHER_KEY,operation:'replace'});
  assert.equal(replaced.present,true);
  assert.equal(removeProviderCredential({provider:'deepseek',scope:'private',configDirectory:config}).configured,false);
}));

test('every protected write stays unlinked, private and free of plaintext',()=>fixture(config=>{
  legacyProfile(config);
  saveProviderCredential({provider:'deepseek',scope:'private',configDirectory:config,apiKey:NEW_KEY,operation:'supersede_legacy_with_new'});
  const path=join(config,'desktop-credentials.json');
  const info=statSync(path);
  assert.equal(info.isFile(),true);
  assert.equal(info.nlink,1);
  if(process.platform!=='win32')assert.equal(info.mode&0o777,0o600);
  const bytes=readFileSync(path,'utf8');
  for(const secret of [NEW_KEY,LEGACY_KEY,digest(NEW_KEY)])assert.equal(bytes.includes(secret),false);
}));
