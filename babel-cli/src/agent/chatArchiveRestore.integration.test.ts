import assert from 'node:assert/strict'
import test from 'node:test'
import {spawnSync} from 'node:child_process'
import {mkdirSync,writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {isSyntheticProviderFixtureReady,prepareSyntheticProviderFixture,removeSyntheticProviderFixture,summarizeSyntheticProviderOutput} from '../testinfra/synthetic-provider-fixture.mjs'

if(!isSyntheticProviderFixtureReady()){
  test('archive restore and REPL fallback run with isolated synthetic credentials',t=>{
    const fixture=prepareSyntheticProviderFixture()
    try {
      const child=spawnSync(process.execPath,['--import',new URL('../testinfra/synthetic-provider-fixture.mjs',import.meta.url).href,'--import',import.meta.resolve('tsx'),'--import',new URL('../testinfra/register-no-ambient-inference.mjs',import.meta.url).href,'--test','--test-reporter=tap','--test-concurrency=1',fileURLToPath(import.meta.url),fileURLToPath(new URL('../interactive/chatSessionResume.identity.test.ts',import.meta.url))],{cwd:fixture.cwd,env:fixture.env,encoding:'utf8',windowsHide:true,timeout:45000})
      const output=String(child.stdout)+String(child.stderr)
      t.diagnostic(summarizeSyntheticProviderOutput(output,child.status))
      if(child.status!==0)t.diagnostic(JSON.stringify({archiveAccepted:output.includes('CANONICAL_ARCHIVE_CONTEXT_ACCEPTED'),legacyBroken:output.includes('LEGACY_TRANSCRIPT_CONTEXT_LOST'),candidateMarkerLost:output.includes('LEGACY_CANDIDATE_MARKER_LOST'),legacyFixtureFailed:/not ok \d+ - genuine transcript-only restore/.test(output),identitySuiteFailed:/not ok \d+ - D04 resume seam identity/.test(output),replGuardFailed:/not ok \d+ - canonical display archive cannot enter/.test(output)}))
      assert.equal(child.error===undefined,true,'archive restore fixture must settle before watchdog')
      assert.equal(child.status,0,'isolated archive restore regressions must pass')
    }finally{removeSyntheticProviderFixture(fixture.root)}
  })
}else{
  const {ChatEngine}=await import('./chatEngine.js')
  const {chatSessionDir}=await import('../cli/runsLayout.js')
  const {createSessionEventLog,recordUserSubmitted,flushSessionEventLogStrict}=await import('./sessionEvents.js')
  function seed(id:string,records:unknown[]){
    const directory=chatSessionDir(id)
    mkdirSync(directory,{recursive:true})
    const initial=new ChatEngine({model:'deepseek-v4-flash-openrouter',task:'Restore fixture',projectRoot:process.cwd(),runId:id})
    initial.closeAdmissionStore()
    writeFileSync(join(directory,'transcript.jsonl'),records.map(record=>JSON.stringify(record)).join('\n')+'\n')
    const events=createSessionEventLog(id)
    recordUserSubmitted(events,{turn_id:'restore-turn',task:'Restore fixture',model:'fixture-model',provider:'fixture-provider',projectRoot:process.cwd()})
    flushSessionEventLogStrict(directory,events)
  }
  test('static restore rejects canonical display records without their event log',async()=>{
    seed('orphan-archive',[{role:'assistant',content:'Unaccepted archive candidate',archive_source:'thread_events',archive_kind:'model_candidate',source_event_id:'orphan-event'}])
    const admitted:InstanceType<typeof ChatEngine>[]=[]
    try {await assert.rejects(async()=>{admitted.push(await ChatEngine.restore('orphan-archive',{model:'deepseek-v4-flash-openrouter',task:'Resume',projectRoot:process.cwd()}))},/Canonical archive history is unavailable/,'CANONICAL_ARCHIVE_CONTEXT_ACCEPTED')}
    finally {for(const engine of admitted)engine.closeAdmissionStore()}
  })
  test('genuine transcript-only restore remains supported without inventing event identity',async()=>{
    seed('legacy-archive',[{role:'system',content:'Historical controller prompt'},{role:'user',content:'Legacy question'},{role:'assistant',content:'Legacy answer'}])
    const engine=await ChatEngine.restore('legacy-archive',{model:'deepseek-v4-flash-openrouter',task:'Resume',projectRoot:process.cwd()})
    try {
      assert.ok(engine.getConversation().some(message=>message.content==='Legacy question'),'LEGACY_TRANSCRIPT_CONTEXT_LOST')
      assert.ok(engine.getConversation().every(message=>!('source_event_id' in message)))
    }finally{engine.closeAdmissionStore()}
  })
  test('legacy restore preserves an uncommitted candidate marker so the existing prompt guard denies it',async()=>{
    seed('legacy-candidate',[{role:'user',content:'Legacy question'},{role:'assistant',content:'Uncommitted model candidate',compactionCandidate:true}])
    const engine=await ChatEngine.restore('legacy-candidate',{model:'deepseek-v4-flash-openrouter',task:'Resume',projectRoot:process.cwd()})
    try {
      const {buildChatTurnPrompt}=await import('./chatToolDefinitions.js')
      assert.throws(()=>buildChatTurnPrompt({conversation:engine.getConversation(),task:'Follow up'}),/Uncommitted compaction candidate/,'LEGACY_CANDIDATE_MARKER_LOST')
    }finally{engine.closeAdmissionStore()}
  })
}
