import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, statSync, rmSync, existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {saveProviderCredential, credentialProviders, verifyProjectCredentialTarget} from '../native/credentials.mjs';

// Deliberately non-secret placeholder: exercises the accepted single-line token
// shape without resembling a live credential (synthetic fixtures must not trip
// the secret scanner).
const FIXTURE_VALUE='BabelTestCredentialPlaceholder0000';
const makeTemp=()=>mkdtempSync(join(tmpdir(),'babel-credential-fixture-'));
function git(cwd,...args) {
  const result=spawnSync('git',['-C',cwd,...args],{encoding:'utf8'});
  assert.equal(result.status,0, 'Git fixture setup failed');
}
function makeGitProject(root) {
  const project=join(root,'project');
  mkdirSync(project);
  git(project,'init','-q');
  writeFileSync(join(project,'.gitignore'),'.env\n');
  return project;
}

test('private profile is the default; the target project is never touched',()=>{
  const root=makeTemp();
  try {
    const config=join(root,'private','config');
    const project=makeGitProject(root);
    const result=saveProviderCredential({provider:'deepseek',apiKey:FIXTURE_VALUE,configDirectory:config,projectRoot:project});
    assert.deepEqual(result,{provider:'deepseek',scope:'private',configured:true});
    assert.match(readFileSync(join(config,'.env'),'utf8'),/^DEEPSEEK_API_KEY=/);
    assert.equal(statSync(join(config,'.env')).mode & 0o777,process.platform==='win32'?statSync(join(config,'.env')).mode & 0o777:0o600);
    assert.throws(()=>saveProviderCredential({provider:'deepseek',apiKey:FIXTURE_VALUE,configDirectory:config}),/already has a setting/);
    assert.doesNotThrow(()=>saveProviderCredential({provider:'openrouter',apiKey:FIXTURE_VALUE,configDirectory:config}));
    assert.equal(readFileSync(join(config,'.env'),'utf8').split('=')[0],'DEEPSEEK_API_KEY');
    assert.equal(credentialProviders().includes('anthropic'),false);
    assert.throws(()=>saveProviderCredential({provider:'anthropic',apiKey:FIXTURE_VALUE,configDirectory:config}),/supported/);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('explicit project scope requires a git-ignored untracked .env',()=>{
  const root=makeTemp();
  try {
    const project=makeGitProject(root);
    const result=saveProviderCredential({scope:'project',projectRoot:project,provider:'openrouter',apiKey:FIXTURE_VALUE});
    assert.equal(result.scope,'project');
    assert.match(readFileSync(join(project,'.env'),'utf8'),/^OPENROUTER_API_KEY=/);
    git(project,'add','-f','.env');
    assert.throws(()=>verifyProjectCredentialTarget(project),/tracked by Git/);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('non-ignored repositories and non-repositories fail closed',()=>{
  const root=makeTemp();
  try {
    assert.throws(()=>verifyProjectCredentialTarget(root),/Git repository/);
    const project=makeGitProject(root);
    writeFileSync(join(project,'.gitignore'),'');
    assert.throws(()=>saveProviderCredential({scope:'project',projectRoot:project,provider:'deepseek',apiKey:FIXTURE_VALUE}),/not Git-ignored/);
    assert.throws(()=>saveProviderCredential({scope:'invented',projectRoot:project,provider:'deepseek',apiKey:FIXTURE_VALUE}),/destination/);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('symlink and dangling-symlink .env targets are rejected',()=>{
  const root=makeTemp();
  try {
    const project=makeGitProject(root);
    const foreign=join(root,'foreign');
    writeFileSync(foreign,'foreign-file');
    try { symlinkSync(foreign,join(project,'.env')); }
    catch(error) {
      if(process.platform==='win32' && (error.code==='EPERM' || error.code==='EACCES')) return;
      throw error;
    }
    assert.throws(()=>saveProviderCredential({scope:'project',projectRoot:project,provider:'deepseek',apiKey:FIXTURE_VALUE}),/unlinked file/);
    rmSync(join(project,'.env'));
    symlinkSync(join(root,'absent'),join(project,'.env'));
    assert.throws(()=>saveProviderCredential({scope:'project',projectRoot:project,provider:'deepseek',apiKey:FIXTURE_VALUE}),/unlinked file/);
    assert.equal(readFileSync(foreign,'utf8'),'foreign-file');
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('invalid or multiline key is rejected before writing any credential file',()=>{
  const root=makeTemp();
  try {
    const config=join(root,'config');
    for(const apiKey of ['short','a\nBABEL_ROOT=/tmp/evil','white space',42]) {
      assert.throws(()=>saveProviderCredential({provider:'deepseek',apiKey,configDirectory:config}),/API key/);
    }
    // Rejection happens before any directory/file is created.
    assert.equal(existsSync(config),false);
    // A relative destination is refused with an explicit absolute-path contract
    // (regression: previously reported the ambiguous "unavailable" message).
    assert.throws(()=>saveProviderCredential({provider:'deepseek',apiKey:FIXTURE_VALUE,configDirectory:'relative'}),/absolute/);
    assert.throws(()=>saveProviderCredential({provider:'deepseek',apiKey:FIXTURE_VALUE,configDirectory:''}),/unavailable/);
    assert.equal(existsSync(join(process.cwd(),'relative')),false);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('a preexisting private key file is preserved on refusal and writes use a lock',()=>{
  const root=makeTemp();
  try {
    const config=join(root,'config');
    mkdirSync(config);
    const file=join(config,'.env');
    writeFileSync(file,'# existing\nOPENROUTER_API_KEY=existingSyntheticValue\n',{mode:0o600});
    assert.throws(()=>saveProviderCredential({provider:'openrouter',apiKey:FIXTURE_VALUE,configDirectory:config}),/already has a setting/);
    assert.match(readFileSync(file,'utf8'),/^# existing/);
    writeFileSync(file+'.babel-lock','');
    assert.throws(()=>saveProviderCredential({provider:'deepseek',apiKey:FIXTURE_VALUE,configDirectory:config}),/already running/);
  } finally {rmSync(root,{recursive:true,force:true});}
});
