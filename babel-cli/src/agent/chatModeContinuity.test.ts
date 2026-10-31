import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,readFileSync,readdirSync,rmSync,writeFileSync,lstatSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ChatEngine} from './chatEngine.js';
import {chatSessionDir} from '../cli/runsLayout.js';
import {loadLiveSessionAuthorityStrict,INSTRUCTION_MANIFEST_FILENAME,TASK_CONTRACT_FILENAME,TASK_MODE_HISTORY_FILENAME} from './liveSessionBridge.js';
import {startTurn,recordAssistantMessage,serializeThreadEventLog,THREAD_EVENT_LOG_FILENAME} from './threadEventLog.js';
import {recordUserSubmitted,serializeSessionEventLog,SESSION_EVENTS_FILENAME} from './sessionEvents.js';
import {checkpointParityEventLogStrictSync} from './chatEngineParityBridge.js';
import {createEngineFromEventLog,createEngineFromThreadCells} from '../services/threadStore/conversationSync.js';

function fixture(mode:'chat'|'plan',body:(engine:ChatEngine,runDir:string)=>void){
  const root=mkdtempSync(join(tmpdir(),'babel-mode-continuity-')),prior=process.env['BABEL_RUNS_DIR'];
  process.env['BABEL_RUNS_DIR']=join(root,'runs');
  try{
    const engine=new ChatEngine({ model: 'deepseek-v4-flash-openrouter',task:'Fix the fixture and run its required tests',projectRoot:root,executionProfile:mode,requiredVerifierCommands:['node --test fixture.test.mjs'],maxTurns:12});
    body(engine,chatSessionDir(engine.getEngineRunId()));
  }finally{if(prior===undefined)delete process.env['BABEL_RUNS_DIR'];else process.env['BABEL_RUNS_DIR']=prior;rmSync(root,{recursive:true,force:true});}
}

test('Chat to Plan to Chat preserves one accepted objective and strict cold authority',()=>fixture('chat',(engine,runDir)=>{
  const original=engine.getTaskContract()!,bytes=JSON.stringify(original);
  engine.applyTurnPreparation({task:'continue',executionProfile:'plan'});
  const plan=engine.getTaskContract()!;
  assert.equal(plan.mode,'plan');assert.equal(plan.task_id,original.task_id);
  assert.equal(plan.provenance.parent_contract_id,original.contract_id);
  assert.deepEqual(plan.allowed_effects,['read_only']);
  assert.equal(loadLiveSessionAuthorityStrict(runDir).taskContract.contract_id,plan.contract_id);
  engine.applyTurnPreparation({task:'continue',executionProfile:'chat'});
  const chat=engine.getTaskContract()!;
  assert.equal(chat.mode,'chat');assert.equal(chat.task_id,original.task_id);
  assert.equal(chat.provenance.parent_contract_id,plan.contract_id);
  for(const current of [plan,chat]){
    assert.deepEqual(current.acceptance,original.acceptance);assert.deepEqual(current.verifier_requirements,original.verifier_requirements);
    assert.deepEqual(current.budgets,original.budgets);assert.equal(current.user_request,original.user_request);
  }
  assert.deepEqual(chat.allowed_effects,original.allowed_effects);
  assert.equal(loadLiveSessionAuthorityStrict(runDir).taskContract.contract_id,chat.contract_id);
  assert.equal(JSON.stringify(original),bytes);
}));

for(const fromCells of [false,true])test(`the ${fromCells?'cells':'event-log'} resume factory retains a Plan root without replacing its authority`,()=>fixture('plan',(engine,runDir)=>{
  const original=engine.getTaskContract()!,scope=engine.getExecutionScope();if(scope.kind!=='project')throw new Error('Project fixture required');
  const runtime=engine.getParityRuntime(),turnId=startTurn(runtime.eventLog,{task:original.user_request,model:'fixture',provider:'ollama',projectRoot:scope.projectRoot,policyPreset:'safe_repo'});
  recordUserSubmitted(runtime.sessionEvents,{turn_id:turnId,task:original.user_request});
  assert.equal(checkpointParityEventLogStrictSync(runtime,runDir).status,'committed');
  const options={model:'deepseek-v4-flash-openrouter',task:'Resumed session fixture',projectRoot:scope.projectRoot,runtimeMode:'tui' as const};
  const restored=fromCells?createEngineFromThreadCells(engine.getEngineRunId(),options,[]):createEngineFromEventLog(options,runtime.eventLog);
  assert.equal(restored.getTaskContract()!.mode,'plan');assert.equal(restored.getTaskContract()!.contract_id,original.contract_id);
  assert.deepEqual(restored.getResolvedRequiredVerifiers(),original.verifier_requirements);
  assert.equal(loadLiveSessionAuthorityStrict(runDir).taskContract.contract_id,original.contract_id);
  const direct=new ChatEngine({ model: 'deepseek-v4-flash-openrouter',task:'Resumed session fixture',projectRoot:scope.projectRoot,runId:engine.getEngineRunId(),resumeExisting:true});
  assert.equal(direct.getTaskContract()!.contract_id,original.contract_id);
  assert.equal(direct.getInstructionManifest()!.mode,'plan');
}));

test('the primary event-log factory preserves derived mode lineage on resume',()=>fixture('chat',(engine,runDir)=>{
  engine.applyTurnPreparation({task:'continue',executionProfile:'plan'});
  const accepted=engine.getTaskContract()!,scope=engine.getExecutionScope();if(scope.kind!=='project')throw new Error('Project fixture required');
  const restored=createEngineFromEventLog({ model: 'deepseek-v4-flash-openrouter',task:'Resumed session fixture',projectRoot:scope.projectRoot},engine.getParityEventLog());
  assert.equal(restored.getTaskContract()!.contract_id,accepted.contract_id);
  assert.equal(loadLiveSessionAuthorityStrict(runDir).taskContract.contract_id,accepted.contract_id);
}));

for(const hasAuthority of [true,false])test(`a later mode selection after legacy cells resume ${hasAuthority?'with':'without'} authority cannot checkpoint empty retained sources`,()=>fixture('chat',(engine,runDir)=>{
  const scope=engine.getExecutionScope();if(scope.kind!=='project')throw new Error('Project fixture required');
  const runtime=engine.getParityRuntime();recordUserSubmitted(runtime.sessionEvents,{turn_id:'legacy-turn',task:'Retained legacy objective'});
  writeFileSync(join(runDir,SESSION_EVENTS_FILENAME),serializeSessionEventLog(runtime.sessionEvents));
  if(!hasAuthority)for(const name of [INSTRUCTION_MANIFEST_FILENAME,TASK_CONTRACT_FILENAME,TASK_MODE_HISTORY_FILENAME])rmSync(join(runDir,name),{force:true});
  const restored=createEngineFromThreadCells(engine.getEngineRunId(),{ model: 'deepseek-v4-flash-openrouter',task:'Resumed legacy session',projectRoot:scope.projectRoot},[]);
  const before=new Map(readdirSync(runDir).filter(name=>lstatSync(join(runDir,name)).isFile()).map(name=>[name,readFileSync(join(runDir,name),'utf8')]));
  assert.throws(()=>restored.applyTurnPreparation({task:'continue',executionProfile:'plan'}),/MODE_HISTORY_SOURCE_MISSING/);
  assert.deepEqual(readdirSync(runDir).filter(name=>lstatSync(join(runDir,name)).isFile()),[...before.keys()]);
  for(const [name,bytes] of before)assert.equal(readFileSync(join(runDir,name),'utf8'),bytes);
}));

for(const hasAuthority of [true,false])test(`a later cells-resume mode selection ${hasAuthority?'with':'without'} authority preserves canonical events and observation membership`,()=>fixture('chat',(engine,runDir)=>{
  const scope=engine.getExecutionScope();if(scope.kind!=='project')throw new Error('Project fixture required');
  const runtime=engine.getParityRuntime(),turnId=startTurn(runtime.eventLog,{task:'Retain objective',model:'fixture',provider:'ollama',projectRoot:scope.projectRoot,policyPreset:'safe_repo'});
  const submitted=recordUserSubmitted(runtime.sessionEvents,{turn_id:turnId,task:'Retain objective'});
  runtime.authorizedObservationIds=new Set(['retained-observation']);
  assert.equal(checkpointParityEventLogStrictSync(runtime,runDir).status,'committed');
  const before=readFileSync(join(runDir,THREAD_EVENT_LOG_FILENAME),'utf8');
  if(!hasAuthority)for(const name of [INSTRUCTION_MANIFEST_FILENAME,TASK_CONTRACT_FILENAME,TASK_MODE_HISTORY_FILENAME])rmSync(join(runDir,name),{force:true});
  const restored=createEngineFromThreadCells(engine.getEngineRunId(),{ model: 'deepseek-v4-flash-openrouter',task:'Resumed cells',projectRoot:scope.projectRoot},[]);
  restored.applyTurnPreparation({task:'continue',executionProfile:'plan'});
  assert.equal(readFileSync(join(runDir,THREAD_EVENT_LOG_FILENAME),'utf8'),before);
  assert.equal(readFileSync(join(runDir,SESSION_EVENTS_FILENAME),'utf8').includes(submitted.event_id),true);
  assert.equal(restored.getLiveSession().authorized_observation_ids.includes('retained-observation'),true);
  recordAssistantMessage(restored.getParityEventLog(),turnId,'Pending live reply before mode switch');
  const pending=serializeThreadEventLog(restored.getParityEventLog());
  restored.applyTurnPreparation({task:'continue',executionProfile:'chat'});
  assert.equal(readFileSync(join(runDir,THREAD_EVENT_LOG_FILENAME),'utf8'),pending);
  restored.getParityEventLog().events.reverse();
  assert.throws(()=>restored.applyTurnPreparation({task:'continue',executionProfile:'plan'}),/MODE_HISTORY_DIVERGED/);
  assert.equal(readFileSync(join(runDir,THREAD_EVENT_LOG_FILENAME),'utf8'),pending);
}));

test('a Plan-only objective cannot gain execution authority through mode selection',()=>fixture('plan',(engine,runDir)=>{
  const original=engine.getTaskContract()!,manifest=engine.getInstructionManifest()!;
  const before=new Map(readdirSync(runDir).filter(name=>name.endsWith('.json')).map(name=>[name,readFileSync(join(runDir,name),'utf8')]));
  assert.throws(()=>engine.applyTurnPreparation({task:'continue',executionProfile:'chat'}),/MODE_EXECUTION_AUTHORITY_REQUIRED/);
  assert.throws(()=>engine.applyTurnPreparation({task:'continue',executionProfile:'deep'}),/MODE_UNSUPPORTED/);
  assert.equal(engine.getTaskContract(),original);assert.equal(engine.getInstructionManifest(),manifest);
  for(const [name,bytes] of before)assert.equal(readFileSync(join(runDir,name),'utf8'),bytes);
  assert.equal(loadLiveSessionAuthorityStrict(runDir).taskContract.mode,'plan');
}));

test('a cold requested mode uses the retained objective and its original Chat ceiling',()=>fixture('chat',(engine,runDir)=>{
  const original=engine.getTaskContract()!,scope=engine.getExecutionScope();assert.equal(scope.kind,'project');
  if(scope.kind!=='project')throw new Error('Project fixture required');
  const runtime=engine.getParityRuntime();
  const turnId=startTurn(runtime.eventLog,{task:original.user_request,model:'fixture',provider:'ollama',projectRoot:scope.projectRoot,policyPreset:'safe_repo'});
  recordAssistantMessage(runtime.eventLog,turnId,'Retained canonical reply');
  const submission=recordUserSubmitted(runtime.sessionEvents,{turn_id:turnId,task:original.user_request});
  engine.applyTurnPreparation({task:'continue',executionProfile:'plan'});
  const plan=engine.getTaskContract()!;
  const threadBefore=readFileSync(join(runDir,THREAD_EVENT_LOG_FILENAME),'utf8');
  const restored=new ChatEngine({ model: 'deepseek-v4-flash-openrouter',task:'continue',projectRoot:scope.projectRoot,executionProfile:'chat',runId:engine.getEngineRunId(),resumeExisting:true});
  assert.equal(restored.getTaskContract()!.mode,'chat');
  assert.equal(restored.getTaskContract()!.task_id,original.task_id);
  assert.equal(restored.getTaskContract()!.provenance.parent_contract_id,plan.contract_id);
  assert.deepEqual(restored.getTaskContract()!.acceptance,original.acceptance);
  assert.deepEqual(restored.getTaskContract()!.allowed_effects,original.allowed_effects);
  assert.deepEqual(restored.getResolvedRequiredVerifiers(),original.verifier_requirements);
  assert.equal(readFileSync(join(runDir,THREAD_EVENT_LOG_FILENAME),'utf8'),threadBefore);
  assert.equal(readFileSync(join(runDir,SESSION_EVENTS_FILENAME),'utf8').includes(submission.event_id),true);
  assert.equal(loadLiveSessionAuthorityStrict(runDir).taskContract.contract_id,restored.getTaskContract()!.contract_id);
}));
