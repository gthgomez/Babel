import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseTranscriptMessages, readSavedChat, searchSavedChats,readSavedMessage} from '../native/sessions.mjs';
import * as core from '../src/core.mjs';

function records() {
  const base={archive_source:'thread_events',thread_id:'thread',turn_id:'turn',route:{provider:'fixture-provider',model:'fixture-model',source:'turn_started'}};
  return [
    {...base,source_event_id:'user-event',item_id:'turn:1',archive_kind:'user_message',role:'user',name:'user_input',content:'Actual question'},
    {...base,source_event_id:'context-event',archive_kind:'assistant_message',role:'assistant',name:'working_state',provenance:'mixed',content:'Controller context'},
    {...base,source_event_id:'candidate-event',archive_kind:'model_candidate',role:'assistant',content:'Unaccepted model proposal'},
    {...base,source_event_id:'calls-event',archive_kind:'assistant_tool_calls',role:'assistant',content:'',tool_calls:[{id:'denied',type:'function',function:{name:'read_file',arguments:'{"path":"searchable-tool-file.txt"}'}},{id:'unfinished',type:'function',function:{name:'list_dir',arguments:'{}'}}]},
    {...base,source_event_id:'result-event',archive_kind:'tool_result',role:'tool',name:'read_file',tool_call_id:'denied',content:'PROJECT_REQUIRED',exit_code:1},
    {...base,source_event_id:'unknown-result-event',archive_kind:'tool_result',role:'tool',name:'run_command',tool_call_id:'unknown',content:'Output without an exit code'},
    {...base,source_event_id:'terminal-event',archive_kind:'terminal_response',role:'assistant',content:'Choose a project first.',terminal_outcome:'BLOCKED_POLICY'},
  ];
}
const encoded=()=>records().map(JSON.stringify).join('\n')+'\n';

test('canonical archive projects rich activity, exact identities, selected route and controller response',()=>{
  const messages=parseTranscriptMessages(encoded());
  assert.equal(messages.length,7);
  assert.equal(messages[0].sourceEventId,'user-event');
  assert.equal(messages[0].itemId,'turn:1');
  assert.equal(messages[0].historyDetail,'canonical');
  assert.equal(messages[0].route.source,'turn_started');
  assert.equal(messages[1].activity.kind,'context');
  assert.equal(messages[2].activity.kind,'model_candidate');
  assert.equal(messages[3].tools.length,2);
  assert.ok(messages[3].tools.every(tool=>tool.status==='unverified'));
  assert.equal(messages[4].tools[0].toolCallId,'denied');
  assert.equal(messages[4].tools[0].status,'failed');
  assert.equal(messages[5].tools[0].status,'unverified');
  assert.equal(messages[6].text,'Choose a project first.');
  assert.equal(messages[6].status,'blocked');
});

test('legacy missing rich detail stays unknown and never receives invented canonical identities',()=>{
  const [message]=parseTranscriptMessages('{"role":"assistant","content":"Old answer"}\n');
  assert.equal(message.historyDetail,'legacy');
  assert.equal(message.sourceEventId,undefined);
  assert.equal(message.route,undefined);
  assert.deepEqual(message.tools,[]);
});

test('renderer hydration preserves rich blocks while keeping context out of ordinary answers',()=>{
  const messages=parseTranscriptMessages(encoded()).map(core.hydrateArchivedMessage);
  assert.equal(messages[1].blocks[0].kind,'note');
  assert.equal(messages[1].blocks[0].label,'Retained context');
  assert.equal(messages[1].status,null);
  assert.equal(messages[3].blocks[0].kind,'tool');
  assert.equal(messages[3].blocks[0].tool.status,'unverified');
  assert.equal(messages[4].tools[0].status,'failed');
  assert.equal(messages[6].sourceEventId,'terminal-event');
});

test('saved rich history and search keep stable identities without terminal outcome greening tools',async()=>{
  const root=await mkdtemp(join(tmpdir(),'babel-rich-archive-'));
  try {
    const session=join(root,'runs','chat-sessions','rich');
    await mkdir(session,{recursive:true});
    await writeFile(join(session,'transcript.jsonl'),encoded());
    await writeFile(join(session,'session-events.jsonl'),JSON.stringify({kind:'turn_ended',turn_id:'turn',outcome:'VERIFIED_COMPLETE'})+'\n');
    const options={runsDir:join(root,'runs')};
    const saved=await readSavedChat(root,'rich',options);
    assert.equal(saved.messages.length,7);
    assert.equal(saved.messages[3].tools[0].status,'unverified');
    assert.equal(saved.messages[4].tools[0].status,'failed');
    assert.equal(saved.messages[3].status,null);
    assert.equal(saved.messages[6].status,'unverified','disagreeing canonical terminal records cannot certify success');
    assert.equal(saved.messages[6].terminalConflict,true);
    const found=await searchSavedChats(root,'searchable-tool-file.txt',options);
    assert.equal(found.results.length,1);
    assert.equal(found.results[0].sourceEventId,'calls-event');
    assert.equal(found.results[0].messageIndex,3);
  } finally {await rm(root,{recursive:true,force:true});}
});

test('full message reads bind the canonical identity even when its old position has changed',async()=>{
  const root=await mkdtemp(join(tmpdir(),'babel-rich-identity-'));
  try {
    const session=join(root,'runs','chat-sessions','identity');
    await mkdir(session,{recursive:true});
    await writeFile(join(session,'transcript.jsonl'),encoded());
    const options={runsDir:join(root,'runs'),sourceEventId:'terminal-event'};
    const message=await readSavedMessage(root,'identity',0,options);
    assert.equal(message.text,'Choose a project first.');
    assert.equal(message.sourceEventId,'terminal-event');
    assert.equal(message.messageIndex,6);
    await assert.rejects(readSavedMessage(root,'identity',0,{...options,sourceEventId:'missing-event'}),/unavailable|identity/);
  } finally {await rm(root,{recursive:true,force:true});}
});

test('five-thousand-record rich archive pages and searches its earliest retained tool without loading all records',async()=>{
  const root=await mkdtemp(join(tmpdir(),'babel-rich-large-'));
  try {
    const session=join(root,'runs','chat-sessions','large-rich');
    await mkdir(session,{recursive:true});
    const original=records();
    const lines=Array.from({length:5000},(_,index)=>JSON.stringify({...original[index%original.length],source_event_id:`event-${index}`,content:index===0?'EARLIEST RETAINED INPUT':original[index%original.length].content}));
    await writeFile(join(session,'transcript.jsonl'),lines.join('\n')+'\n');
    const options={runsDir:join(root,'runs')};
    const latest=await readSavedChat(root,'large-rich',options);
    assert.equal(latest.history.totalMessages,5000);
    assert.equal(latest.messages.length,150);
    assert.equal(latest.messages[0].sourceEventId,'event-4850');
    const earliest=await readSavedChat(root,'large-rich',{...options,olderOffset:4950});
    assert.equal(earliest.messages.length,50);
    assert.equal(earliest.messages[0].text,'EARLIEST RETAINED INPUT');
    assert.ok(earliest.messages.some(message=>message.tools.length>0));
    const found=await searchSavedChats(root,'EARLIEST RETAINED INPUT',options);
    assert.equal(found.results[0].sourceEventId,'event-0');
    assert.equal(found.results[0].olderOffset,4950);
  } finally {await rm(root,{recursive:true,force:true});}
});

test('bounded tool previews preserve assistant preambles and expose the complete retained activity',()=>{
  const base={archive_source:'thread_events',turn_id:'turn'};
  const messages=parseTranscriptMessages([
    {...base,source_event_id:'many-calls',archive_kind:'assistant_tool_calls',role:'assistant',content:'Why these tools are needed',tool_calls:Array.from({length:101},(_,index)=>({id:`call-${index}`,type:'function',function:{name:'read_file',arguments:`{"path":"file-${index}.txt"}`}}))},
    {...base,source_event_id:'long-output',archive_kind:'tool_result',role:'tool',name:'run_command',tool_call_id:'call-0',content:'x'.repeat(4500)+'RETAINED ERROR AFTER PREVIEW',exit_code:1},
  ].map(JSON.stringify).join('\n'));
  const [calls,result]=messages.map(core.hydrateArchivedMessage);
  assert.equal(calls.blocks[0].kind,'text');
  assert.equal(calls.blocks[0].text,'Why these tools are needed');
  assert.equal(calls.tools.length,100);
  assert.equal(calls.toolsTruncated,true);
  assert.equal(calls.fullActivityAvailable,true);
  assert.ok(!result.tools[0].detail.includes('RETAINED ERROR AFTER PREVIEW'));
  assert.equal(result.textTruncated,false);
  assert.equal(result.fullActivityAvailable,true,'4k detail preview must not make retained text inaccessible');
});
