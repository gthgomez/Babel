import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ChatEngine } from './chatEngine.js';
import { createRunControl, type RunControl } from '../runtime/run-control.js';
import type { ResolvedModelPolicy } from '../modelPolicy.js';

test('a cancelled predecessor with unknown physical settlement cannot start a successor',async()=>{
  const root=mkdtempSync(join(tmpdir(),'babel-settlement-stop-'));
  const previous=process.env['BABEL_RUNS_DIR'];process.env['BABEL_RUNS_DIR']=join(root,'runs');
  let dispatches=0;
  const runner={executeRawStream:async function*(){dispatches++;yield 'fixture';},executeRaw:async()=>{dispatches++;return 'fixture';},execute:async()=>{dispatches++;return {type:'completion',answer:'fixture'};},getLastInvocationMetadata:()=>null};
  const policy:ResolvedModelPolicy={policyPath:'fixture',family:'fixture',selectedTier:'cheap',resolvedBackendKey:'fixture',provider:'opencode-go',providerModelId:'fixture-model',expensive:false,enabled:true,experimental:true,blockedWithoutExplicitOptIn:false,approximateInputTokens:0,approximateOutputTokens:0,warnings:[],waterfall:[],stagePolicies:[],contextWindow:128000,contextLimit:128000,maxOutputTokens:1024,nativeToolUse:false};
  const engine=new ChatEngine({task:'Inspect the project',projectRoot:root,model:'fixture-model',providerRunner:runner as never,providerPolicy:policy});
  try{
    const control=createRunControl({runId:engine.getEngineRunId(),turnId:'previous',generation:1});
    control.requestStop({owner:control.owner,kind:'cancelled',reasonCode:'user_cancelled',source:'user'});
    (engine as unknown as {runControl:RunControl}).runControl=control;
    engine.markPhysicalSettlementUnknown();
    assert.equal(engine.hasKnownPhysicalSettlement(),false);
    const stream=engine.submitMessageStream('Continue the task');
    const first=await stream.next();
    await stream.return();
    assert.equal(first.value?.type,'failed');
    if(first.value?.type==='failed')assert.equal(first.value.reason_code,'physical_settlement_unknown');
    (engine as unknown as {physicalSettlementUnknown:boolean}).physicalSettlementUnknown=false;
    (engine as unknown as {parity:{admissionStore:unknown}}).parity.admissionStore={
      listAdmissions:()=>({records:[{state:'indeterminate'}],skippedCorruptRows:0}),close(){},
    };
    const recovered=engine.submitMessageStream('Continue after recovery');
    const next=await recovered.next();
    await recovered.return();
    assert.equal(next.value?.type,'failed');
    if(next.value?.type==='failed')assert.equal(next.value.reason_code,'physical_settlement_unknown');
    assert.equal(dispatches,0);
  }finally{
    engine.closeAdmissionStore();
    if(previous===undefined)delete process.env['BABEL_RUNS_DIR'];else process.env['BABEL_RUNS_DIR']=previous;
    rmSync(root,{recursive:true,force:true});
  }
});
