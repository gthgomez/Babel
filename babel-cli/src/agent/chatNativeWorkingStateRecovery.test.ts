import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import {ChatEngine} from './chatEngine.js'
import {OpenRouterApiRunner} from '../runners/openRouterApi.js'
import type {ToolStreamEvent} from '../runners/base.js'
import {WORKING_STATE_MARKER} from './codingLoop/workingState.js'
import {globalCostTracker} from '../services/costTracker.js'
import {validateProviderMessageProtocol,type WireProviderMessage} from '../runners/providerMessages.js'

const leaked=`${WORKING_STATE_MARKER}\nworking_state:\n  goal: "PRIVATE_CONTROLLER_VALUE"\n</arg_value></tool_call>`
for(const scenario of ['corrected','repeated','unknown_usage','truncated','transport_after_done','cancelled','literal','fenced','quoted','prose','diverging_prefix','format_then_schema','schema_then_format','format_token_limit','schema_token_limit','fallback_controller','fallback_unknown_usage','fallback_token_limit','fallback_cancelled','fallback_announced_invalid','fallback_announced_transport'] as const)
test(`native working-state completion: ${scenario} preserves stream and bounded recovery`,async t=>{
  const root=mkdtempSync(join(tmpdir(),'babel-native-state-'))
  writeFileSync(join(root,'fixture.txt'),'UNCHANGED\n')
  const names=['BABEL_NATIVE_TOOLS','BABEL_TOOL_PROFILE','BABEL_COMPACTION'] as const
  const previous=names.map(name=>[name,process.env[name]] as const)
  process.env['BABEL_NATIVE_TOOLS']='enabled';process.env['BABEL_TOOL_PROFILE']='legacy';process.env['BABEL_COMPACTION']='off'
  t.after(()=>{for(const [name,value]of previous){if(value===undefined)delete process.env[name];else process.env[name]=value}rmSync(root,{recursive:true,force:true})})
  const legitimate={literal:WORKING_STATE_MARKER,fenced:'```text\n'+leaked+'\n```',quoted:'> '+leaked.replaceAll('\n','\n> '),prose:'The example is '+WORKING_STATE_MARKER+'; it is literal text.',diverging_prefix:'<span>READY</span>'}
  const expected=scenario in legitimate?legitimate[scenario as keyof typeof legitimate]:'READY'
  let cancelCurrent=()=>{}
  class Receiver extends OpenRouterApiRunner {
    bodies:Array<{messages:WireProviderMessage[]}>=[]
    streamAttempts=0;rawCalls=0
    constructor(){super('z-ai/glm-5.3-flash',{}, {explicitCredential:'fixture-only-no-network',env:{}})}
    protected override getRequestMaxRetries(){return 1}
    protected override getStreamMaxRetries(){return 0}
    protected override async dispatchFetch(_url:string,init:RequestInit):Promise<Response>{
      this.bodies.push(JSON.parse(String(init.body)))
      const attempt=this.bodies.length
      const schema=scenario==='schema_token_limit'||scenario==='schema_then_format'&&attempt===1||scenario==='format_then_schema'&&attempt===2
      const content=scenario in legitimate?expected:attempt===1||scenario==='repeated'||scenario==='schema_then_format'?leaked:'READY'
      const chunks:Array<Record<string,unknown>>=schema?[{tool_calls:[{index:0,id:'schema-call',type:'function',function:{name:'str_replace',arguments:JSON.stringify({file_path:'fixture.txt',new_str:'PRIVATE_ARGUMENT_VALUE'})}}]}]:
        [content.slice(0,2),content.slice(2,14),content.slice(14,28),content.slice(28)].map(content=>({content}))
      if(scenario.startsWith('fallback_announced_'))chunks.unshift({tool_calls:[{index:0,id:'announced-valid',type:'function',function:{name:'read_file',arguments:JSON.stringify({path:'fixture.txt'})}}]})
      if(scenario==='fallback_announced_invalid')chunks.push({tool_calls:[{index:1,id:'announced-invalid',type:'function',function:{name:'str_replace',arguments:JSON.stringify({file_path:'fixture.txt',new_str:'PRIVATE_ARGUMENT_VALUE'})}}]})
      const lines=chunks.map(delta=>'data: '+JSON.stringify({model:'z-ai/glm-5.3-flash',choices:[{delta,finish_reason:null}]}))
      lines.push('data: '+JSON.stringify({model:'z-ai/glm-5.3-flash',choices:[{delta:{},finish_reason:scenario==='truncated'?'length':schema?'tool_calls':'stop'}],
        ...(scenario.endsWith('unknown_usage')?{}:{usage:{prompt_tokens:scenario.endsWith('_token_limit')?20000:20,completion_tokens:10,total_tokens:scenario.endsWith('_token_limit')?20010:30}})}),'data: [DONE]')
      return new Response(lines.join('\n\n')+'\n\n',{headers:{'content-type':'text/event-stream'}})
    }
    override async *executeRawStream(..._args:Parameters<OpenRouterApiRunner['executeRawStream']>):AsyncGenerator<string,void,undefined>{this.rawCalls++;yield 'READY'}
    override async *executeWithToolsStream(...args:Parameters<OpenRouterApiRunner['executeWithToolsStream']>):AsyncGenerator<ToolStreamEvent,void,undefined>{
      if(scenario.startsWith('fallback_')&&this.streamAttempts++===0)throw new Error('fixture primary native request failed')
      for await(const event of super.executeWithToolsStream(...args)){
        yield event
        if(scenario.endsWith('cancelled')&&event.type==='text_delta'&&event.text.includes('working_state:'))cancelCurrent()
      }
      if(scenario==='transport_after_done'||scenario==='fallback_announced_transport')throw new Error('fixture transport failed after done')
    }
  }
  const runner=new Receiver(),engine=new ChatEngine({task:'Reply with READY.',projectRoot:root,model:'z-ai/glm-5.3-flash',providerRunner:runner,maxTurns:5,maxCostUsd:0.08,maxTokensPerRound:10000,runtimeMode:'direct'})
  if(scenario.startsWith('fallback_')){
    (engine as unknown as {resolveFallbackOrFail:()=>AsyncGenerator<never,Receiver,undefined>}).resolveFallbackOrFail=async function*(){return runner}
  }
  cancelCurrent=()=>engine.cancel()
  const events=[]
  for await(const event of engine.submitMessageStream('Reply with READY.','explain'))events.push(event)
  const chunks=events.filter(e=>e.type==='answer_chunk').map(e=>e.text).join('')
  const success=scenario==='corrected'||scenario in legitimate
  if(success){
    assert.equal(runner.bodies.length,scenario==='corrected'?2:1)
    assert.equal(chunks,expected,'actual streamed bytes must match the legitimate final answer once')
    assert.ok(events.some(e=>e.type==='done'&&e.answer===expected))
  }else{
    assert.equal(runner.bodies.length,['repeated','format_then_schema','schema_then_format'].includes(scenario)?2:1)
    assert.equal(chunks,'','internal controller text must never reach the public answer stream')
    assert.ok(events.some(e=>scenario.endsWith('_token_limit')?e.type==='done'&&e.budgetExceeded===true:e.type===(scenario.endsWith('cancelled')?'cancelled':'failed')))
    assert.ok(!events.some(e=>(e.type==='done'||e.type==='failed')&&e.outcome==='NEEDS_HUMAN_DECISION'))
  }
  if(scenario.startsWith('fallback_announced_')){
    const announced=events.filter(e=>e.type==='tool_start').map(e=>e.toolCallId)
    assert.deepEqual(announced,['announced-valid'])
    assert.deepEqual(events.filter(e=>e.type==='tool_failed').map(e=>e.toolCallId),announced,'every announced nonexecuted tool must settle')
    const failed=events.find(e=>e.type==='failed')
    assert.ok(failed?.type==='failed')
    assert.equal(failed.reason_code,scenario==='fallback_announced_invalid'?'native_tool_protocol_invalid':'provider_failure')
  }
  assert.equal(runner.rawCalls,0,'a rejected native controller completion must not degrade into another raw request')
  assert.equal(events.filter(e=>e.type==='tool_complete').length,0)
  assert.equal(readFileSync(join(root,'fixture.txt'),'utf8'),'UNCHANGED\n')
  const host=engine as unknown as {taskAllowance:{taskOwnerId:string};engineRunDir:string}
  const summary=globalCostTracker.getTaskSummary(host.taskAllowance.taskOwnerId)
  if(scenario.endsWith('unknown_usage'))assert.equal(summary.costComplete,false)
  if(scenario==='corrected'||scenario==='repeated')assert.equal(summary.costComplete,true)
  if(scenario==='corrected'||scenario==='repeated'){
    const diagnostic=readFileSync(join(host.engineRunDir,'native-completion-rejection.json'),'utf8')
    assert.doesNotMatch(diagnostic,/PRIVATE_CONTROLLER_VALUE/)
    assert.equal(JSON.parse(diagnostic).sha256,createHash('sha256').update(leaked).digest('hex'))
  }
  if(runner.bodies.length>1){
    const correction=JSON.stringify(runner.bodies[1]!.messages)
    assert.doesNotMatch(correction,/PRIVATE_CONTROLLER_VALUE|PRIVATE_ARGUMENT_VALUE/)
    assert.match(correction,/correction/i)
  }
  for(const body of runner.bodies)assert.deepEqual(validateProviderMessageProtocol(body.messages).filter(issue=>issue.code!=='system_in_user_content'),[])
})
