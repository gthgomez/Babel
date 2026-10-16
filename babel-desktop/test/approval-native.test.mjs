// License: Apache-2.0 — see LICENSE
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BabelChild} from '../native/child.mjs';
import {scopedApproval,scopedApprovalReply} from '../src/core.mjs';

test('native approval normalization refuses malformed, expired and identity-mismatched replies',()=>{
  const binding={schemaVersion:2,request_id:'a-1',thread_id:'t-1',turn_id:'1',operation_digest:'a'.repeat(64),run_id:'r-1',expires_at:new Date(Date.now()+300000).toISOString()};
  assert.deepEqual(scopedApproval(binding),binding);
  assert.equal(scopedApproval({...binding,schemaVersion:1}),null);
  assert.equal(scopedApproval({...binding,operation_digest:'unknown'}),null);
  const reply={decision:'allow_once',approval:binding};
  assert.deepEqual(scopedApprovalReply(reply,binding),reply);
  assert.equal(scopedApprovalReply(reply,binding,Date.parse(binding.expires_at)),null);
  assert.equal(scopedApprovalReply(Object.assign([],{decision:'allow_once',approval:binding}),binding),null);
  for(const field of Object.keys(binding))assert.equal(scopedApprovalReply({...reply,approval:{...binding,[field]:'other'}},binding),null);
});
test('a terminal event closes native approval admission before delayed process exit',async()=>{
  const root=await mkdtemp(join(tmpdir(),'babel-terminal-approval-'));
  const entry=join(root,'fixture.mjs');
  await writeFile(entry,`const approval={schemaVersion:2,request_id:'approval-1',thread_id:'thread-1',turn_id:'turn-1',operation_digest:'a'.repeat(64),run_id:process.env.BABEL_DESKTOP_RUN_ID,expires_at:new Date(Date.now()+300000).toISOString()};console.log(JSON.stringify({type:'approval.required',item:{approval}}));console.log(JSON.stringify({type:'run_complete',result:{terminal_outcome:'CANCELLED'}}));console.log(JSON.stringify({type:'approval.required',item:{approval:{...approval,request_id:'buffered'}}}));setTimeout(()=>process.exit(0),100);`);
  const runner=new BabelChild({executable:process.execPath,entry,projectRoot:root,inheritEnv:false,env:{SystemRoot:process.env.SystemRoot??''}});
  let approval,timer,terminal=false;
  try{
    await new Promise((resolve,reject)=>{
      timer=setTimeout(()=>reject(new Error('Fixture exit timeout')),10000);
      runner.start({runId:'run-1',task:'fixture',mode:'chat'},packet=>{
        try{
          if(packet.event?.type==='approval.required'){
            approval=packet.event.item.approval;
            assert.equal(runner.awaitingApproval,!terminal);
            if(terminal)assert.equal(runner.reply({runId:'run-1',decision:'allow_once',approval}),false);
          }
          if(packet.event?.type==='run_complete'){terminal=true;assert.equal(runner.awaitingApproval,false);assert.equal(runner.reply({runId:'run-1',decision:'allow_once',approval}),false);}
          if(packet.kind==='exit'){assert.equal(packet.code,0);resolve();}
        }catch(error){reject(error);}
      });
    });
  }finally{clearTimeout(timer);runner.cancel();await new Promise(resolve=>runner.whenIdle(resolve));await rm(root,{recursive:true,force:true});}
});
test('the actual child bridge fences old runs and consumes a bound reply only once',async()=>{
  const root=await mkdtemp(join(tmpdir(),'babel-bound-approval-'));
  const entry=join(root,'fixture.mjs');
  await writeFile(entry,`const approval={schemaVersion:2,request_id:'approval-1',thread_id:'thread-1',turn_id:'turn-1',operation_digest:'a'.repeat(64),run_id:process.env.BABEL_DESKTOP_RUN_ID,expires_at:new Date(Date.now()+300000).toISOString()};
    console.log(JSON.stringify({type:'approval.required',message:'Fixture',item:{approval}}));
    process.stdin.once('data',chunk=>{const reply=JSON.parse(chunk.toString());console.log(JSON.stringify({type:'fixture.reply',decision:reply.decision,bound:JSON.stringify(reply.approval)===JSON.stringify(approval)}));process.exit(0);});`);
  const runner=new BabelChild({executable:process.execPath,entry,projectRoot:root,inheritEnv:false,
    env:{SystemRoot:process.env.SystemRoot??'',PATH:process.env.PATH??''}});
  const replies=[];
  let timer;
  try{
    await new Promise((resolve,reject)=>{
      timer=setTimeout(()=>reject(new Error('Fixture approval timeout')),10000);
      runner.start({runId:'run-1',task:'fixture',mode:'chat'},packet=>{
        try{
          if(packet.event?.type==='approval.required'){
            const approval=packet.event.item.approval;
            assert.equal(runner.reply('allow_once'),false);
            assert.equal(runner.reply({runId:'old-run',decision:'allow_once',approval}),false);
            assert.equal(runner.reply({runId:'run-1',decision:'allow_once',approval:{...approval,turn_id:'wrong-turn'}}),false);
            assert.equal(runner.reply({runId:'run-1',decision:'allow_once',approval}),true);
            assert.equal(runner.awaitingApproval,false);
            assert.equal(runner.reply({runId:'run-1',decision:'allow_once',approval}),false);
          }
          if(packet.event?.type==='fixture.reply')replies.push(packet.event);
          if(packet.kind==='exit'){assert.equal(packet.code,0);resolve();}
        }catch(error){reject(error);}
      });
    });
    assert.deepEqual(replies,[{type:'fixture.reply',decision:'allow_once',bound:true}]);
  }finally{clearTimeout(timer);runner.cancel();await new Promise(resolve=>runner.whenIdle(resolve));await rm(root,{recursive:true,force:true});}
});
test('buffered approvals cannot reopen admission after cancellation',async()=>{
  const root=await mkdtemp(join(tmpdir(),'babel-cancel-approval-'));
  const entry=join(root,'fixture.mjs');
  await writeFile(entry,`const approval={schemaVersion:2,request_id:'approval-1',thread_id:'thread-1',turn_id:'turn-1',operation_digest:'a'.repeat(64),run_id:process.env.BABEL_DESKTOP_RUN_ID,expires_at:new Date(Date.now()+300000).toISOString()};console.log(JSON.stringify({type:'approval.required',item:{approval}}));process.stdin.once('data',()=>{console.log(JSON.stringify({type:'approval.required',item:{approval:{...approval,request_id:'buffered'}}}));setTimeout(()=>process.exit(0),100);});`);
  const runner=new BabelChild({executable:process.execPath,entry,projectRoot:root,inheritEnv:false,env:{SystemRoot:process.env.SystemRoot??''}});
  let timer,seen=0;
  try{
    await new Promise((resolve,reject)=>{
      timer=setTimeout(()=>reject(new Error('Fixture cancellation timeout')),10000);
      runner.start({runId:'run-1',task:'fixture',mode:'chat'},packet=>{
        try{
          if(packet.event?.type==='approval.required'){
            seen++;
            if(seen===1)runner.cancel();
            else assert.equal(runner.reply({runId:'run-1',decision:'allow_once',approval:packet.event.item.approval}),false);
          }
          if(packet.kind==='exit'){assert.equal(packet.code,0);resolve();}
        }catch(error){reject(error);}
      });
    });
    assert.equal(seen,2);
  }finally{clearTimeout(timer);runner.cancel();await new Promise(resolve=>runner.whenIdle(resolve));await rm(root,{recursive:true,force:true});}
});
