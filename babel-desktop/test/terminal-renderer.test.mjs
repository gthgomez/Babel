import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {normalizeEvent,verifiedStatus} from '../src/core.mjs';

// Exercise the production event handler without starting Electron or a CLI.
const source=readFileSync(new URL('../src/app.mjs',import.meta.url),'utf8');
const start=source.indexOf('function handleNativeEvent(packet)');
const end=source.indexOf('\nasync function checkForUpdates()',start);
assert.ok(start>=0&&end>start,'production renderer handler must be present');

function renderer(mode='deep'){
  const message={text:'',status:'running',tools:[],blocks:[]};
  const context=vm.createContext({
    normalizeEvent,verifiedStatus,
    activeRun:{runId:'fixture',sessionId:'session',mode,message},
    state:{activeId:'session',sessions:[]},changedFiles:[],
    activeSession:()=>({id:'session'}),
    appendLiveText:(message,text)=>{message.text+=text;},
    scheduleConversationRender(){},settleTools(){},renderConversation(){},renderControls(){},renderTree(){},
    reviewFromResult:()=>null,toolsFromResult:()=>[],sessionIdFromResult:()=>null,
    liveModelFromResult:()=>null,liveRequestTokens:()=>null,
  });
  vm.runInContext(source.slice(start,end),context);
  return {
    message,
    event:event=>context.handleNativeEvent({runId:'fixture',kind:'event',event}),
    packet:packet=>context.handleNativeEvent({runId:'fixture',...packet}),
  };
}

test('Deep terminal answers remain visible after progress and terminal aliases do not duplicate them',()=>{
  const run=renderer();
  run.event({type:'assistant_chunk',chunk:'Analyzing your request…\nApplying changes…'});
  const answer='existing.txt contains the requested source contents.';
  const result={status:'READ_ONLY_NO_MODIFICATION',answer:{answer}};
  run.event({type:'run_complete',result});
  run.event({type:'turn.completed',result});
  assert.ok(run.message.text.includes(answer));
  assert.equal(run.message.text.split(answer).length-1,1);
});

test('a fully streamed answer is not repeated and a partial answer receives only its missing suffix',()=>{
  const answer='The requested answer is complete.';
  for(const text of [answer,'The requested answer']){
    const run=renderer('chat');
    run.event({type:'assistant_chunk',chunk:text});
    run.event({type:'run_complete',result:{terminal_outcome:'VERIFIED_COMPLETE',answer:{answer}}});
    assert.equal(run.message.text,answer);
  }
});

test('a late malformed record or display limit downgrades Plan readiness at process exit',()=>{
  for(const displayLimited of [false,true]){
    const run=renderer('plan');
    run.event({type:'run_complete',result:{command:'plan',status:'PLAN_READY',changed_files:[],answer:{answer:'Read-only plan'}}});
    assert.equal(run.message.status,'plan_ready');
    if(!displayLimited)run.packet({kind:'transport-error',error:'Malformed trailing CLI record'});
    run.packet({kind:'exit',code:0,displayLimited});
    assert.equal(run.message.status,'unverified');
  }
});

test('observed cancellation survives a nonzero child exit',()=>{
  const run=renderer();
  run.event({type:'run_complete',result:{terminal_outcome:'CANCELLED',user_status:'failed'}});
  run.packet({kind:'exit',code:1});
  assert.equal(run.message.status,'cancelled');
});
