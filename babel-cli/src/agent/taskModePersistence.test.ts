import assert from 'node:assert/strict';
import test from 'node:test';
import fs,{mkdtempSync,readFileSync,rmSync,writeFileSync,readdirSync} from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {join,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {createParityRuntime,checkpointParityEventLogStrict} from './chatEngineParityBridge.js';
import {refreshEngineInstructionManifest,refreshRestoredEngineMode} from './chatEngineLiveSession.js';
import {loadLiveSessionAuthorityStrict,persistLiveSessionAuthority,resolveLiveSessionAuthority,TASK_MODE_HISTORY_FILENAME,TASK_CONTRACT_FILENAME} from './liveSessionBridge.js';
import {validateTaskContractV1} from './taskContract.js';
import {recordUserSubmitted,serializeSessionEventLog,SESSION_EVENTS_FILENAME} from './sessionEvents.js';

test('a failed mode-history publication retains the complete prior authority generation',async t=>{
  const root=mkdtempSync(join(tmpdir(),'babel-mode-rollback-'));
  const runtime=createParityRuntime('mode-rollback');
  runtime.liveAuthority=resolveLiveSessionAuthority({mode:'chat',projectRoot:root,task:'Fix fixture and run required tests',verifierRequirements:['node --test fixture.test.mjs']});
  try{
    const original=runtime.liveAuthority,first=await checkpointParityEventLogStrict(runtime,root);
    assert.equal(first.status,'committed');
    const before=first.artifacts.map(item=>[item.path!,readFileSync(item.path!,'utf8')] as const);
    const rename=fs.renameSync;
    const mock=t.mock.method(fs,'renameSync',function(source:fs.PathLike,target:fs.PathLike){
      if(basename(String(target))===TASK_MODE_HISTORY_FILENAME)throw Object.assign(new Error('mode history publication blocked'),{code:'EACCES'});
      return rename(source,target);
    });syncBuiltinESMExports();
    try{assert.throws(()=>refreshEngineInstructionManifest({parity:runtime,options:{projectRoot:root,task:'continue'},taskClass:'general_swe',executionProfile:'plan',engineRunDir:root}),/MODE_TRANSITION_NOT_COMMITTED/);}
    finally{mock.mock.restore();syncBuiltinESMExports();}
    assert.equal(runtime.liveAuthority,original);
    for(const [path,bytes] of before)assert.equal(readFileSync(path,'utf8'),bytes);
    assert.equal(readdirSync(root).includes(TASK_MODE_HISTORY_FILENAME),false);
    assert.equal(readdirSync(root).some(name=>/\.(tmp|bak)$/.test(name)),false);
    assert.equal(loadLiveSessionAuthorityStrict(root).taskContract.contract_id,original.taskContract.contract_id);
    refreshEngineInstructionManifest({parity:runtime,options:{projectRoot:root,task:'continue'},taskClass:'general_swe',executionProfile:'plan',engineRunDir:root});
    assert.equal(loadLiveSessionAuthorityStrict(root).taskContract.mode,'plan');
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('missing, corrupt and future mode lineage cannot authorize a derived head',()=>{
  const root=mkdtempSync(join(tmpdir(),'babel-mode-lineage-'));
  try{
    const runtime=createParityRuntime('mode-lineage');
    runtime.liveAuthority=resolveLiveSessionAuthority({mode:'chat',projectRoot:root,task:'Fix fixture'});
    refreshEngineInstructionManifest({parity:runtime,options:{projectRoot:root,task:'continue'},taskClass:'general_swe',executionProfile:'plan',engineRunDir:root});
    const file=join(root,TASK_MODE_HISTORY_FILENAME),original=readFileSync(file,'utf8');
    for(const value of ['{invalid',JSON.stringify({schema_version:2,revisions:[]}),JSON.stringify({schema_version:1,revisions:[]})]){
      writeFileSync(file,value);assert.throws(()=>loadLiveSessionAuthorityStrict(root),/mode history|mode revision/i);assert.equal(readFileSync(file,'utf8'),value);
    }
    rmSync(file);assert.throws(()=>loadLiveSessionAuthorityStrict(root),/mode revision.*history/i);
    writeFileSync(file,original);assert.equal(loadLiveSessionAuthorityStrict(root).taskContract.mode,'plan');
    const extended={...JSON.parse(original),retained_extension:{note:'compatible metadata'}};
    writeFileSync(file,JSON.stringify(extended));runtime.liveAuthority=loadLiveSessionAuthorityStrict(root);
    refreshEngineInstructionManifest({parity:runtime,options:{projectRoot:root,task:'continue'},taskClass:'general_swe',executionProfile:'chat',engineRunDir:root});
    assert.deepEqual(JSON.parse(readFileSync(file,'utf8')).retained_extension,extended.retained_extension);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('a cold mode change cannot replace legacy history with an empty canonical log',()=>{
  const root=mkdtempSync(join(tmpdir(),'babel-mode-legacy-'));
  try{
    const runtime=createParityRuntime('legacy-mode');
    runtime.liveAuthority=resolveLiveSessionAuthority({mode:'chat',projectRoot:root,task:'Retained legacy objective'});
    persistLiveSessionAuthority(root,runtime.liveAuthority);
    recordUserSubmitted(runtime.sessionEvents,{turn_id:'legacy-turn',task:'Retained legacy objective'});
    writeFileSync(join(root,SESSION_EVENTS_FILENAME),serializeSessionEventLog(runtime.sessionEvents));
    const transcript=join(root,'transcript.jsonl');writeFileSync(transcript,JSON.stringify({role:'user',content:'Retain this legacy archive'})+'\n');
    const before=new Map(readdirSync(root).map(name=>[name,readFileSync(join(root,name),'utf8')]));
    assert.throws(()=>refreshRestoredEngineMode({parity:runtime,options:{projectRoot:root,task:'continue'},taskClass:'general_swe',executionProfile:'plan',engineRunDir:root}),/MODE_HISTORY_SOURCE_MISSING/);
    assert.deepEqual(readdirSync(root),[...before.keys()]);
    for(const [name,bytes] of before)assert.equal(readFileSync(join(root,name),'utf8'),bytes);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('changing unhashed source metadata cannot conceal a missing mode lineage',()=>{
  const root=mkdtempSync(join(tmpdir(),'babel-mode-source-marker-'));
  try{
    const runtime=createParityRuntime('mode-marker');runtime.liveAuthority=resolveLiveSessionAuthority({mode:'chat',projectRoot:root,task:'Retain objective'});
    refreshEngineInstructionManifest({parity:runtime,options:{projectRoot:root,task:'continue'},taskClass:'general_swe',executionProfile:'plan',engineRunDir:root});
    const head=JSON.parse(readFileSync(join(root,TASK_CONTRACT_FILENAME),'utf8'));head.provenance.source='compatible-runtime';
    assert.deepEqual(validateTaskContractV1(head),[]);writeFileSync(join(root,TASK_CONTRACT_FILENAME),JSON.stringify(head));rmSync(join(root,TASK_MODE_HISTORY_FILENAME));
    assert.throws(()=>loadLiveSessionAuthorityStrict(root),/mode revision.*history/i);
  }finally{rmSync(root,{recursive:true,force:true});}
});
