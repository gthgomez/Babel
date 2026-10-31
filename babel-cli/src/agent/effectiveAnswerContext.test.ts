import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync, execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { prepareSyntheticProviderFixture, removeSyntheticProviderFixture } from '../testinfra/synthetic-provider-fixture.mjs'
import type { ToolStreamEvent } from '../runners/base.js'

const policy = 'CURRENT_ANSWER_POLICY: report only supported facts and respect user format.'
const clarification = 'Continue inspecting. LATER_CLARIFICATION: include only invalid-row behavior. Return only a JSON object.'

async function runFixture(scenario: string): Promise<void> {
  const { ChatEngine } = await import('./chatEngine.js')
  const { DeepInfraApiRunner } = await import('../runners/deepInfraApi.js')
  const root = process.env['BABEL_PROJECT_ROOT']!
  const before = readFileSync(join(root, 'module-0.txt'), 'utf8')
  process.env['BABEL_COMPACTION'] = 'off'
  process.env['BABEL_MEMORY_WRITEBACK'] = '0'
  if (scenario.startsWith('terminal')) {
    const currentRequest = scenario==='terminal-plain-format'
      ? 'Continue inspecting. LATER_CLARIFICATION: Réponds uniquement: EN_ATTENTE.' : clarification
    process.env['BABEL_NATIVE_TOOLS'] = 'enabled'
    process.env['BABEL_CHAT_TASK_CLASS'] = 'quick_inspect'
    let reads = 0
    let initial = true
    const requests: Array<{messages: unknown; system: string | undefined}> = []
    const synthesis: Array<{prompt: string; system: string | undefined}> = []
    let releaseSynthesis: ((answer:string)=>void) | undefined
    let synthesisStarted: (()=>void) | undefined
    const started = new Promise<void>(resolve=>{synthesisStarted=resolve})
    class Runner extends DeepInfraApiRunner {
      constructor(){super('fixture-model','UNUSED_FIXTURE_KEY',{}, {explicitCredential:'',env:{}})}
      override async *executeWithToolsStream(messages: unknown, _tools: unknown, system?: string): AsyncGenerator<ToolStreamEvent, void, undefined> {
        requests.push({messages, system})
        if (initial) {
          initial = false
          yield {type: 'text_delta', text: 'Ready to inspect the requested files.'}
          yield {type: 'done', finishReason: 'stop'}
          return
        }
        assert.ok(reads < 12, 'bounded native inspection must reach answer synthesis')
        reads++
        yield {type:'tool_use', id:`read-${reads}`, name:'read_range', input:{file_path:'module-0.txt',start_line:1,end_line:1}}
        yield {type:'done', finishReason:'tool_calls'}
      }
      override async executeRaw(prompt: string, _callbacks?: unknown, system?: string) {
        synthesis.push({prompt, system})
        if(scenario==='terminal-owner') {
          synthesisStarted!()
          return await new Promise<string>(resolve=>{releaseSynthesis=resolve})
        }
        return scenario==='terminal-plain-format' ? 'EN_ATTENTE' : scenario === 'terminal-evidence'
          ? 'I ran npm test and tests passed.'
          : '```json\n{"invalidRows":"rejected"}\n```'
      }
    }
    const runner = new Runner()
    const engine = new ChatEngine({ model: 'deepseek-v4-flash-openrouter',task:'Inspect the repository.', projectRoot:root, operation:'READ_ONLY',
      systemContext:policy, providerRunner:runner, maxTurns:20})
    const internal = engine as unknown as {
      synthesisRunner: unknown
      synthesizeAnswer:(observations:string,callbacks:object,currentRequest:string)=>Promise<string>
      lastVerifierReceipt:unknown
    }
    internal.synthesisRunner = runner
    if(scenario==='terminal-owner') {
      const pending=internal.synthesizeAnswer('A has no test evidence.',{},'Inspect task A.')
      await started
      await engine.submitMessage('Inspect the repository.', {})
      let receiptWrites=0
      const {bindChatVerifierReceipt}=await import('../evidence/chatRevisionBinding.js')
      const receipt=await bindChatVerifierReceipt({projectRoot:root,command:'npm test',exit_code:1,
        summary:'Non-authoritative failure fixture; no verifier executed.',mutationPaths:['module-0.txt'],structured:null})
      assert.equal(receipt.authority,false)
      writeFileSync(join(root,'module-0.txt'),before+'host-owned currency control\n')
      internal.lastVerifierReceipt=new Proxy(receipt,{set(target,key,value){
        receiptWrites++
        Reflect.set(target,key,value)
        return true
      }})
      releaseSynthesis!('No tests were run.')
      await pending
      assert.equal(receiptWrites,0,'retired synthesis must not refresh the successor receipt')
      return
    }
    await engine.submitMessage('Inspect the repository.', {})
    assert.ok(requests.length, 'native fixture must dispatch through its controlled runner')
    const events = []
    for await (const event of engine.submitMessageStream(currentRequest, 'explain', {continueTask:true})) events.push(event)
    assert.equal(synthesis.length, 1, 'must exercise real bounded terminal synthesis')
    assert.ok(requests.some(request=>JSON.stringify(request.messages).includes('LATER_CLARIFICATION')))
    assert.ok(synthesis[0]!.prompt.includes('LATER_CLARIFICATION'), 'terminal request must retain later clarification')
    assert.ok(synthesis[0]!.system?.includes('CURRENT_ANSWER_POLICY'), 'terminal dispatch must carry current policy')
    assert.ok(!synthesis[0]!.prompt.includes('Structure your answer as follows:'), 'no conflicting mandatory answer template')
    const terminal = events.at(-1)
    if (scenario === 'terminal-evidence') {
      assert.equal(terminal?.type, 'failed', 'unsupported synthesis claim cannot become a successful terminal')
      assert.match((terminal as {error?:string})?.error ?? '', /RESPONSE_EVIDENCE_INVALID/)
    } else {
      assert.equal(terminal?.type, 'done')
      assert.equal((terminal as {answer?:string})?.answer, scenario==='terminal-plain-format'?'EN_ATTENTE':'{"invalidRows":"rejected"}')
    }
    assert.equal(readFileSync(join(root,'module-0.txt'),'utf8'),before)
    return
  }

  process.env['BABEL_NATIVE_TOOLS'] = 'disabled'
  process.env['BABEL_TOOL_PROFILE'] = 'text'
  const scope = scenario.replace('repair-', '')
  const captures: Array<{prompt:string;system:string | undefined}> = []
  class Runner extends DeepInfraApiRunner {
    constructor(){super('fixture-model','UNUSED_FIXTURE_KEY',{}, {explicitCredential:'',env:{}})}
    override async executeRaw(prompt: string, _callbacks?: unknown, system?: string) {
      captures.push({prompt,system})
      if(captures.length===1)return '[TOOL:unknown_tool]\npath: module-0.txt'
      throw new Error('CONTROLLED_STOP_AFTER_REPAIR_CAPTURE')
    }
    override async *executeRawStream(prompt:string, system?:string) {yield await this.executeRaw(prompt,undefined,system)}
  }
  const runner = new Runner()
  const engine = new ChatEngine({ model: 'deepseek-v4-flash-openrouter',task:scope==='change'?'Create a brief.txt file.':'Inspect the files.',
    projectRoot:scope==='conversation'?null:root,
    ...(scope==='conversation'?{executionScope:{kind:'conversation' as const}}:{}),
    operation:scope==='change'?'CHANGE':'READ_ONLY',providerRunner:runner,maxTurns:4,
    ...(scope==='verifier'?{requiredVerifierCommands:['npm test']}:{}),
  })
  await engine.submitMessage(scope==='change'?'Create a brief.txt file.':'Inspect the files.', {})
  assert.ok(captures.length, 'text fixture must dispatch through its controlled runner')
  assert.equal(captures.length,2, 'malformed call must reach one repair request')
  const feedback = captures[1]!.prompt.split('## Your last reply was not a valid tool call')[1] ?? ''
  assert.ok(feedback, 'actual second provider request must contain repair guidance')
  const writable=scope==='change'
  assert.equal(feedback.includes('write_file'),writable,'repair must reflect effective write capability')
  assert.equal(feedback.includes('run_command'),writable||scope==='verifier','repair must reflect effective command capability')
  assert.equal(feedback.includes('read_file'),scope!=='conversation','conversation repair must not advertise project tools')
  if(scope==='verifier')assert.match(feedback,/only these exact foreground commands: `npm test`/)
  assert.equal(readFileSync(join(root,'module-0.txt'),'utf8'),before)
}

if(process.argv[2]==='--fixture-child') {
  await runFixture(process.argv[3]!)
} else {
  for(const scenario of ['terminal-format','terminal-plain-format','terminal-evidence','terminal-owner','repair-read-only','repair-conversation','repair-change','repair-verifier']) {
    test(`effective answer context: ${scenario}`,()=>{
      const fixture=prepareSyntheticProviderFixture()
      try {
        for(let i=0;i<12;i++)writeFileSync(join(fixture.cwd,`module-${i}.txt`),`invalid rows rejected; module ${i}\n`)
        execFileSync('git',['add','--','.'],{cwd:fixture.cwd,env:fixture.env})
        execFileSync('git',['commit','-qm','source-owned inspection baseline'],{cwd:fixture.cwd,env:fixture.env})
        const child=spawnSync(process.execPath,[
          '--import',new URL('../testinfra/synthetic-provider-fixture.mjs',import.meta.url).href,
          '--import',import.meta.resolve('tsx'),fileURLToPath(import.meta.url),'--fixture-child',scenario,
        ],{cwd:fixture.cwd,env:fixture.env,encoding:'utf8',timeout:120000,windowsHide:true})
        assert.ifError(child.error)
        // Diagnostics contain only test assertions from a synthetic, no-wire child.
        assert.equal(child.status,0,child.stderr)
      } finally {removeSyntheticProviderFixture(fixture.root)}
    })
  }
}
