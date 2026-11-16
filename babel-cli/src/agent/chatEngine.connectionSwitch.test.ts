import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { isSyntheticProviderFixtureReady, runSyntheticProviderTestFile } from '../testinfra/synthetic-provider-fixture.mjs'

if (!isSyntheticProviderFixtureReady()) {
  test('connection switching uses an isolated synthetic profile', {timeout:60000}, async t => {
    const result=await runSyntheticProviderTestFile(import.meta.url);t.diagnostic(JSON.stringify(result))
    assert.equal(result.exitCode,0);assert.ok(result.passed>0)
  })
} else {
const { ChatEngine } = await import('./chatEngine.js')
const { updateUserSettings } = await import('../config/userSettings.js')
const { resolveConnectionModelPolicy } = await import('../config/connectionModelPolicy.js')
const { resolveChatDeliberationRunner } = await import('./chatEngineProviderRuntime.js')

test('a settled chat switches its exact gateway and model while retaining conversation and execution policy', async () => {
  const oldFetch = globalThis.fetch; const oldKey = process.env['COMMAND_CODE_API_KEY']
  process.env['COMMAND_CODE_API_KEY'] = 'synthetic-command-code-key'
  updateUserSettings({ connections: {
    router: { id: 'router', provider: 'openrouter', model: 'vendor/router-model' },
    command: { id: 'command', provider: 'command-code', model: 'vendor/command-model' },
  }, defaults: { connection: 'router' } })
  const policy = { profile: 'host_native', source: 'explicit', expectedBoundary: 'host' } as const
  const engine = new ChatEngine({ task: 'Inspect fixture', projectRoot: process.cwd(),
    model: 'connection/router/vendor/router-model', executionPolicy: policy })
  const seen: Array<{url:string;model:string}> = []
  try {
    engine.replaceConversation([{role:'user',content:'Retained question'}, {role:'assistant',content:'Retained answer'}])
    const id = engine.getEngineRunId()
    globalThis.fetch = async (url, init) => {
      const model = JSON.parse(String(init?.body)).model as string
      seen.push({url:String(url),model})
      return new Response(JSON.stringify({model,choices:[{message:{content:'fixture'},finish_reason:'stop'}]}))
    }
    const runner = () => (engine as unknown as { resolveDeliberationRunner: () => {executeRaw:(text:string)=>Promise<string>} }).resolveDeliberationRunner()
    await runner().executeRaw('first')
    engine.selectProviderModel('connection/command/vendor/command-model')
    await runner().executeRaw('second')
    assert.deepEqual(seen.map(({model})=>model), ['vendor/router-model','vendor/command-model'])
    assert.match(seen[0]!.url,/openrouter\.ai/); assert.match(seen[1]!.url,/commandcode\.ai/)
    assert.equal(engine.getEngineRunId(), id)
    assert.deepEqual(engine.getExecutionPolicy(), policy)
    assert.deepEqual(engine.getConversation().map(message=>message.content), ['Retained question','Retained answer'])
    assert.equal(engine.getProviderSelectionStatus().provider, 'command-code')
    assert.throws(()=>engine.selectProviderModel('connection/missing/vendor/model'))
    assert.equal(engine.getProviderSelectionStatus().provider, 'command-code')
    Reflect.set(engine, 'physicalSettlementUnknown', true)
    assert.throws(()=>engine.selectProviderModel('connection/router/vendor/router-model'), /settled/i)
    assert.equal(engine.getProviderSelectionStatus().provider, 'command-code')
    Reflect.set(engine, 'physicalSettlementUnknown', false)
  } finally {
    engine.closeAdmissionStore(); globalThis.fetch = oldFetch
    if (oldKey === undefined) delete process.env['COMMAND_CODE_API_KEY']; else process.env['COMMAND_CODE_API_KEY'] = oldKey
  }
})

test('a switched session executes a read-only tool round under the same authority', async () => {
  const oldFetch=globalThis.fetch;const oldKey=process.env['COMMAND_CODE_API_KEY'];const oldCompaction=process.env['BABEL_COMPACTION']
  process.env['COMMAND_CODE_API_KEY']='synthetic-command-code-key';process.env['BABEL_COMPACTION']='off'
  updateUserSettings({connections:{router:{id:'router',provider:'openrouter',model:'vendor/router-model'},
    command:{id:'command',provider:'command-code',model:'vendor/command-model'}},defaults:{connection:'router'}})
  const file=join(process.cwd(),'switch-fixture.txt');writeFileSync(file,'switch-authority-marker\n')
  const policy={profile:'host_native',source:'explicit',expectedBoundary:'host'} as const
  const engine=new ChatEngine({task:'Inspect the fixture without changing files.',projectRoot:process.cwd(),
    model:'connection/router/vendor/router-model',executionPolicy:policy,maxWallMs:120000})
  const seen:Array<{url:string;model:string;messages:Array<{role:string;content?:unknown}>}>=[]
  try {
    globalThis.fetch=async (url,init)=>{
      const body=JSON.parse(String(init?.body));seen.push({url:String(url),model:body.model,messages:body.messages})
      const delta=seen.length===1?{content:'First fixture answer.'}:seen.length===2
        ?{tool_calls:[{index:0,id:'read-switch-fixture',type:'function',function:{name:'read_file',arguments:JSON.stringify({path:'switch-fixture.txt'})}}]}
        :{content:'The file contains switch-authority-marker. No files were changed.'}
      const finish=seen.length===2?'tool_calls':'stop'
      return new Response(`data: ${JSON.stringify({model:body.model,choices:[{index:0,delta,finish_reason:finish}]})}\n\ndata: [DONE]\n\n`,{headers:{'content-type':'text/event-stream'}})
    }
    const first=[];for await(const event of engine.submitMessageStream('Give a brief fixture answer.','explain'))first.push(event)
    assert.ok(first.some(event=>event.type==='done'))
    const session=engine.getEngineRunId(),authority=engine.getTaskContract()?.mode
    engine.selectProviderModel('connection/command/vendor/command-model')
    const second=[];for await(const event of engine.submitMessageStream('Read switch-fixture.txt and report its marker without changing files.','explain'))second.push(event)
    assert.ok(second.some(event=>event.type==='done'))
    assert.equal(engine.getEngineRunId(),session);assert.equal(engine.getTaskContract()?.mode,authority)
    assert.deepEqual(engine.getExecutionPolicy(),policy)
    assert.equal(readFileSync(file,'utf8'),'switch-authority-marker\n')
    assert.deepEqual(seen.map(item=>item.model),['vendor/router-model','vendor/command-model','vendor/command-model'])
    assert.match(seen[0]!.url,/openrouter\.ai/);assert.match(seen[1]!.url,/commandcode\.ai/)
    assert.ok(seen[2]!.messages.some(message=>message.role==='tool'&&String(message.content).includes('switch-authority-marker')))
    assert.ok(engine.getConversation().some(message=>String(message.content).includes('First fixture answer')))
  } finally {
    engine.closeAdmissionStore();globalThis.fetch=oldFetch
    if(oldKey===undefined)delete process.env['COMMAND_CODE_API_KEY'];else process.env['COMMAND_CODE_API_KEY']=oldKey
    if(oldCompaction===undefined)delete process.env['BABEL_COMPACTION'];else process.env['BABEL_COMPACTION']=oldCompaction
  }
})

test('same-provider same-model account changes do not reuse a runner with another credential reference', async () => {
  const oldFetch = globalThis.fetch; const oldA = process.env['FIXTURE_ROUTER_A']; const oldB = process.env['FIXTURE_ROUTER_B']
  process.env['FIXTURE_ROUTER_A'] = 'synthetic-account-a'; process.env['FIXTURE_ROUTER_B'] = 'synthetic-account-b'
  try {
    const settings = { schemaVersion:1 as const, connections:{
      a:{id:'a',provider:'openrouter' as const,model:'vendor/model',apiKeyEnvVar:'FIXTURE_ROUTER_A'},
      b:{id:'b',provider:'openrouter' as const,model:'vendor/model',apiKeyEnvVar:'FIXTURE_ROUTER_B'},
    }, defaults:{connection:'a'} }
    const a=resolveConnectionModelPolicy('connection/a/vendor/model',{settings})!
    const b=resolveConnectionModelPolicy('connection/b/vendor/model',{settings})!
    const first=resolveChatDeliberationRunner(null,a)
    const second=resolveChatDeliberationRunner(first,b)
    assert.notEqual(first,second)
    let correct=false
    globalThis.fetch=async (_url,init)=>{correct=new Headers(init?.headers).get('authorization')==='Bearer synthetic-account-b';
      return new Response(JSON.stringify({model:'vendor/model',choices:[{message:{content:'ok'},finish_reason:'stop'}]}))}
    await second.executeRaw('fixture')
    assert.equal(correct,true)
  } finally {
    globalThis.fetch=oldFetch
    if(oldA===undefined)delete process.env['FIXTURE_ROUTER_A'];else process.env['FIXTURE_ROUTER_A']=oldA
    if(oldB===undefined)delete process.env['FIXTURE_ROUTER_B'];else process.env['FIXTURE_ROUTER_B']=oldB
  }
})

test('after a 401, explicit credential repair refreshes the runner without replaying the request', async () => {
  const oldFetch=globalThis.fetch; const oldKey=process.env['FIXTURE_REPAIR_KEY']
  process.env['FIXTURE_REPAIR_KEY']='synthetic-old-key'
  updateUserSettings({connections:{repair:{id:'repair',provider:'openrouter',model:'vendor/repair-model',apiKeyEnvVar:'FIXTURE_REPAIR_KEY'}},defaults:{connection:'repair'}})
  const selector='connection/repair/vendor/repair-model'
  const engine=new ChatEngine({task:'Inspect fixture',projectRoot:process.cwd(),model:selector})
  let calls=0;let usedReplacement=false
  try {
    engine.replaceConversation([{role:'user',content:'Keep this conversation'}])
    globalThis.fetch=async (_url,init)=>{
      calls++
      if(calls===1)return new Response('{}',{status:401})
      usedReplacement=new Headers(init?.headers).get('authorization')==='Bearer synthetic-repaired-key'
      return new Response(JSON.stringify({model:'vendor/repair-model',choices:[{message:{content:'ok'},finish_reason:'stop'}]}))
    }
    const runner=()=>(engine as unknown as {resolveDeliberationRunner:()=>{executeRaw:(text:string)=>Promise<string>}}).resolveDeliberationRunner()
    await assert.rejects(runner().executeRaw('first'),/401/)
    assert.equal(calls,1)
    process.env['FIXTURE_REPAIR_KEY']='synthetic-repaired-key'
    engine.selectProviderModel(selector)
    assert.equal(calls,1,'repair must not replay a request')
    assert.equal(await runner().executeRaw('explicit retry'),'ok')
    assert.equal(calls,2);assert.equal(usedReplacement,true)
    assert.equal(engine.getConversation()[0]?.content,'Keep this conversation')
  } finally {
    engine.closeAdmissionStore();globalThis.fetch=oldFetch
    if(oldKey===undefined)delete process.env['FIXTURE_REPAIR_KEY'];else process.env['FIXTURE_REPAIR_KEY']=oldKey
  }
})
}
