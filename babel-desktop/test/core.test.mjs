import test from 'node:test';
import assert from 'node:assert/strict';

const load = () => import('../src/core.mjs').catch(() => ({}));

test('HTML renderer escapes untrusted model content', async () => {
  const { escapeHtml } = await load();
  assert.equal(typeof escapeHtml, 'function', 'escapeHtml must exist');
  assert.equal(escapeHtml('<img src=x onerror="bad()">&'), '&lt;img src=x onerror=&quot;bad()&quot;&gt;&amp;');
});
test('context is clamped and unknown usage stays unknown', async () => {
  const { contextPercent } = await load();
  assert.equal(typeof contextPercent, 'function', 'contextPercent must exist');
  assert.equal(contextPercent(42318, 112000), 38);
  assert.equal(contextPercent(null, 112000), null);
  assert.equal(contextPercent(20, 0), null);
  assert.equal(contextPercent(200, 100), 100);
  assert.equal(contextPercent(-2, 100), 0);
});
test('completion outcome is never inferred from event name alone', async () => {
  const { normalizeEvent } = await load();
  assert.equal(typeof normalizeEvent, 'function', 'normalizeEvent must exist');
  assert.equal(normalizeEvent({type:'run_complete',result:{terminal_outcome:'VERIFIED_COMPLETE'}}).status, 'complete');
  assert.equal(normalizeEvent({type:'run_complete',result:{terminal_outcome:'BLOCKED_EXTERNAL'}}).status, 'blocked');
  assert.equal(normalizeEvent({type:'run_complete',result:{terminal_outcome:'CANCELLED'}}).status, 'cancelled');
  assert.equal(normalizeEvent({type:'run_complete',result:{}}).status, 'unverified');
});
test('assistant stream and error events are normalized without prose parsing', async () => {
  const { normalizeEvent } = await load();
  assert.equal(typeof normalizeEvent, 'function', 'normalizeEvent must exist');
  assert.deepEqual(normalizeEvent({type:'assistant_chunk',chunk:'hello'}), {kind:'delta',text:'hello'});
  assert.equal(normalizeEvent({type:'run_error',error:'provider offline'}).status, 'failed');
  assert.equal(normalizeEvent({type:'unexpected'}).kind, 'unknown');
  const tool = normalizeEvent({type:'tool.started',item:{id:'t1',tool:'file_read',target:'src/app.ts'}});
  assert.equal(tool.kind, 'tool');
  assert.equal(tool.action, 'read');
  assert.equal(tool.path, 'src/app.ts');
  assert.equal(tool.status, 'running');
  assert.equal(normalizeEvent({type:'file.changed',item:{path:'src/app.ts',additions:2,deletions:1}}).action, 'edit');
  assert.equal(normalizeEvent({type:'approval.required',message:'Allow write?'}).kind, 'approval');
  assert.equal(normalizeEvent({type:'command.started',item:{command:'npm test'}}).action, 'run');
  assert.equal(normalizeEvent({type:'stage',stage_name:'Reviewing'}).text, 'Reviewing');
  const {sessionIdFromResult}=await load();
  assert.equal(sessionIdFromResult({session_id:'chat-abc123'}),'chat-abc123');
  assert.equal(sessionIdFromResult({session_id:'../x'}),'');
  const {rememberChange}=await load();
  const first=rememberChange([], 'src/app.ts', 2, 1);
  assert.equal(first[0].path, 'src/app.ts');
  assert.equal(first[0].additions, 2);
  const again=rememberChange(first, 'src/app.ts', 3, 0);
  assert.equal(again.length, 1);
  assert.equal(again[0].additions, 5);
  assert.equal(rememberChange([], '../secret', 1, 0).length, 0);
  assert.equal(rememberChange([], 'C:/Windows/notepad.exe', 1, 0).length, 0);
  const {absorbFileChange,reviewFromResult,liveModelFromResult,liveRequestTokens,toolsFromResult,verifiedStatus}=await load();
  const edit=absorbFileChange([{id:'t1',action:'edit',path:'src/app.ts',status:'running',meta:''}],{path:'src/app.ts',additions:4,deletions:1});
  assert.equal(edit.meta,'+4 -1');
  assert.equal(edit.status,'complete');
  assert.equal(absorbFileChange([],{path:'../secret',additions:1,deletions:0}),null);
  assert.equal(reviewFromResult({answer:{facts:['parsed prose']}}),null);
  assert.deepEqual(reviewFromResult({critic_receipt:{verdict:'reject',reasons:['wrong file']}}).reasons,['wrong file']);
  assert.equal(liveModelFromResult({active_context:{model_id:'default',source:'estimated'}}),'');
  assert.equal(liveModelFromResult({active_context:{model_id:'deepseek/deepseek-v4-flash',source:'provider_prompt_tokens'}}),'deepseek/deepseek-v4-flash');
  assert.equal(liveRequestTokens({usage:{totalTokens:99}}),null);
  assert.equal(liveRequestTokens({active_context:{tokens:812,source:'provider_prompt_tokens'}}),812);
  const backfill=toolsFromResult({toolCalls:[{tool:'file_read',target:'README.md'}],verifier_receipt:{command:'npm test',exit_code:0}},[{id:'have',action:'read',path:'README.md',status:'complete'}]);
  assert.equal(backfill.length,1);
  assert.equal(backfill[0].action,'run');
  assert.equal(backfill[0].path,'npm test');
  assert.equal(verifiedStatus('complete',true),'unverified');
  assert.equal(verifiedStatus('no_change',true),'no_change');
  assert.equal(normalizeEvent({type:'tool.completed',item:{id:'t1',tool:'file_read',target:'README.md',exit_code:0}}).meta,'exit 0');
  assert.equal(normalizeEvent({type:'thought',line:'looking'}).kind,'thought');
});
test('preview storage schema rejects malformed history', async () => {
  const { validPreview } = await load();
  assert.equal(typeof validPreview, 'function', 'validPreview must exist');
  assert.equal(validPreview({version:1,sessions:[{id:'one',title:'Test',messages:[]}],activeId:'one',mode:'chat'}), true);
  assert.equal(validPreview({version:1,sessions:[{id:'one',title:'Test',messages:'bad'}],activeId:'one',mode:'chat'}), false);
  assert.equal(validPreview({version:1,sessions:[],activeId:'missing',mode:'chat'}), false);
});

test('terminal outcomes follow the inspected Babel status contract',async()=>{
 const {normalizeEvent,statusFromTerminalOutcome}=await load();
 for(const [outcome,status] of Object.entries({VERIFIED_COMPLETE:'complete',NO_CHANGE_REQUIRED:'no_change',UNVERIFIED_PATCH:'unverified',BLOCKED_POLICY:'blocked',NEEDS_HUMAN_DECISION:'blocked',INVALID_TASK:'blocked',BUDGET_EXHAUSTED:'failed',VERIFIED_SUCCESS:'unverified'})){
  assert.equal(statusFromTerminalOutcome(outcome),status,outcome);
  assert.equal(normalizeEvent({type:'run_complete',result:{terminal_outcome:outcome}}).status,status,outcome);
 }
 assert.equal(normalizeEvent({type:'command.completed',item:{exit_code:1}}).status,'failed');
});
