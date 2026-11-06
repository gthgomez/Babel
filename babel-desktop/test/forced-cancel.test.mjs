import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BabelChild} from '../native/child.mjs';

for(const failed of [false,true])test(`owned forced cancellation ${failed?'preserves an existing CLI failure':'reports stopped only after the child closes'}`,{timeout:15000},async()=>{
 const root=await mkdtemp(join(tmpdir(),'babel-forced-stop-'));let runner;
 try{
  const entry=join(root,'fixture.mjs');
  await writeFile(entry,`console.log(JSON.stringify({type:${JSON.stringify(failed?'run_error':'run_start')},error:'Original CLI failure'}));process.stdin.resume();setInterval(()=>{},1000);`);
  const env={};for(const key of ['PATH','SystemRoot','WINDIR','TEMP','TMP','COMSPEC','PATHEXT'])if(process.env[key])env[key]=process.env[key];
  runner=new BabelChild({executable:process.execPath,entry,projectRoot:root,env,inheritEnv:false});
  const packets=[];
  await new Promise(resolve=>runner.start({runId:`forced-stop-${failed}`,task:'Non-inference child fixture',mode:'chat'},packet=>{
   packets.push(packet);
   if(packet.event?.type===(failed?'run_error':'run_start'))runner.cancel();
   if(packet.kind==='exit')resolve();
  }));
  assert.equal(runner.busy,false);
  assert.equal(packets.filter(p=>p.event?.type==='cancelled').length,failed?0:1);
  assert.equal(packets.at(-1).kind,'exit');
  if(failed)assert.equal(packets.find(p=>p.event?.type==='run_error').event.error,'Original CLI failure');
 }finally{runner?.cancel();await rm(root,{recursive:true,force:true});}
});
