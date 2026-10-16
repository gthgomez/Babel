import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtempSync,readFileSync,writeFileSync,realpathSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {persistTranscriptToDisk} from './chatEngineObservability.js'
import {commitCompaction} from './compactionCommit.js'
import {createSessionEventLog} from './sessionEvents.js'
import {appendThreadEvent,createThreadEventLog,startTurn,endTurn,recordAssistantMessage,recordAssistantToolCalls,recordToolResult,persistThreadEventLog,rebuildProviderMessagesFromEvents} from './threadEventLog.js'

async function fixture(work:(root:string)=>Promise<void>){
  const root=mkdtempSync(join(tmpdir(),'babel-archive-retention-')),canonical=realpathSync(root)
  try{await work(root)}finally{assert.equal(realpathSync(root),canonical);rmSync(root,{recursive:true,force:true})}
}
test('archive persists all canonical turns after provider context has compacted',()=>fixture(async root=>{
  const log=createThreadEventLog('archive-fixture')
  const turn=startTurn(log,{task:'Original question',model:'fixture-model',provider:'fixture-provider',projectRoot:null,executionScope:{kind:'conversation'},policyPreset:'conversation_only'})
  recordAssistantMessage(log,turn,'Original answer')
  endTurn(log,turn,'NO_CHANGE_REQUIRED','completed')
  const next=startTurn(log,{task:'Follow-up question',model:'fixture-model',provider:'fixture-provider',projectRoot:null,executionScope:{kind:'conversation'},policyPreset:'conversation_only'})
  appendThreadEvent(log,{kind:'compaction_capsule',turn_id:next,content:'A provider summary',preserved_tool_call_ids:[],ownership_generation:2})
  recordAssistantMessage(log,next,'Follow-up answer')
  endTurn(log,next,'NO_CHANGE_REQUIRED','completed')
  await persistThreadEventLog(root,log)
  await persistTranscriptToDisk(root,[{role:'assistant',content:'Compacted provider context only'}])
  const messages=readFileSync(join(root,'transcript.jsonl'),'utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line))
  assert.deepEqual(messages.map(message=>message.content),['Original question','Original answer','Follow-up question','Follow-up answer'])
  const sources=log.events.filter(event=>event.kind==='user_message'||event.kind==='assistant_message')
  assert.deepEqual(messages.map(message=>message.source_event_id),sources.map(event=>event.event_id))
  assert.deepEqual(messages.map(message=>message.turn_id),sources.map(event=>event.turn_id))
  assert.ok(messages.every(message=>message.archive_source==='thread_events'))
  assert.ok(messages.every(message=>message.route.provider==='fixture-provider'&&message.route.model==='fixture-model'))
  const provider=rebuildProviderMessagesFromEvents(log)
  assert.ok(provider.some(message=>message.content==='A provider summary'))
  assert.ok(!provider.some(message=>message.content==='Original question'))
}))

test('archive retains tool proposals and their own result identities without inventing success',()=>fixture(async root=>{
  const log=createThreadEventLog('tools-fixture')
  const turn=startTurn(log,{task:'Inspect',model:'fixture-model',provider:'fixture-provider',projectRoot:null,executionScope:{kind:'conversation'},policyPreset:'conversation_only'})
  recordAssistantToolCalls(log,turn,'',[{id:'denied-call',type:'function',function:{name:'read_file',arguments:'{"path":"example.txt"}'}},{id:'unfinished-call',type:'function',function:{name:'list_dir',arguments:'{}'}}])
  recordToolResult(log,turn,{tool_call_id:'denied-call',tool_name:'read_file',content:'PROJECT_REQUIRED',exit_code:1})
  endTurn(log,turn,'NO_CHANGE_REQUIRED','completed')
  await persistThreadEventLog(root,log)
  await persistTranscriptToDisk(root,[])
  const records=readFileSync(join(root,'transcript.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line))
  assert.equal(records.length,3)
  assert.equal(records[1].content,'')
  assert.equal(records[1].tool_calls.length,2)
  assert.equal(records[2].tool_call_id,'denied-call')
  assert.equal(records[2].exit_code,1)
  assert.equal(records.some(record=>record.role==='tool'&&record.tool_call_id==='unfinished-call'),false)
  assert.deepEqual(records.map(record=>record.item_id),log.events.filter(event=>['user_message','assistant_tool_calls','tool_result'].includes(event.kind)).map(event=>event.item_id))
}))
test('unreadable or future canonical history cannot overwrite an existing archive with partial context',()=>fixture(async root=>{
  const saved='{"role":"user","content":"Retained legacy history"}\n'
  writeFileSync(join(root,'transcript.jsonl'),saved)
  writeFileSync(join(root,'thread_events.json'),JSON.stringify({schema_version:999,events:[]}))
  await assert.rejects(persistTranscriptToDisk(root,[{role:'user',content:'Partial current context'}]),/THREAD_EVENT_LOG_INVALID|Unsupported thread event log/)
  assert.equal(readFileSync(join(root,'transcript.jsonl'),'utf8'),saved)
}))
test('sessions with no canonical log retain their legacy transcript without invented event identities',()=>fixture(async root=>{
  const legacy=[{role:'user' as const,content:'Legacy question'},{role:'assistant' as const,content:'Legacy answer'}]
  await persistTranscriptToDisk(root,legacy)
  assert.deepEqual(readFileSync(join(root,'transcript.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line)),legacy)
}))

test('archive retains the actual controller response separately from a model completion candidate',()=>fixture(async root=>{
  const log=createThreadEventLog('terminal-fixture')
  const turn=startTurn(log,{task:'Change a file',model:'fixture-model',provider:'fixture-provider',projectRoot:null,executionScope:{kind:'conversation'},policyPreset:'conversation_only'})
  recordAssistantMessage(log,turn,'Model candidate before controller admission')
  endTurn(log,turn,'BLOCKED_POLICY','blocked',undefined,{kind:'answer',content:'PROJECT_REQUIRED: choose and trust a project.'})
  await persistThreadEventLog(root,log)
  await persistTranscriptToDisk(root,[])
  const records=readFileSync(join(root,'transcript.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line))
  assert.equal(records.at(-1).content,'PROJECT_REQUIRED: choose and trust a project.')
  assert.equal(records.at(-1).archive_kind,'terminal_response')
  assert.equal(records.at(-1).source_event_id,log.events.at(-1)?.event_id)
  assert.equal(records.at(-1).terminal_outcome,'BLOCKED_POLICY')
  assert.ok(records.some(record=>record.content==='Model candidate before controller admission'))
  assert.ok(!rebuildProviderMessagesFromEvents(log).some(message=>message.content==='PROJECT_REQUIRED: choose and trust a project.'))
}))

test('first canonical turn preserves transcript-only history across repeated archive writes',()=>fixture(async root=>{
  const legacy=[{role:'user' as const,content:'Historical input'},{role:'assistant' as const,content:'Historical answer'}]
  await persistTranscriptToDisk(root,legacy)
  const log=createThreadEventLog('migrating-fixture')
  const turn=startTurn(log,{task:'New input',model:'fixture-model',provider:'fixture-provider',projectRoot:null,executionScope:{kind:'conversation'},policyPreset:'conversation_only'})
  recordAssistantMessage(log,turn,'New answer')
  await persistThreadEventLog(root,log)
  await persistTranscriptToDisk(root,[...legacy,{role:'user',content:'New input'}])
  await persistTranscriptToDisk(root,[])
  const records=readFileSync(join(root,'transcript.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line))
  assert.deepEqual(records.map(record=>record.content),['Historical input','Historical answer','New input','New answer'])
  assert.ok(records.slice(0,2).every(record=>record.archive_source==='legacy_transcript'&&!record.turn_id&&!record.source_event_id))
}))

test('production compaction context copies do not become additional archive messages',()=>fixture(async root=>{
  const log=createThreadEventLog('compaction-fixture')
  const turn=startTurn(log,{task:'Original input',model:'fixture-model',provider:'fixture-provider',projectRoot:null,executionScope:{kind:'conversation'},policyPreset:'conversation_only'})
  recordAssistantMessage(log,turn,'Original answer')
  const prior=[{role:'system' as const,content:'Controller instructions'},{role:'user' as const,content:'Original input'},{role:'assistant' as const,content:'Original answer'}]
  const beforeIds=log.events.filter(event=>event.kind==='user_message'||event.kind==='assistant_message').map(event=>event.event_id)
  const compacted=await commitCompaction({strategyMessages:prior,priorConversation:prior,strategy:'heuristic_truncation',tokensBefore:500,tokensAfter:200,operational:{task:'Original input'},threadLog:log,sessionLog:createSessionEventLog('compaction-fixture'),turnId:turn,modelId:'fixture-model',persist:()=>true})
  assert.equal(compacted.status,'committed')
  assert.ok(log.events.filter(event=>event.kind==='user_message').length>1,'must drive production retained-copy append')
  await persistThreadEventLog(root,log)
  await persistTranscriptToDisk(root,[])
  const records=readFileSync(join(root,'transcript.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line))
  assert.deepEqual(records.map(record=>record.content),['Original input','Original answer'])
  assert.deepEqual(records.map(record=>record.source_event_id),beforeIds)
  assert.ok(rebuildProviderMessagesFromEvents(log).some(message=>message.content==='Original input'))
}))

test('a missing or older canonical log cannot downgrade an existing canonical archive',()=>fixture(async root=>{
  const log=createThreadEventLog('no-downgrade-fixture')
  const turn=startTurn(log,{task:'Retained input',model:'fixture-model',provider:'fixture-provider',projectRoot:null,executionScope:{kind:'conversation'},policyPreset:'conversation_only'})
  recordAssistantMessage(log,turn,'Retained answer')
  await persistThreadEventLog(root,log)
  await persistTranscriptToDisk(root,[])
  const saved=readFileSync(join(root,'transcript.jsonl'),'utf8')
  rmSync(join(root,'thread_events.json'))
  await assert.rejects(persistTranscriptToDisk(root,[]),/Canonical archive history is unavailable/)
  assert.equal(readFileSync(join(root,'transcript.jsonl'),'utf8'),saved)
  await persistThreadEventLog(root,createThreadEventLog('no-downgrade-fixture'))
  await assert.rejects(persistTranscriptToDisk(root,[]),/Canonical archive history is unavailable/)
  assert.equal(readFileSync(join(root,'transcript.jsonl'),'utf8'),saved)
}))
