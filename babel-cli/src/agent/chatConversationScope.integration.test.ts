import assert from 'node:assert/strict'
import test from 'node:test'
import {spawn} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {isSyntheticProviderFixtureReady,prepareSyntheticProviderFixture,removeSyntheticProviderFixture,summarizeSyntheticProviderOutput} from '../testinfra/synthetic-provider-fixture.mjs'

if(!isSyntheticProviderFixtureReady()){
  test('project-free engine runs inside a synthetic-only subprocess',async t=>{
    const fixture=prepareSyntheticProviderFixture()
    try{
      const child=spawn(process.execPath,['--import',new URL('../testinfra/synthetic-provider-fixture.mjs',import.meta.url).href,'--import',import.meta.resolve('tsx'),'--test-reporter=tap','--test',fileURLToPath(import.meta.url)],{cwd:fixture.cwd,env:fixture.env,windowsHide:true,stdio:['ignore','pipe','pipe']})
      let output=''
      child.stdout.on('data',chunk=>{output+=String(chunk)})
      child.stderr.on('data',chunk=>{output+=String(chunk)})
      const code=await new Promise<number>(resolve=>{child.once('error',()=>resolve(1));child.once('close',value=>resolve(value??1))})
      t.diagnostic(summarizeSyntheticProviderOutput(output,code))
      if(code!==0)t.diagnostic(JSON.stringify({projectRequired:output.includes('PROJECT_REQUIRED'),invalidRoot:output.includes('The "path" argument'),implicitRoot:output.includes('explicit conversation'),scopeConflict:output.includes('Conflicting project')}))
      if(code!==0)t.diagnostic(JSON.stringify({frames:[...output.matchAll(/src[\\/]agent[\\/](chat\w+\.ts):(\d+):(\d+)/g)].slice(0,12).map(match=>({file:match[1],line:Number(match[2])}))}))
      if(code!==0)t.diagnostic(JSON.stringify({coreFrames:[...output.matchAll(/src[\\/]interactive[\\/]execution[\\/](chat\w+\.ts):(\d+):(\d+)/g)].slice(0,10).map(match=>({file:match[1],line:Number(match[2])})),coreFailure:output.includes('CORE_TURN_FAILED'),missingAnswer:output.includes('CORE_ANSWER_MISMATCH'),missingCalls:output.includes('CORE_CALL_COUNT')}))
      if(code!==0)t.diagnostic(JSON.stringify({unknownOption:output.includes('unknown option'),completionRetry:output.includes('CONVERSATION_COMPLETION_RETRY'),creativeBlocked:output.includes('CREATIVE_CONVERSATION_PROJECT_BLOCK')}))
      assert.equal(code,0,'isolated conversation-scope regressions must pass')
    }finally{removeSyntheticProviderFixture(fixture.root)}
  })
}else{
  const {ChatEngine}=await import('./chatEngine.js')
  const {mkdirSync,writeFileSync,readFileSync}=await import('node:fs')
  const {join}=await import('node:path')
  const {resolve,relative,isAbsolute,sep}=await import('node:path')
  const fs=(await import('node:fs')).default
  const {syncBuiltinESMExports}=await import('node:module')
  test('actual ChatEngine greets without project intake, tools, Docker or cwd authority',async t=>{
    mkdirSync(join(process.cwd(),'AGENTS.md')) // Ambient project instructions are deliberately not readable.
    const workspace=process.cwd(),restores:Array<()=>void>=[]
    const guard=(value:unknown)=>{
      if(typeof value!=='string')return
      const relation=relative(workspace,resolve(value))
      if(relation!=='..'&&!relation.startsWith(`..${sep}`)&&!isAbsolute(relation))throw new Error('CONVERSATION_PROJECT_INTAKE_DENIED')
    }
    for(const api of [fs,fs.promises])for(const name of ['readFile','readdir','open','stat','lstat','realpath','access','readFileSync','readdirSync','openSync','statSync','lstatSync','realpathSync','accessSync','existsSync']){
      const record=api as unknown as Record<string,(...args:unknown[])=>unknown>,original=record[name]
      if(typeof original!=='function')continue
      const wrapped=(...args:unknown[])=>{guard(args[0]);return original(...args)}
      if(name==='realpathSync')Object.assign(wrapped,{native:(...args:unknown[])=>{guard(args[0]);return (original as unknown as {native:(...args:unknown[])=>unknown}).native(...args)}})
      record[name]=wrapped;restores.push(()=>{record[name]=original})
    }
    syncBuiltinESMExports()
    t.after(()=>{for(const restore of restores)restore();syncBuiltinESMExports()})
    process.env['BABEL_LIVE']='1'
    process.env['BABEL_HEADLESS']='1'
    process.env['BABEL_EXECUTION_PROFILE']='safe_repo'
    const priorFetch=globalThis.fetch
    t.after(()=>{globalThis.fetch=priorFetch})
    let calls=0
    globalThis.fetch=(async(input,init)=>{
      assert.equal(String(input),'https://openrouter.ai/api/v1/chat/completions')
      const body=JSON.parse(String(init?.body))
      assert.ok(!body.tools||body.tools.length===0)
      assert.notEqual(body.tool_choice,'required')
      calls++
      assert.ok(calls<=1,'greeting needs no auxiliary or retry inference')
      return new Response(`data: ${JSON.stringify({model:'z-ai/glm-5.3-flash',choices:[{delta:{content:'Hello from the fixture.'},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:5}})}\n\ndata: [DONE]\n\n`,{headers:{'content-type':'text/event-stream'}})
    }) as typeof fetch
    const engine=new ChatEngine({task:'Hello',projectRoot:null,executionScope:{kind:'conversation'},model:'glm-5.3-flash'})
    try{
      let answer=''
      for await(const event of engine.submitMessageStream('Hello','explain')){
        if(event.type==='done')answer=event.answer
      }
      assert.ok(answer.includes('Hello from the fixture.'))
      assert.equal(calls,1)
      assert.equal(engine.getTaskContract()?.allowed_effects.length,0)
      const {persistTranscriptToDisk}=await import('./chatEngineObservability.js')
      const {chatSessionDir}=await import('../cli/runsLayout.js')
      const {openResumedChatEngine}=await import('../interactive/execution/chatResumeHeadless.js')
      await persistTranscriptToDisk(chatSessionDir(engine.getEngineRunId()),engine.getConversation())
      const archivePath=join(chatSessionDir(engine.getEngineRunId()),'transcript.jsonl')
      writeFileSync(archivePath,JSON.stringify({role:'user',content:'Retained transcript-only question',archive_source:'legacy_transcript'})+'\n'+readFileSync(archivePath,'utf8'))
      engine.closeAdmissionStore()
      const restored=await openResumedChatEngine(engine.getEngineRunId(),{task:'Hello again',projectRoot:null,executionScope:{kind:'conversation'},model:'glm-5.3-flash'})
      try{
        assert.ok(restored.getConversation().some(message=>message.content.includes('Hello from the fixture.')))
        assert.equal(restored.getConversation().filter(message=>message.content==='Hello from the fixture.').length,1,'restore must use provider context instead of duplicating the archive terminal response')
        assert.ok(restored.getConversation().every(message=>!('archive_source' in message)),'archive presentation fields must not enter model context')
        assert.ok(restored.getConversation().some(message=>message.content==='Retained transcript-only question'),'canonical adoption must retain the legacy loop context until compaction')
        assert.equal(restored.getTaskContract()?.allowed_effects.length,0)
      }finally{restored.closeAdmissionStore()}
    }finally{engine.closeAdmissionStore()}
  })
  for(const profile of ['native','legacy','text'])test(`${profile} unsolicited project tools are denied without another inference request`,async t=>{
    const target=join(process.cwd(),'forbidden.txt');writeFileSync(target,'unchanged fixture bytes')
    const priorFetch=globalThis.fetch,priorProfile=process.env['BABEL_TOOL_PROFILE'],priorNative=process.env['BABEL_NATIVE_TOOLS']
    process.env['BABEL_TOOL_PROFILE']=profile
    if(profile==='native')delete process.env['BABEL_NATIVE_TOOLS'];else process.env['BABEL_NATIVE_TOOLS']='disabled'
    t.after(()=>{globalThis.fetch=priorFetch;if(priorProfile===undefined)delete process.env['BABEL_TOOL_PROFILE'];else process.env['BABEL_TOOL_PROFILE']=priorProfile;if(priorNative===undefined)delete process.env['BABEL_NATIVE_TOOLS'];else process.env['BABEL_NATIVE_TOOLS']=priorNative})
    let calls=0
    const actions=[{type:'read_file',path:target},{type:'write_file',path:target,content:'forbidden mutation'},{type:'run_command',command:'echo must-not-execute'}]
    globalThis.fetch=(async(_input,init)=>{
      calls++;assert.ok(calls<=1,'denied tools must pause rather than retry inference')
      const delta=profile==='native'?{tool_calls:actions.map((action,index)=>({index,id:`unsolicited-${index}`,type:'function',function:{name:action.type,arguments:JSON.stringify(action)}}))}:{content:profile==='text'?`[TOOL:read_file]\npath: ${target}`:JSON.stringify({type:'tool_calls',actions})}
      if(!JSON.parse(String(init?.body)).stream)return Response.json({model:'z-ai/glm-5.3-flash',choices:[{message:delta,finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:5}})
      return new Response(`data: ${JSON.stringify({model:'z-ai/glm-5.3-flash',choices:[{delta,finish_reason:profile==='native'?'tool_calls':'stop'}],usage:{prompt_tokens:10,completion_tokens:5}})}\n\ndata: [DONE]\n\n`,{headers:{'content-type':'text/event-stream'}})
    }) as typeof fetch
    const engine=new ChatEngine({task:'Hello',projectRoot:null,executionScope:{kind:'conversation'},model:'glm-5.3-flash'})
    try{
      let done:Extract<import('./chatEngineContracts.js').ChatEvent,{type:'done'}>|undefined
      for await(const event of engine.submitMessageStream('Hello','explain'))if(event.type==='done')done=event
      assert.ok(done)
      assert.ok(done.answer.includes('PROJECT_REQUIRED'))
      assert.notEqual(done.outcome,'VERIFIED_COMPLETE')
      assert.equal(done.status,'blocked')
      assert.equal(calls,1)
      assert.equal(readFileSync(target,'utf8'),'unchanged fixture bytes')
    }finally{engine.closeAdmissionStore()}
  })
  test('headless ChatCore uses the same conversation scope without target resolution',async t=>{
    const {runCliChatTask}=await import('../interactive/execution/chatCore.js')
    const priorFetch=globalThis.fetch
    t.after(()=>{globalThis.fetch=priorFetch})
    let calls=0
    globalThis.fetch=(async(_input,init)=>{
      calls++;assert.ok(calls<=2)
      const body=JSON.parse(String(init?.body));assert.ok(!body.tools||body.tools.length===0)
      if(calls===2)assert.ok(body.messages.some((message:{role:string;content:string})=>message.role==='assistant'&&message.content.includes('Hello through ChatCore.')),'CORE_RESTORE_MISSING_ASSISTANT')
      return new Response(`data: ${JSON.stringify({model:'z-ai/glm-5.3-flash',choices:[{delta:{content:'Hello through ChatCore.'},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:5}})}\n\ndata: [DONE]\n\n`,{headers:{'content-type':'text/event-stream'}})
    }) as typeof fetch
    const result=await runCliChatTask({task:'Hello',projectRoot:null,executionScope:{kind:'conversation'},model:'glm-5.3-flash',outputFormat:'stream-json'})
    assert.equal(result.exitCode,0,'CORE_TURN_FAILED')
    assert.equal((result.payload['answer'] as {answer:string}).answer,'Hello through ChatCore.','CORE_ANSWER_MISMATCH')
    assert.equal(result.payload['project_root'],null)
    assert.equal(calls,1,'CORE_CALL_COUNT')
    const sessionId=result.payload['session_id']
    assert.equal(typeof sessionId,'string')
    const resumed=await runCliChatTask({task:'Hello again',projectRoot:null,executionScope:{kind:'conversation'},model:'glm-5.3-flash',outputFormat:'stream-json',sessionId:sessionId as string})
    assert.equal(resumed.exitCode,0,'CORE_RESUME_FAILED')
    assert.equal(resumed.payload['session_id'],sessionId)
    assert.equal(calls,2)
  })
  test('ordinary creative conversation does not require a project',async t=>{
    const priorFetch=globalThis.fetch
    t.after(()=>{globalThis.fetch=priorFetch})
    let calls=0
    globalThis.fetch=(async()=>{
      calls++;assert.equal(calls,1,'CREATIVE_CONVERSATION_RETRY')
      return new Response(`data: ${JSON.stringify({model:'z-ai/glm-5.3-flash',choices:[{delta:{content:'Rain taps gently on the window.'},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:5}})}\n\ndata: [DONE]\n\n`,{headers:{'content-type':'text/event-stream'}})
    }) as typeof fetch
    const engine=new ChatEngine({task:'Write a short poem about rain',projectRoot:null,executionScope:{kind:'conversation'},model:'glm-5.3-flash'})
    try{
      const result=await engine.submitMessage('Write a short poem about rain',{})
      assert.equal(result.status,'completed','CREATIVE_CONVERSATION_PROJECT_BLOCK')
      assert.ok(result.answer.includes('Rain taps gently'))
      assert.notEqual(result.outcome,'VERIFIED_COMPLETE')
      assert.equal(calls,1)
    }finally{engine.closeAdmissionStore()}
  })
  test('conversation change request pauses after the first explanation without project completion retries',async t=>{
    const priorFetch=globalThis.fetch
    t.after(()=>{globalThis.fetch=priorFetch})
    let calls=0
    globalThis.fetch=(async()=>{
      calls++;assert.equal(calls,1,'CONVERSATION_COMPLETION_RETRY')
      return new Response(`data: ${JSON.stringify({model:'z-ai/glm-5.3-flash',choices:[{delta:{content:'Please select a project first.'},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:5}})}\n\ndata: [DONE]\n\n`,{headers:{'content-type':'text/event-stream'}})
    }) as typeof fetch
    const engine=new ChatEngine({task:'Create a file in the project',operation:'CHANGE',projectRoot:null,executionScope:{kind:'conversation'},model:'glm-5.3-flash'})
    try{
      let done:Extract<import('./chatEngineContracts.js').ChatEvent,{type:'done'}>|undefined
      for await(const event of engine.submitMessageStream('Create a file in the project','execute'))if(event.type==='done')done=event
      assert.ok(done,'CONVERSATION_COMPLETION_MISSING')
      assert.equal(calls,1,'CONVERSATION_COMPLETION_RETRY')
      assert.equal(done.status,'blocked')
      assert.equal(done.reason_code,'permission_denied')
      assert.ok(done.answer.includes('PROJECT_REQUIRED'))
      assert.equal(engine.getTaskContract()?.allowed_effects.length,0)
    }finally{engine.closeAdmissionStore()}
  })
  test('legacy project protocol cannot manufacture a conversation binding',async t=>{
    const {prepareHeadlessTurn}=await import('../interactive/execution/chatTransport.js')
    const prior=process.env['BABEL_PROTOCOL_CLIENT']
    process.env['BABEL_PROTOCOL_CLIENT']='1'
    t.after(()=>{if(prior===undefined)delete process.env['BABEL_PROTOCOL_CLIENT'];else process.env['BABEL_PROTOCOL_CLIENT']=prior})
    const engine=new ChatEngine({task:'Hello',projectRoot:null,executionScope:{kind:'conversation'},model:'glm-5.3-flash'})
    try{await assert.rejects(prepareHeadlessTurn(engine,'Hello'),/CONVERSATION_PROTOCOL_UNSUPPORTED/)}
    finally{engine.closeAdmissionStore()}
  })
  test('run command admits an explicit conversation without ambient target or Docker',async t=>{
    const {Command}=await import('commander')
    const {registerWorkflowCommands}=await import('../commands/workflowCommands.js')
    const priorFetch=globalThis.fetch,priorRoot=process.env['BABEL_PROJECT_ROOT'],priorExit=process.exitCode
    process.env['BABEL_PROJECT_ROOT']=join(process.cwd(),'ambient-must-not-inspect')
    let calls=0
    t.after(()=>{globalThis.fetch=priorFetch;process.exitCode=priorExit;if(priorRoot===undefined)delete process.env['BABEL_PROJECT_ROOT'];else process.env['BABEL_PROJECT_ROOT']=priorRoot})
    globalThis.fetch=(async(_input,init)=>{
      calls++;assert.equal(calls,1)
      assert.equal(process.env['BABEL_PROJECT_ROOT'],undefined)
      assert.equal(process.env['BABEL_ALLOWED_ROOTS'],undefined)
      const body=JSON.parse(String(init?.body));assert.ok(!body.tools||body.tools.length===0)
      return new Response(`data: ${JSON.stringify({model:'z-ai/glm-5.3-flash',choices:[{delta:{content:'Hello through run command.'},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:5}})}\n\ndata: [DONE]\n\n`,{headers:{'content-type':'text/event-stream'}})
    }) as typeof fetch
    const program=new Command().exitOverride();registerWorkflowCommands(program)
    await program.parseAsync(['run','--mode','chat','--execution-scope','conversation','--model','glm-5.3-flash','--output-format','json','--','Hello'],{from:'user'})
    assert.equal(calls,1)
    assert.equal(process.exitCode??0,0)
    assert.equal(process.env['BABEL_PROJECT_ROOT'],join(process.cwd(),'ambient-must-not-inspect'))
  })
}
