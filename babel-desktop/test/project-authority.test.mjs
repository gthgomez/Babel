import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rename,writeFile,readFile,rm,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';

const load=()=>import('../native/project-authority.mjs').catch(()=>({}));

test('project selection is not trust; exact directory grants persist and revoke',async()=>{
  const {ProjectAuthority,inspectProjectIdentity}=await load();
  assert.equal(typeof ProjectAuthority,'function');
  const dir=await mkdtemp(join(tmpdir(),'babel-authority-'));
  try{
    const root=join(dir,'project'),other=join(dir,'other'),file=join(dir,'profile','authority.json');
    await mkdir(root);await mkdir(other);
    const authority=await ProjectAuthority.open(file);
    assert.equal((await authority.inspect(root)).trusted,false);
    await assert.rejects(()=>authority.admit(root),/trust/i);
    const identity=await inspectProjectIdentity(root);
    await authority.grant(root,identity);
    const admission=await authority.admit(root);
    assert.equal(admission.identity.root,identity.root);
    assert.equal(authority.isCurrent(admission),true);
    assert.equal((await authority.inspect(other)).trusted,false);
    const restored=await ProjectAuthority.open(file);
    assert.equal((await restored.inspect(root)).trusted,true);
    const revoked=authority.revoke(root);
    assert.equal(authority.isCurrent(admission),false,'revocation fences immediately before I/O');
    await revoked;
    await assert.rejects(()=>authority.admit(root),/trust/i);
    assert.equal((await (await ProjectAuthority.open(file)).inspect(root)).trusted,false);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('directory replacement and changed confirmation identity never inherit trust',async()=>{
  const {ProjectAuthority,inspectProjectIdentity}=await load();
  assert.equal(typeof ProjectAuthority,'function');
  const dir=await mkdtemp(join(tmpdir(),'babel-authority-replace-'));
  try{
    const root=join(dir,'project');await mkdir(root);
    const authority=await ProjectAuthority.open(join(dir,'authority.json'));
    const identity=await inspectProjectIdentity(root);
    await authority.grant(root,identity);
    await rename(root,join(dir,'previous'));await mkdir(root);
    assert.equal((await authority.inspect(root)).trusted,false);
    await assert.rejects(()=>authority.admit(root),/trust|identity/i);
    await assert.rejects(()=>authority.grant(root,identity),/changed/i);
    assert.equal((await authority.inspect(root)).trusted,false);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('a selected path replaced by a link cannot inherit a different trusted directory',async()=>{
  const {ProjectAuthority,inspectProjectIdentity}=await load();
  const dir=await mkdtemp(join(tmpdir(),'babel-authority-rebind-'));
  try{
    const selected=join(dir,'selected'),other=join(dir,'other');await mkdir(selected);await mkdir(other);
    const authority=await ProjectAuthority.open(join(dir,'authority.json'));
    await authority.grant(selected,await inspectProjectIdentity(selected));
    await authority.grant(other,await inspectProjectIdentity(other));
    await rename(selected,join(dir,'previous'));
    await symlink(other,selected,process.platform==='win32'?'junction':'dir');
    await assert.rejects(()=>authority.admit(selected),/changed|identity/i);
    await authority.revoke(selected);
    await assert.rejects(()=>authority.admit(selected),/changed|identity/i);
    assert.equal((await authority.inspect(other)).trusted,true,'revoking the old selection does not revoke a different explicit grant');
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('unknown authority schema is read-only and cannot be silently downgraded',async()=>{
  const {ProjectAuthority,inspectProjectIdentity}=await load();
  assert.equal(typeof ProjectAuthority,'function');
  const dir=await mkdtemp(join(tmpdir(),'babel-authority-schema-'));
  try{
    const root=join(dir,'project'),file=join(dir,'authority.json');await mkdir(root);
    const original=JSON.stringify({schemaVersion:9,grants:[],future:'preserved'});await writeFile(file,original);
    const authority=await ProjectAuthority.open(file);
    assert.equal((await authority.inspect(root)).trusted,false);
    const identity=await inspectProjectIdentity(root);
    await assert.rejects(()=>authority.grant(root,identity),/read.only|schema/i);
    await assert.rejects(()=>authority.revoke(root),/read.only|schema/i);
    assert.equal(await readFile(file,'utf8'),original);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('Git identity changes lose trust while ordinary branch changes preserve it',async()=>{
  const {ProjectAuthority,inspectProjectIdentity}=await load();
  const dir=await mkdtemp(join(tmpdir(),'babel-authority-git-'));
  const env={...Object.fromEntries(Object.entries(process.env).filter(([name])=>!/^GIT_/i.test(name))),GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null',GIT_CONFIG_NOSYSTEM:'1'};
  const git=(root,args)=>execFileSync('git',['-c','core.fsmonitor=false','-C',root,...args],{env,stdio:'pipe',windowsHide:true});
  try{
    const root=join(dir,'project');await mkdir(root);
    const authority=await ProjectAuthority.open(join(dir,'authority.json'));
    await authority.grant(root,await inspectProjectIdentity(root));
    git(root,['-c','init.defaultBranch=main','init','--quiet']);
    assert.equal((await authority.inspect(root)).trusted,false,'a newly created repository is a new binding');
    await authority.grant(root,await inspectProjectIdentity(root));
    git(root,['symbolic-ref','HEAD','refs/heads/another-branch']);
    const branch=await authority.inspect(root);
    assert.equal(branch.identity.branch,'another-branch');
    assert.equal(branch.trusted,true);
    await rename(join(root,'.git'),join(dir,'old-git'));
    git(root,['-c','init.defaultBranch=main','init','--quiet']);
    assert.equal((await authority.inspect(root)).trusted,false,'replacement repository does not inherit trust');
    const outside=join(dir,'outside');await mkdir(outside);
    git(root,['config','core.worktree',outside]);
    await assert.rejects(()=>inspectProjectIdentity(root),/verified/i);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('revocation racing a grant stays fenced and failed persistence is never reported saved',async()=>{
  const {ProjectAuthority,inspectProjectIdentity}=await load();
  const dir=await mkdtemp(join(tmpdir(),'babel-authority-race-'));
  try{
    const root=join(dir,'project'),profile=join(dir,'profile');await mkdir(root);
    const authority=await ProjectAuthority.open(join(profile,'authority.json'));
    const identity=await inspectProjectIdentity(root);
    const confirmationGeneration=authority.generation;
    await authority.revoke(root);
    await assert.rejects(()=>authority.grant(root,identity,confirmationGeneration),/changed/i,'revocation invalidates an already-open trust confirmation');
    const granting=authority.grant(root,identity),revoking=authority.revoke(root);
    await assert.rejects(()=>granting,/changed/i);await revoking;
    assert.equal((await authority.inspect(root)).trusted,false);
    await authority.grant(root,identity);
    await rename(profile,join(dir,'previous-profile'));await writeFile(profile,'blocks persistence');
    await assert.rejects(()=>authority.revoke(root));
    assert.equal((await authority.inspect(root)).trusted,false,'in-memory fence survives persistence failure');
    await assert.rejects(()=>authority.admit(root),/trust/i);
  }finally{await rm(dir,{recursive:true,force:true});}
});
