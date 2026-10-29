import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {ChatEngine} from './chatEngine.js'
import {OpenRouterApiRunner} from '../runners/openRouterApi.js'
import type {ToolStreamEvent} from '../runners/base.js'
import {validateProviderMessageProtocol,type WireProviderMessage} from '../runners/providerMessages.js'
import {globalCostTracker} from '../services/costTracker.js'

for(const scenario of ['corrected','malformed_json','malformed_repeated','malformed_unknown_usage','malformed_raw_missing_id','malformed_raw_duplicate_id','malformed_cancelled','oversized_reference','repeated','unknown_usage','late_duplicate','raw_missing_id','raw_duplicate_id','truncated','transport_after_done','wrong_model','cancelled','valid_unknown_usage','unknown_pricing'] as const)
test(`native schema recovery: ${scenario} preserves whole-batch denial and settled accounting`,async t=>{
  const root=mkdtempSync(join(tmpdir(),'babel-native-schema-'))
  writeFileSync(join(root,'fixture.txt'),'ORIGINAL_FIXTURE\n')
  const names=['BABEL_NATIVE_TOOLS','BABEL_TOOL_PROFILE','BABEL_COMPACTION'] as const
  const previous=names.map(name=>[name,process.env[name]] as const)
  process.env['BABEL_NATIVE_TOOLS']='enabled';process.env['BABEL_TOOL_PROFILE']='legacy';process.env['BABEL_COMPACTION']='off'
  t.after(()=>{for(const [name,value]of previous){if(value===undefined)delete process.env[name];else process.env[name]=value}rmSync(root,{recursive:true,force:true})})
  let cancelCurrent=()=>{}
  let recordUnpricedCharge=()=>{}
  const accountingOnly=scenario==='valid_unknown_usage'||scenario==='unknown_pricing'
  const model='z-ai/glm-5.3-flash'
  class Receiver extends OpenRouterApiRunner {
    bodies:Array<{messages:WireProviderMessage[]}>=[]
    constructor(){super(model,{}, {explicitCredential:'fixture-only-no-network',env:{}})}
    protected override getRequestMaxRetries(){return 1}
    protected override getStreamMaxRetries(){return 0}
    protected override async dispatchFetch(_url:string,init:RequestInit):Promise<Response>{
      this.bodies.push(JSON.parse(String(init.body)))
      if(scenario==='unknown_pricing')recordUnpricedCharge()
      const attempt=this.bodies.length
      const malformed=!accountingOnly&&(attempt===1 || scenario==='repeated'||scenario==='malformed_repeated')
      const calls=accountingOnly ? [{id:'valid-only-call',name:'read_file',arguments:JSON.stringify({path:'fixture.txt'})}] : malformed ? [
        {id:'valid-before-rejection',name:'read_file',arguments:JSON.stringify({path:'fixture.txt'})},
        {id:scenario==='raw_missing_id'||scenario==='malformed_raw_missing_id'?'':scenario==='raw_duplicate_id'||scenario==='malformed_raw_duplicate_id'?'valid-before-rejection':'rejected-call',name:'str_replace',arguments:scenario.startsWith('malformed_') ? '{"file_path":"fixture.txt","old_str":"ORIGINAL_FIXTURE","new_str":' : JSON.stringify(scenario==='oversized_reference' ? {file_path:'fixture.txt',old_str:'ORIGINAL_FIXTURE',new_str:'PRIVATE_REJECTED_VALUE',repair_plan:{schemaVersion:2,recoveryGateRef:'0123456789abcdef0123456789abcdef',workspaceRevision:'rev',hypothesisClass:'logic',targetIdentities:['fixture.txt'],actionFamily:'str_replace',criterionId:'npm test',supportingObservationIds:['PRIVATE_REJECTED_VALUE'.repeat(8)]}} : {file_path:'fixture.txt',new_str:'PRIVATE_REJECTED_VALUE'})},
      ] : attempt===2 ? [{id:'corrected-call',name:'read_file',arguments:JSON.stringify({path:'fixture.txt'})}] : []
      const delta=calls.length ? {tool_calls:calls.map((call,index)=>({index,id:call.id,type:'function',function:{name:call.name,arguments:call.arguments}}))} : {content:'The fixture contains ORIGINAL_FIXTURE. No file was changed.'}
      const payload={model:scenario==='wrong_model'?'different-model':model,choices:[{delta,finish_reason:scenario==='truncated'?'length':calls.length?'tool_calls':'stop'}],
        ...(scenario==='unknown_usage'||scenario==='malformed_unknown_usage'||scenario==='valid_unknown_usage'?{}:{usage:{prompt_tokens:20,completion_tokens:10,total_tokens:30}})}
      return new Response(`data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`,{headers:{'content-type':'text/event-stream'}})
    }
    override async *executeWithToolsStream(...args:Parameters<OpenRouterApiRunner['executeWithToolsStream']>):AsyncGenerator<ToolStreamEvent,void,undefined>{
      for await(const event of super.executeWithToolsStream(...args)){
        yield event
        if(scenario==='late_duplicate'&&event.type==='tool_use'&&event.id==='rejected-call')yield event
        if(scenario==='cancelled'&&event.type==='tool_use'&&event.id==='rejected-call')cancelCurrent()
        if(scenario==='malformed_cancelled'&&event.type==='error'&&event.malformedToolArguments)cancelCurrent()
      }
      if(scenario==='transport_after_done')throw new Error('fixture transport failed after done')
    }
  }
  const runner=new Receiver()
  const engine=new ChatEngine({task:'Explain fixture.txt without editing files.',projectRoot:root,model,providerRunner:runner,maxTurns:5,maxCostUsd:0.08,runtimeMode:'direct'})
  cancelCurrent=()=>engine.cancel()
  // A prior owner-scoped charge with unavailable pricing must survive the next
  // otherwise valid receiver response and stop further paid dispatch.
  recordUnpricedCharge=()=>globalCostTracker.recordUnknownCharge('fixture-unpriced-model',{
    taskOwnerId:(engine as unknown as {taskAllowance:{taskOwnerId:string}}).taskAllowance.taskOwnerId,
    chargeId:'fixture-unpriced-charge',
  })
  const events=[]
  for await(const event of engine.submitMessageStream('Explain fixture.txt without editing files.','explain'))events.push(event)
  const host=engine as unknown as {engineRunDir:string;taskAllowance:{taskOwnerId:string}}
  const summary=globalCostTracker.getTaskSummary(host.taskAllowance.taskOwnerId)
  assert.equal(readFileSync(join(root,'fixture.txt'),'utf8'),'ORIGINAL_FIXTURE\n')
  const completed=events.filter(event=>event.type==='tool_complete')
  if(accountingOnly){
    assert.equal(runner.bodies.length,1)
    assert.equal(completed.length,1,'the valid first read executes; accounting stops the next paid dispatch')
    const terminal=events.at(-1)!
    assert.ok(terminal.type==='done'||terminal.type==='failed')
    assert.equal(terminal.outcome,'INFRA_FAILURE')
    assert.equal(terminal.reason_code,'cost_accounting_incomplete')
    assert.equal('budgetExceeded' in terminal,false)
    assert.doesNotMatch(JSON.stringify(terminal),/BUDGET_EXCEEDED|budget_exhausted/)
    assert.equal(summary.costComplete,false)
    assert.ok((summary.unknownChargeCount ?? 0)>0)
  } else if(scenario==='corrected'||scenario==='malformed_json'||scenario==='oversized_reference'){
    assert.equal(runner.bodies.length,3,JSON.stringify(events))
    assert.equal(completed.length,1,'only the corrected batch may execute')
    assert.ok(events.some(event=>event.type==='done'))
    const correction=JSON.stringify(runner.bodies[1]!.messages)
    assert.match(correction,/Native tool schema correction/)
    assert.match(correction,/old_str/)
    if(scenario==='oversized_reference'){
      assert.match(correction,/exact 16-character IDs/)
      assert.match(correction,/recovery_observation_keys/)
      assert.match(correction,/no admissible IDs/)
    }
    assert.doesNotMatch(correction,/PRIVATE_REJECTED_VALUE/)
    if(scenario==='malformed_json')assert.match(correction,/invalid_json/)
  } else {
    assert.equal(runner.bodies.length,scenario==='repeated'||scenario==='malformed_repeated'?2:1,JSON.stringify(events))
    assert.equal(completed.length,0)
    assert.ok(events.some(event=>event.type===(scenario==='cancelled'||scenario==='malformed_cancelled'?'cancelled':'failed')))
  }
  if(['corrected','oversized_reference','repeated','late_duplicate','raw_missing_id','raw_duplicate_id'].includes(scenario)){
    assert.equal(summary.estimateComplete,true,JSON.stringify(summary))
    assert.equal(summary.costComplete,false,JSON.stringify(summary))
  }
  if(scenario==='unknown_usage')assert.equal(summary.costComplete,false)
  if(scenario==='malformed_json'){
    assert.equal(summary.estimateComplete,true)
    assert.equal(summary.unknownChargeCount,0)
    assert.equal(summary.totalTokens,90)
  }
  if(scenario==='malformed_unknown_usage'){
    assert.equal(summary.estimateComplete,false)
    assert.ok((summary.unknownChargeCount ?? 0)>0)
  }
  for(const body of runner.bodies)assert.deepEqual(validateProviderMessageProtocol(body.messages).filter(issue=>issue.code!=='system_in_user_content'),[])
  if(!accountingOnly&&scenario!=='truncated'){
    const diagnostic=readFileSync(join(host.engineRunDir,'native-tool-rejection.json'),'utf8')
    assert.doesNotMatch(diagnostic,/PRIVATE_REJECTED_VALUE/)
    if(scenario==='raw_missing_id'||scenario==='raw_duplicate_id'||scenario==='malformed_raw_missing_id'||scenario==='malformed_raw_duplicate_id')assert.equal(JSON.parse(diagnostic).provider_call_id_normalized,true)
  }
})
