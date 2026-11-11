import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ChatEngine, ChatEngineOptions, ChatEvent } from '../../agent/chatEngine.js';
import { globalCostTracker } from '../../services/costTracker.js';
import type { ReplContext } from '../context.js';
import { executeChatTask } from './chat.js';
import { chatSessionDir } from '../../cli/runsLayout.js';
import { loadExecutionPolicyRecord } from '../../config/executionPolicySelection.js';
import { acquireSessionPolicyLease, type SessionPolicyLease } from '../../config/sessionPolicyLease.js';

test('a new interactive chat binds the selected environment policy to its engine', async () => {
  const root=mkdtempSync(join(tmpdir(),'babel-interactive-policy-'));
  const previous=process.env['BABEL_EXECUTION_PROFILE'];
  const previousRuns=process.env['BABEL_RUNS_DIR'];
  process.env['BABEL_RUNS_DIR']=join(root,'runs');
  process.env['BABEL_EXECUTION_PROFILE']='host_native';
  const session='chat-policy-fixture';
  mkdirSync(chatSessionDir(session),{recursive:true});
  let selected:ChatEngineOptions['executionPolicy'];
  let ownedLease:SessionPolicyLease | undefined;
  const usage=globalCostTracker.getSessionSummary();
  const engine={
    submitMessageStream:async function*(){yield {type:'done',answer:'done',usage} as ChatEvent;},
    cancel(){},abortTurn(){},getTaskAllowanceSnapshot(){return null;},
    getEngineRunId(){return session;},getExecutionPolicy(){return selected;},
    attachSessionPolicyLease(lease:SessionPolicyLease){ownedLease=lease;},
  } as unknown as ChatEngine;
  const context={
    state:{mode:'chat',router:'v9',costTotals:{totalCostUSD:0,totalInputTokens:0,totalOutputTokens:0,totalTokens:0},turnCount:0},
    isRunning:false,turns:[],turnCounter:0,rl:{pause(){},resume(){}},
    appendTurn(){},
  } as unknown as ReplContext;
  try{
    await executeChatTask(context,'hello','hello',{targetRoot:root,workspaceRoot:null,project:null,source:'cwd',cwd:root},undefined,{
      gatherPreflight:async()=>undefined,
      engineFactory:options=>{selected=options.executionPolicy;return engine;},
    });
    assert.deepEqual(selected,{profile:'host_native',source:'environment',expectedBoundary:'host'});
    assert.deepEqual(loadExecutionPolicyRecord(chatSessionDir(session)),{version:1,profile:'host_native',source:'environment',effectiveBoundary:'host'});
    assert.throws(()=>acquireSessionPolicyLease(session),/already owned|unavailable/i);
    assert.equal(context.isRunning,false);
  }finally{
    ownedLease?.release();
    if(previous===undefined)delete process.env['BABEL_EXECUTION_PROFILE'];else process.env['BABEL_EXECUTION_PROFILE']=previous;
    if(previousRuns===undefined)delete process.env['BABEL_RUNS_DIR'];else process.env['BABEL_RUNS_DIR']=previousRuns;
    rmSync(root,{recursive:true,force:true});
  }
});
