import assert from 'node:assert/strict';
import test from 'node:test';
import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {isSyntheticProviderFixtureReady,prepareSyntheticProviderFixture,removeSyntheticProviderFixture,summarizeSyntheticProviderOutput} from '../testinfra/synthetic-provider-fixture.mjs';

if(!isSyntheticProviderFixtureReady()){
  test('Plan authority regressions use an isolated synthetic profile',t=>{
    const fixture=prepareSyntheticProviderFixture();
    try{
      const child=spawnSync(process.execPath,['--import',new URL('../testinfra/synthetic-provider-fixture.mjs',import.meta.url).href,'--import',import.meta.resolve('tsx'),'--import',new URL('../testinfra/register-no-ambient-inference.mjs',import.meta.url).href,'--test','--test-reporter=tap','--test-concurrency=1',fileURLToPath(import.meta.url)],{cwd:fixture.cwd,env:fixture.env,encoding:'utf8',windowsHide:true,timeout:45000});
      const output=String(child.stdout)+String(child.stderr);
      t.diagnostic(summarizeSyntheticProviderOutput(output,child.status));
      if(child.status!==0)t.diagnostic(JSON.stringify({handoffBypass:output.includes('PLAN_HANDOFF_GATE_BYPASS'),kernelPolicyStale:output.includes('PLAN_KERNEL_POLICY_STALE'),fixtureChanged:output.includes('PLAN_FIXTURE_CHANGED')}));
      assert.equal(child.error===undefined,true,'isolated Plan tests must settle before the watchdog');
      assert.equal(child.status,0,'isolated Plan authority regressions must pass');
    }finally{removeSyntheticProviderFixture(fixture.root);}
  });
}else{
  const {ChatEngine}=await import('./chatEngine.js');
  test('preparing Plan rebinds the kernel tool policy before dispatch',async()=>{
    const target=join(process.cwd(),'kernel-plan.txt');
    writeFileSync(target,'unchanged fixture bytes');
    const engine=new ChatEngine({task:'Inspect the proposed change',projectRoot:process.cwd(),executionProfile:'chat'});
    try{
      engine.applyTurnPreparation({task:'Plan the change without applying it',executionProfile:'plan'});
      const kernel=(engine as unknown as {executorKernel:import('../executor/kernel.js').ExecutorKernel}).executorKernel;
      const result=await kernel.tools.execute({tool:'file_write',path:target,content:'forbidden kernel mutation'},{agentId:'plan-fixture',babelRoot:process.cwd(),projectRoot:process.cwd(),runId:engine.getEngineRunId()});
      assert.equal(result.exit_code,1);
      assert.match(result.stderr,/plan_read_only/,'PLAN_KERNEL_POLICY_STALE');
      assert.equal(readFileSync(target,'utf8'),'unchanged fixture bytes','PLAN_FIXTURE_CHANGED');
    }finally{engine.closeAdmissionStore();}
  });
  const {createChatPlanExecuteHandoff}=await import('./planExecuteMode.js');
  const handoff=createChatPlanExecuteHandoff({planId:'historical-plan',planBody:'Historical implementation handoff',elevatedMutate:true});
  for(const reused of [false,true])test(`active Plan denies mutation before dispatch despite a ${reused?'retained':'constructor'} implementation handoff`,async()=>{
    const target=join(process.cwd(),`plan-${reused}.txt`);
    writeFileSync(target,'unchanged fixture bytes');
    const engine=new ChatEngine({task:'Inspect the proposed change',projectRoot:process.cwd(),executionProfile:reused?'chat':'plan',planHandoff:handoff});
    try{
      if(reused)engine.applyTurnPreparation({task:'Plan the change without applying it',executionProfile:'plan'});
      // Drive the real tool boundary without inference. Even the unfixed path
      // still has the lower Plan executor policy, so this fixture cannot write.
      const tools=engine as unknown as {executeActions: (actions:Array<{type:'write_file';path:string;content:string}>,callbacks:{onToolComplete:(_id:number,detail:string,error?:string,exitCode?:number)=>void})=>Promise<unknown>};
      const receipts:Array<{detail:string;error:string|undefined;exitCode:number|undefined}>=[];
      await tools.executeActions([{type:'write_file',path:target,content:'forbidden mutation'}],{onToolComplete:(_id,detail,error,exitCode)=>{receipts.push({detail,error,exitCode});}});
      assert.ok(receipts.some(receipt=>receipt.detail==='hard-plan-mode'&&receipt.error==='blocked'&&receipt.exitCode===1),'PLAN_HANDOFF_GATE_BYPASS');
      assert.equal(readFileSync(target,'utf8'),'unchanged fixture bytes','PLAN_FIXTURE_CHANGED');
      assert.equal(engine.getParityRuntime().sessionEvents.events.some(event=>event.kind==='tool_started'),false,'Plan must refuse before effect dispatch');
    }finally{engine.closeAdmissionStore();}
  });
}
