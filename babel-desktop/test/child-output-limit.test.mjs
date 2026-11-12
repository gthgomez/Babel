import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BabelChild} from '../native/child.mjs';

test('approval and terminal events remain observable after the display limit',async()=>{
  const root=await mkdtemp(join(tmpdir(),'babel-output-limit-'));
  const entry=join(root,'fixture.mjs');
  await writeFile(entry,`
    import {once} from 'node:events';
    const line=JSON.stringify({type:'assistant_chunk',chunk:'x'.repeat(256*1024)})+'\\n';
    for(let i=0;i<100;i++) if(!process.stdout.write(line)) await once(process.stdout,'drain');
    const approval={schemaVersion:2,request_id:'approval-1',thread_id:'thread-1',turn_id:'turn-1',operation_digest:'a'.repeat(64),run_id:process.env.BABEL_DESKTOP_RUN_ID,expires_at:new Date(Date.now()+300000).toISOString()};
    process.stdout.write(JSON.stringify({type:'approval.required',item:{approval}})+'\\n');
    await Promise.race([once(process.stdin,'data'),new Promise(resolve=>setTimeout(resolve,1000))]);
    process.stdin.pause();
    process.stdout.write(JSON.stringify({type:'run_complete',result:{terminal_outcome:'VERIFIED_COMPLETE'}})+'\\n');
  `);
  const runner=new BabelChild({executable:process.execPath,entry,projectRoot:root,inheritEnv:false,env:{SystemRoot:process.env.SystemRoot??''}});
  let timer,approvalSeen=false,terminalSeen=false,exit;
  try{
    await new Promise((resolve,reject)=>{
      timer=setTimeout(()=>reject(new Error('Output-limit fixture timed out')),15000);
      runner.start({runId:'run-1',task:'fixture',mode:'chat'},packet=>{
        try{
          if(packet.event?.type==='approval.required'){
            approvalSeen=true;
            assert.equal(runner.awaitingApproval,true);
            assert.equal(runner.reply({runId:'run-1',decision:'allow_once',approval:packet.event.item.approval}),true);
          }
          if(packet.event?.type==='run_complete') terminalSeen=true;
          if(packet.kind==='exit'){exit=packet;resolve();}
        }catch(error){reject(error);}
      });
    });
    assert.equal(exit.code,0);
    assert.equal(exit.displayLimited,true);
    assert.equal(approvalSeen,true);
    assert.equal(terminalSeen,true);
  }finally{clearTimeout(timer);runner.cancel();await new Promise(resolve=>runner.whenIdle(resolve));await rm(root,{recursive:true,force:true});}
});
