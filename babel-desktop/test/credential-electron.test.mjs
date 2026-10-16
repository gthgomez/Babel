// License: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
const executable=process.env.BABEL_TEST_ELECTRON_EXECUTABLE;
test('actual Electron safeStorage protects synthetic private data in an isolated profile',{skip:!executable||!existsSync(executable)},()=>{
 const root=mkdtempSync(join(tmpdir(),'babel-electron-credential-'));
 try{
  const env={};
  for(const name of ['PATH','SystemRoot','WINDIR','COMSPEC','PATHEXT','TEMP','TMP'])if(process.env[name])env[name]=process.env[name];
  Object.assign(env,{HOME:root,USERPROFILE:root,APPDATA:root,LOCALAPPDATA:root,BABEL_CREDENTIAL_FIXTURE_ROOT:root});
  const result=spawnSync(executable,[fileURLToPath(new URL('./credential-electron-fixture.mjs',import.meta.url))],{cwd:root,env,windowsHide:true,encoding:'utf8',timeout:20000,maxBuffer:8192});
  assert.equal(result.status,0,'Synthetic Electron fixture failed; raw child output withheld');
  let receipt;try{receipt=JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));}catch{}
  assert.equal(Boolean(receipt),true,'Synthetic Electron scalar receipt missing');
  assert.deepEqual(receipt,{available:true,roundTrip:true,plaintextAbsent:true,dotenvAbsent:true,removed:true});
 }finally{rmSync(root,{recursive:true,force:true});}
});
