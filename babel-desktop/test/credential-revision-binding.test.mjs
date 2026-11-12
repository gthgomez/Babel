// License: Apache-2.0
// The Desktop credential revision must never enter the persisted private-worker
// thread authority digest. Rotation has to stay invisible to thread resume.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const desktop=fileURLToPath(new URL('..',import.meta.url));
const read=path=>readFileSync(join(desktop,path),'utf8');

test('the resident worker uses a static configuration generation, not a credential revision',()=>{
  const source=read('native/private-worker-run.mjs');
  // The constructor default is static; the Desktop never injects a rotating value.
  assert.match(source,/configurationGeneration = 'desktop'/);
  assert.match(source,/engineGeneration = 'desktop'/);
  assert.match(source,/configuration_generation: this\.configurationGeneration/);
  // A credential revision must not appear anywhere in the worker authority.
  assert.doesNotMatch(source,/credentialRevision|credential_revision|revision:/);
});

test('main never passes a credential generation into the resident worker authority',()=>{
  const source=read('native/main.mjs');
  const construct=source.slice(source.indexOf('new PrivateWorkerRun('),source.indexOf('runner=residentWorker'));
  assert.ok(construct.length>0,'the resident worker construction must be found');
  assert.doesNotMatch(construct,/configurationGeneration|credentialRevision|revision/i,'A rotating credential value in the authority digest would break resume.');
});

test('a credential rotation retires the resident worker instead of mutating its authority',()=>{
  const source=read('native/main.mjs');
  // Every credential-changing path must retire the worker so the next run
  // resolves the new key through a fresh process.
  const handlers=['babel:remove-provider-credential','babel:migrate-provider-credential','babel:save-provider-route'];
  for(const channel of handlers){
    const start=source.indexOf(`handle('${channel}'`);
    assert.ok(start>0,`${channel} must be registered`);
    const region=source.slice(start,start+2600);
    assert.match(region,/retireResidentWorker/,`${channel} must retire the resident worker`);
  }
});

test('the CLI worker authority schema is unchanged by this work',()=>{
  const cli=join(desktop,'..','babel-cli','src','protocol','privateWorker.ts');
  const source=readFileSync(cli,'utf8');
  // The schema still requires exactly these fields; no new required field was
  // added, so older Desktop builds and existing threads keep resuming.
  for(const field of ['project_root','mode','execution_profile','approval_policy','provider','model','provider_model_id','credential_ref','configuration_generation','engine_generation']){
    assert.match(source,new RegExp(`${field}:`),`${field} must remain in the authority schema`);
  }
  assert.match(source,/const \{ engine_generation: _engine, \.\.\.sessionAuthority \} = authority;/);
});

test('the credential revision is carried on the run receipt, not the thread record',()=>{
  const source=read('native/provider-route-save.mjs');
  assert.match(source,/revision: credential\?\.revision \?\? before\.credentialIdentity \?\? before\.credentialRevision \?\? null/);
  const auth=read('native/provider-auth.mjs');
  assert.match(auth,/observedRevision:value\.revision\?\?null/);
  // The identity is ephemeral per process; nothing writes it to a thread file.
  assert.doesNotMatch(auth,/writeFile|appendFile|createWriteStream/);
});

test('no test or fixture writes a credential revision into a thread authority file',()=>{
  const testDir=join(desktop,'test');
  for(const name of readdirSync(testDir)){
    if(!name.endsWith('.mjs')&&!name.endsWith('.py'))continue;
    const source=readFileSync(join(testDir,name),'utf8');
    assert.doesNotMatch(source,/private-worker-authority\.json/,'No fixture may rewrite a thread authority digest.');
  }
});
