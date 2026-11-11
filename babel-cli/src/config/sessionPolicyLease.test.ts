import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { acquireSessionPolicyLease } from './sessionPolicyLease.js';

test('session ownership excludes another process until the owner releases it',()=>{
  const root=mkdtempSync(join(tmpdir(),'babel-policy-owner-'));
  const previous=process.env['BABEL_RUNS_DIR'];process.env['BABEL_RUNS_DIR']=root;
  const owner=acquireSessionPolicyLease('chat-owner-fixture',{create:true});
  try{
    const url=new URL('./sessionPolicyLease.ts',import.meta.url).href;
    const source=`import {acquireSessionPolicyLease} from ${JSON.stringify(url)}; try { const lease=acquireSessionPolicyLease('chat-owner-fixture'); lease.release(); } catch { process.exitCode=75; }`;
    const run=()=>spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',source],{
      cwd:process.cwd(),encoding:'utf8',timeout:15000,windowsHide:true,env:{
        PATH:process.env['PATH'],SystemRoot:process.env['SystemRoot'],TEMP:process.env['TEMP'],TMP:process.env['TMP'],BABEL_RUNS_DIR:root,
      },
    });
    assert.equal(run().status,75);
    assert.throws(()=>acquireSessionPolicyLease('chat-owner-fixture'),/already owned|unavailable/i);
    owner.release();
    assert.equal(run().status,0);
    assert.throws(()=>acquireSessionPolicyLease('../invalid'),/invalid session identity/i);
  }finally{
    owner.release();
    if(previous===undefined)delete process.env['BABEL_RUNS_DIR'];else process.env['BABEL_RUNS_DIR']=previous;
    rmSync(root,{recursive:true,force:true});
  }
});
