import assert from 'node:assert/strict'
import test from 'node:test'
import {spawn} from 'node:child_process'
import {readFileSync,writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {isSyntheticProviderFixtureReady,prepareSyntheticProviderFixture,removeSyntheticProviderFixture,summarizeSyntheticProviderOutput} from '../testinfra/synthetic-provider-fixture.mjs'
import type {ChatEngineActionExecutorHost} from './chatEngineContracts.js'

if(!isSyntheticProviderFixtureReady()){
  test('scope-conflict admission uses an isolated synthetic-only production CLI path',async t=>{
    const fixture=prepareSyntheticProviderFixture()
    const child=spawn(process.execPath,['--experimental-wasm-modules','--import',new URL('../testinfra/synthetic-provider-fixture.mjs',import.meta.url).href,
      '--import',import.meta.resolve('tsx'),'--test-reporter=tap','--test',fileURLToPath(import.meta.url)],
      {cwd:fixture.cwd,env:fixture.env,windowsHide:true,stdio:['ignore','pipe','pipe']})
    let output=''
    child.stdout.on('data',chunk=>{output+=String(chunk)})
    child.stderr.on('data',chunk=>{output+=String(chunk)})
    const code=await new Promise<number>(resolve=>{child.once('error',()=>resolve(1));child.once('close',value=>resolve(value??1))})
    t.diagnostic(summarizeSyntheticProviderOutput(output,code))
    assert.equal(code,0,'production CLI admission must not call an unperformed execution successful')
    removeSyntheticProviderFixture(fixture.root)
  })
}else{
  const {runCliChatTask}=await import('../interactive/execution/chatCore.js')
  const {denyConversationAction,readOnlyExecutionConflictReport}=await import('./chatToolScopeAdmission.js')
  test('a denial from a superseded owner cannot append evidence to its successor',()=>{
    let generation=1
    const calls:ChatEngineActionExecutorHost['toolCallLog']=[]
    const host={
      activeSubmissionGeneration:1,
      toolCallLog:calls,
      isSubmissionCurrent:(owner:number)=>owner===generation,
      settleStaleActionResult:(_tool:string,_target:string,index:number)=>({index,observation:'stale owner'}),
    }
    const result=denyConversationAction(host,{type:'read_file',path:'fixture.txt'},
      {onToolStart:()=>{generation=2;return 0}},0,1)
    assert.equal(calls.length,0)
    assert.equal(result.observation,'stale owner')
  })
  const root=process.env['BABEL_PROJECT_ROOT']
  assert.ok(root,'synthetic fixture project required')
  const target=join(root,'fixture.txt')
  writeFileSync(target,'unchanged\n')
  const cases=[
    {name:'requested exporter execution with protected existing inputs',task:'Actually execute the exporter and create a result file. Do not modify existing source or configuration.',blocked:true},
    {name:'requested demonstration with an output artifact and a global denial',task:'Actually run the example and create result.txt. Do not edit any files.',blocked:true},
    {name:'ordinary execution imperative with an output artifact and a global denial',task:'Run the exporter and create result.txt. Do not edit any files.',blocked:true},
    {name:'polite execution imperative with an output artifact and a global denial',task:'Could you please execute the exporter and create result.txt. Do not edit any files.',blocked:true},
    {name:'read-only explanation of an execution example',task:'Explain how to actually run the exporter and create a result file. Do not modify existing source or configuration.',blocked:false},
    {name:'ordinary execution wording in an explanation stays advisory',task:'Explain how to run the exporter and create result.txt. Do not edit any files.',blocked:false},
    {name:'repair advice without file edits',task:'Fix this without editing files.',blocked:false},
    {name:'fenced execution instructions cannot change advice into an execution requirement',task:'Fix this without editing files.\n```text\nActually execute the exporter and create a result file.\n```',blocked:false},
    {name:'a prohibited execution is not a required execution',task:'Create a proposal. Do not actually execute the exporter. Do not edit any files.',blocked:false},
  ]
  for(const scenario of cases)test(scenario.name,async t=>{
    const previous=globalThis.fetch
    let requests=0
    globalThis.fetch=(async(input,init)=>{
      assert.equal(String(input),'https://openrouter.ai/api/v1/chat/completions')
      requests++
      const body=JSON.parse(String(init?.body)) as {model:string}
      const delta=requests===1?{tool_calls:[{index:0,id:'fixture-source-read',type:'function',function:{name:'read_file',arguments:JSON.stringify({path:target})}}]}:
        {content:'The fixture is unchanged. No program was executed or output file created.'}
      return new Response(`data: ${JSON.stringify({model:body.model,choices:[{delta,finish_reason:requests===1?'tool_calls':'stop'}],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15,cost:0}})}\n\ndata: [DONE]\n\n`,
        {headers:{'content-type':'text/event-stream'}})
    }) as typeof fetch
    t.after(()=>{globalThis.fetch=previous})
    const result=await runCliChatTask({task:scenario.task,projectRoot:root,model:'glm-5.3-flash',outputFormat:'json'})
    assert.equal(readFileSync(target,'utf8'),'unchanged\n')
    if(scenario.blocked){
      assert.notEqual(result.exitCode,0)
      assert.notEqual(result.payload['terminal_outcome'],'NO_CHANGE_REQUIRED')
      assert.equal(result.payload['reason_code'],'unsupported_operation')
      assert.equal(requests,0,'the actual scope check must settle before inference')
    }else{
      assert.equal(result.exitCode,0)
      assert.equal(result.payload['terminal_outcome'],'NO_CHANGE_REQUIRED')
      assert.equal(requests,2)
    }
  })
  test('Plan and status presentations retain their read-only semantics',()=>{
    const input={taskText:cases[0]!.task,operation:'READ_ONLY' as const,executionProfile:'chat'}
    assert.ok(readOnlyExecutionConflictReport(input))
    assert.equal(readOnlyExecutionConflictReport({...input,executionProfile:'plan'}),null)
    assert.equal(readOnlyExecutionConflictReport({...input,presentationOnly:true}),null)
    assert.equal(readOnlyExecutionConflictReport({...input,operation:'HYBRID'}),null)
  })
}
