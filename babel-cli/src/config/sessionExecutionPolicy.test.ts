import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { chatSessionDir } from '../cli/runsLayout.js';
import { loadExecutionPolicyRecord, persistExecutionPolicyRecord } from './executionPolicySelection.js';
import { acquireSessionPolicyLease } from './sessionPolicyLease.js';
import { constrainNewSessionPolicy, recordNewSessionPolicy, recordResumedSessionMigration, resolveResumedSessionPolicy } from './sessionExecutionPolicy.js';

test('new sessions pin host and Docker choices and distinguish explicit host escalation',()=>{
  assert.deepEqual(constrainNewSessionPolicy({profile:'host_native',source:'default'},{}),
    {profile:'host_native',source:'default',expectedBoundary:'host'});
  assert.deepEqual(constrainNewSessionPolicy({profile:'safe_repo',source:'explicit'},{}),
    {profile:'safe_repo',source:'explicit',expectedBoundary:'docker'});
  assert.deepEqual(constrainNewSessionPolicy({profile:'safe_repo',source:'explicit'},{BABEL_DOCKER_DISABLE:'true'}),
    {profile:'safe_repo',source:'explicit',expectedBoundary:'host'});
});

test('resume preserves a saved Docker boundary and migration requires an explicit selection',()=>{
  const root=mkdtempSync(join(tmpdir(),'babel-resume-policy-'));
  const previous=process.env['BABEL_RUNS_DIR'];process.env['BABEL_RUNS_DIR']=root;
  const id='chat-resume-policy';mkdirSync(chatSessionDir(id),{recursive:true});
  const lease=acquireSessionPolicyLease(id);
  try{
    assert.throws(()=>resolveResumedSessionPolicy(id,undefined,{}),/explicit execution profile/i);
    persistExecutionPolicyRecord(chatSessionDir(id),{profile:'safe_repo',source:'default'},{kind:'docker'});
    assert.throws(()=>resolveResumedSessionPolicy(id,undefined,{BABEL_EXECUTION_PROFILE:'host_native'}),/differs from the saved/i);
    assert.deepEqual(resolveResumedSessionPolicy(id,undefined,{BABEL_EXECUTION_PROFILE:'safe_repo'}),
      {profile:'safe_repo',source:'persisted',expectedBoundary:'docker'});
    const migration=resolveResumedSessionPolicy(id,'host_native',{});
    assert.equal(migration.source,'migration');
    recordResumedSessionMigration(id,migration,{});
    assert.deepEqual(loadExecutionPolicyRecord(chatSessionDir(id)),{version:1,profile:'host_native',source:'migration',effectiveBoundary:'host'});
    assert.throws(()=>resolveResumedSessionPolicy('../invalid','host_native',{}),/invalid session identity/i);
  }finally{
    lease.release();
    if(previous===undefined)delete process.env['BABEL_RUNS_DIR'];else process.env['BABEL_RUNS_DIR']=previous;
    rmSync(root,{recursive:true,force:true});
  }
});

test('a fail-closed Docker selection records the required boundary without claiming availability',()=>{
  const root=mkdtempSync(join(tmpdir(),'babel-required-policy-'));
  const previous=process.env['BABEL_RUNS_DIR'];process.env['BABEL_RUNS_DIR']=root;
  try{
    const id='chat-required-policy';const directory=chatSessionDir(id);mkdirSync(directory,{recursive:true});
    const policy=constrainNewSessionPolicy({profile:'safe_repo',source:'explicit'},{});
    const engine={getEngineRunId:()=>id,getExecutionPolicy:()=>policy};
    assert.equal(recordNewSessionPolicy(engine,{}),true);
    assert.deepEqual(loadExecutionPolicyRecord(directory),{version:1,profile:'safe_repo',source:'explicit',effectiveBoundary:'docker'});
    assert.deepEqual(resolveResumedSessionPolicy(id,undefined,{}),
      {profile:'safe_repo',source:'persisted',expectedBoundary:'docker'});
  }finally{
    if(previous===undefined)delete process.env['BABEL_RUNS_DIR'];else process.env['BABEL_RUNS_DIR']=previous;
    rmSync(root,{recursive:true,force:true});
  }
});

test('a new session persists its evaluated boundary and cannot replace an existing record',()=>{
  const root=mkdtempSync(join(tmpdir(),'babel-session-policy-'));
  const previous=process.env['BABEL_RUNS_DIR'];process.env['BABEL_RUNS_DIR']=root;
  try{
    const id='chat-policy-test';const directory=chatSessionDir(id);mkdirSync(directory,{recursive:true});
    const policy=constrainNewSessionPolicy({profile:'host_native',source:'default'},{});
    const engine={getEngineRunId:()=>id,getExecutionPolicy:()=>policy};
    assert.equal(recordNewSessionPolicy(engine,{}),true);
    assert.deepEqual(loadExecutionPolicyRecord(directory),{version:1,profile:'host_native',source:'default',effectiveBoundary:'host'});
    assert.throws(()=>recordNewSessionPolicy(engine,{}),/already exists/i);
    assert.throws(()=>recordNewSessionPolicy({getEngineRunId:()=>'../invalid',getExecutionPolicy:()=>policy},{}),/session identity/i);
  }finally{
    if(previous===undefined)delete process.env['BABEL_RUNS_DIR'];else process.env['BABEL_RUNS_DIR']=previous;
    rmSync(root,{recursive:true,force:true});
  }
});
