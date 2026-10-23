// License: Apache-2.0 — see LICENSE
// Runs the built renderer; the native transport is a deterministic fixture.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {chromium} from 'playwright';

const html = readFileSync(new URL('../dist/index.html', import.meta.url), 'utf8');
async function withRun(body) {
  const browser = await chromium.launch({headless:true, executablePath:process.env.CHROMIUM_EXECUTABLE});
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.evaluate(() => {
      window.__runs = [];
      window.__copies = [];
      window.babelDesktop = {
        getInfo:async()=>({ready:true,officialCliReady:true,projectName:'fixture',diagnostics:{ready:true}}),
        listDirectory:async()=>[], listSessions:async()=>({sessions:[],total:0}),
        readProviderRoute:async()=>({provider:'openrouter',model:'fixture'}),
        run:async request=>{window.__runs.push(request);return {started:true};},
        onEvent:listener=>{window.__event=listener;},
        copyText:async text=>{if(window.__copyFails)throw new Error('Fixture clipboard unavailable');window.__copies.push(text);return true;},
      };
    });
    await page.setContent(html);
    await page.waitForFunction(()=>!document.querySelector('#send-button').disabled);
    if (await page.locator('#dialog[open]').count()) await page.locator('[data-action="use-live"]').click();
    await page.locator('#composer-input').fill('Test the fixture');
    await page.locator('#composer-form').evaluate(form=>form.requestSubmit());
    await page.waitForFunction(()=>window.__runs.length===1);
    const emit = packet => page.evaluate(packet=>window.__event({runId:window.__runs[0].runId,...packet}), packet);
    await body(page, emit);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
}
const started = {type:'tool.started',item:{id:'pending',tool:'shell',target:'fixture test'}};

async function holdAnimationFrames(page) {
  await page.evaluate(() => {
    window.__frames = new Map();
    let nextFrame = 1;
    window.requestAnimationFrame = callback => {const id=nextFrame++;window.__frames.set(id,callback);return id;};
    window.cancelAnimationFrame = id => window.__frames.delete(id);
  });
}

test('streamed text shares one render per frame without losing or reordering chunks',async()=>withRun(async(page)=>{
  await holdAnimationFrames(page);
  const result=await page.evaluate(()=>{
    const conversation=document.querySelector('#conversation');
    const observer=new MutationObserver(()=>{});
    observer.observe(conversation,{childList:true});
    const chunks=Array.from({length:100},(_,index)=>`chunk-${index} `);
    for(const chunk of chunks)window.__event({runId:window.__runs[0].runId,kind:'event',event:{type:'assistant_chunk',chunk}});
    const before={renders:observer.takeRecords().length,frames:window.__frames.size};
    for(const [id,callback] of window.__frames){window.__frames.delete(id);callback();}
    const after={renders:observer.takeRecords().length,text:conversation.querySelector('.assistant-message .message-text').textContent,
      detail:document.querySelector('#status-detail').textContent};
    observer.disconnect();
    return {before,after,expected:chunks.join('')};
  });
  assert.deepEqual(result.before,{renders:0,frames:1});
  assert.equal(result.after.renders,1);
  assert.equal(result.after.text,result.expected);
  assert.match(result.after.detail,/working on this task/);
}));

for(const packet of [
  {kind:'event',event:{type:'approval.required',message:'Inspect this operation'}},
  {kind:'event',event:{type:'run_error',error:'Fixture failure'}},
  {kind:'event',event:{type:'run_complete',result:{terminal_outcome:'NO_CHANGE_REQUIRED'}}},
  {kind:'exit',code:1},
])test(`pending text is flushed immediately on ${packet.event?.type??'exit'}`,async()=>withRun(async(page)=>{
  await holdAnimationFrames(page);
  const result=await page.evaluate(packet=>{
    const runId=window.__runs[0].runId;
    window.__event({runId,kind:'event',event:{type:'assistant_chunk',chunk:'Retained streamed answer.'}});
    const queued=window.__frames.size;
    window.__event({runId,...packet});
    return {queued,remaining:window.__frames.size,text:document.querySelector('#conversation').textContent,
      approval:!!document.querySelector('.approval-card'),status:document.querySelector('.message-status')?.textContent};
  },packet);
  assert.equal(result.queued,1);
  assert.equal(result.remaining,0);
  assert.match(result.text,/Retained streamed answer\./);
  if(packet.event?.type==='approval.required')assert.equal(result.approval,true);
  else assert.ok(result.status);
}));

test('Stop flushes pending text and keeps admission closed until exit',async()=>withRun(async(page)=>{
  await holdAnimationFrames(page);
  const result=await page.evaluate(()=>{
    let cancelled=0;
    window.babelDesktop.cancel=()=>{cancelled++;};
    const runId=window.__runs[0].runId;
    window.__event({runId,kind:'event',event:{type:'assistant_chunk',chunk:'Answer before cancellation.'}});
    document.querySelector('[data-action="stop"]').click();
    const stopping={cancelled,frames:window.__frames.size,text:document.querySelector('#conversation').textContent,
      disabled:document.querySelector('#send-button').disabled};
    window.__event({runId,kind:'exit',code:0});
    return {stopping,status:document.querySelector('.message-status').textContent,enabled:!document.querySelector('#send-button').disabled};
  });
  assert.equal(result.stopping.cancelled,1);
  assert.equal(result.stopping.frames,0);
  assert.match(result.stopping.text,/Answer before cancellation\./);
  assert.equal(result.stopping.disabled,true);
  assert.equal(result.status,'Response stopped');
  assert.equal(result.enabled,true);
}));

test('Changed opens an escaped diff with its baseline and does not masquerade as verification',async()=>withRun(async(page,emit)=>{
  await page.evaluate(()=>{window.babelDesktop.readDiff=async path=>({path,baseRevision:'a'.repeat(40),diff:'-before\n+<script>after</script>\n',truncated:false,hasChanges:true});});
  await emit({kind:'event',event:{type:'file.changed',item:{path:'fixture.txt',additions:1,deletions:1}}});
  await page.locator('.changed-files [data-action="diff"]').click();
  assert.match(await page.locator('#dialog').innerText(),/-before/);
  assert.match(await page.locator('#dialog').innerText(),/HEAD a{40}/);
  assert.match(await page.locator('#dialog').innerText(),/does not establish verification/);
  assert.equal(await page.locator('#dialog script').count(),0);
}));
test('approval responses carry the exact operation identity and preserve the draft',async()=>withRun(async(page,emit)=>{
  const binding=await page.evaluate(()=>{
    window.__decisions=[];
    window.babelDesktop.decide=async reply=>{window.__decisions.push(reply);return {accepted:true};};
    document.querySelector('#composer-input').value='Preserved draft';
    return {schemaVersion:2,request_id:'approval-1',thread_id:'thread-1',turn_id:'turn-1',operation_digest:'a'.repeat(64),run_id:window.__runs[0].runId,expires_at:new Date(Date.now()+300000).toISOString()};
  });
  const command='printf "<script>fixture</script>"';
  await emit({kind:'event',event:{type:'approval.required',message:'Allow fixture?',item:{command,cwd:'/fixture/project',details:'{"type":"run_command"}',approval:binding}}});
  assert.match(await page.locator('.approval-card').innerText(),/printf/);
  assert.match(await page.locator('.approval-card').innerText(),/\/fixture\/project/);
  assert.equal(await page.locator('.approval-card script').count(),0);
  await page.locator('[data-action="approve-run"]').click();
  assert.deepEqual(await page.evaluate(()=>window.__decisions),[{runId:binding.run_id,decision:'allow_once',approval:binding}]);
  assert.equal(await page.locator('#composer-input').inputValue(),'Preserved draft');
}));
test('legacy approval messages cannot expose an unscoped Allow action',async()=>withRun(async(page,emit)=>{
  await emit({kind:'event',event:{type:'approval.required',message:'Legacy approval'}});
  assert.equal(await page.locator('[data-action="approve-run"]').isDisabled(),true);
  assert.match(await page.locator('.approval-card').innerText(),/update|identity/i);
}));
test('an acknowledgement for the previous operation cannot erase a newer approval in the same run',async()=>withRun(async(page,emit)=>{
  const binding=await page.evaluate(()=>{
    window.babelDesktop.decide=()=>new Promise(resolve=>{window.__resolveApproval=resolve;});
    return {schemaVersion:2,request_id:'approval-1',thread_id:'thread-1',turn_id:'turn-1',operation_digest:'a'.repeat(64),run_id:window.__runs[0].runId,expires_at:new Date(Date.now()+300000).toISOString()};
  });
  await emit({kind:'event',event:{type:'approval.required',message:'First approval',item:{command:'fixture one',approval:binding}}});
  await page.locator('[data-action="approve-run"]').click();
  await emit({kind:'event',event:{type:'approval.required',message:'Second approval',item:{command:'fixture two',approval:{...binding,request_id:'approval-2',operation_digest:'b'.repeat(64)}}}});
  await page.evaluate(()=>window.__resolveApproval({accepted:true}));
  assert.equal(await page.locator('.approval-card').count(),1);
  assert.match(await page.locator('.approval-card').innerText(),/Second approval/);
  assert.equal(await page.locator('[data-action="approve-run"]').isEnabled(),true);
}));

test('bound approvals without an inspectable operation cannot be allowed but can be denied',async()=>withRun(async(page,emit)=>{
  const binding=await page.evaluate(()=>({schemaVersion:2,request_id:'missing-preview',thread_id:'thread-1',turn_id:'turn-1',operation_digest:'a'.repeat(64),run_id:window.__runs[0].runId,expires_at:new Date(Date.now()+300000).toISOString()}));
  await emit({kind:'event',event:{type:'approval.required',message:'Generic reason',item:{approval:binding}}});
  assert.equal(await page.locator('[data-action="approve-run"]').isDisabled(),true);
  assert.equal(await page.locator('[data-action="deny-run"]').isEnabled(),true);
}));

for (const outcome of ['UNVERIFIED_PATCH','NO_CHANGE_REQUIRED','VERIFIED_COMPLETE','UNKNOWN']) {
  test(`terminal ${outcome} cannot certify an unfinished tool`, async()=>withRun(async(page,emit)=>{
    await emit({kind:'event',event:started});
    await emit({kind:'event',event:{type:'run_complete',result:{terminal_outcome:outcome}}});
    assert.equal(await page.locator('.tool-row.unverified').count(),1);
    assert.equal(await page.locator('#main-status').innerText(),'Finishing');
    assert.equal(await page.locator('#send-button').isDisabled(),true);
    await emit({kind:'exit',code:0});
    assert.equal(await page.locator('.tool-row.complete').count(),0);
    assert.equal(await page.locator('#send-button').isEnabled(),true);
  }));
}
test('late start cannot erase completed tool evidence; old run events cannot settle this run',async()=>withRun(async(page,emit)=>{
  await emit({kind:'event',event:{type:'tool.completed',item:{...started.item,exit_code:0}}});
  await emit({kind:'event',event:started});
  assert.equal(await page.locator('.tool-row.complete').count(),1);
  await emit({runId:'old-run',kind:'exit',code:0});
  assert.equal(await page.locator('#send-button').isDisabled(),true);
  await emit({kind:'exit',code:1});
  assert.equal(await page.locator('.tool-row.complete').count(),1);
  assert.equal(await page.locator('.message-status.failed').count(),1);
}));
test('late transport failure invalidates terminal verification without erasing completed tools',async()=>withRun(async(page,emit)=>{
  await emit({kind:'event',event:{type:'tool.completed',item:{...started.item,exit_code:0}}});
  await emit({kind:'event',event:{type:'run_complete',result:{terminal_outcome:'VERIFIED_COMPLETE'}}});
  await emit({kind:'transport-error',error:'Fixture truncated stream'});
  await emit({kind:'exit',code:0});
  assert.equal(await page.locator('.message-status.unverified').count(),1);
  assert.equal(await page.locator('.tool-row.complete').count(),1);
}));
test('copy is unavailable for an unfinished answer and uses the native text-only bridge',async()=>withRun(async(page,emit)=>{
  assert.equal(await page.locator('[data-action="copy-message"]:enabled').count(),0);
  const answer = 'Exact answer\nconst x = "<safe>";';
  await emit({kind:'event',event:{type:'run_complete',result:{terminal_outcome:'NO_CHANGE_REQUIRED',answer}}});
  await emit({kind:'exit',code:0});
  await page.locator('[data-action="copy-message"]').click();
  assert.deepEqual(await page.evaluate(()=>window.__copies),[answer]);
  await page.evaluate(()=>{window.__copyFails=true;});
  await page.locator('[data-action="copy-message"]').click();
  assert.match(await page.locator('#toast').innerText(),/Clipboard unavailable/);
  await page.setViewportSize({width:390,height:844});
  const toast=await page.locator('#toast').boundingBox();
  const composer=await page.locator('.composer').boundingBox();
  assert.ok(toast.y+toast.height<=composer.y,'clipboard error must not cover the composer');
}));
test('new chats retain earlier/latest archive navigation after the display window fills',async()=>withRun(async(page,emit)=>{
  await emit({kind:'event',event:{type:'run_complete',result:{session_id:'fixture-chat',terminal_outcome:'NO_CHANGE_REQUIRED',answer:'First answer'}}});
  await emit({kind:'exit',code:0});
  await page.evaluate(async()=>{
    window.__history=[];
    window.babelDesktop.openSession=async(id,options)=>{
      window.__history.push({id,...options});
      return {messages:[{role:'assistant',text:options.olderOffset?'First answer':'Latest answer'}],
        history:{olderOffset:options.olderOffset,messageLimit:150,totalMessages:152,hasOlder:!options.olderOffset}};
    };
    for(let turn=1;turn<76;turn++){
      document.querySelector('#composer-input').value=`turn ${turn}`;
      document.querySelector('#composer-form').requestSubmit();
      await Promise.resolve();
      const runId=window.__runs.at(-1).runId;
      window.__event({runId,kind:'event',event:{type:'run_complete',result:{session_id:'fixture-chat',terminal_outcome:'NO_CHANGE_REQUIRED',answer:`answer ${turn}`}}});
      window.__event({runId,kind:'exit',code:0});
    }
  });
  assert.ok(await page.locator('#conversation .message').count()<=150);
  await page.locator('[data-action="load-older-messages"]').click();
  assert.equal(await page.evaluate(()=>window.__history.length),1);
  await page.locator('#conversation').getByText('First answer',{exact:true}).waitFor();
  await page.locator('[data-action="load-latest-messages"]').click();
  assert.deepEqual(await page.evaluate(()=>window.__history.map(entry=>entry.olderOffset)),[150,0]);
  await page.locator('#conversation').getByText('Latest answer',{exact:true}).waitFor();
}));
test('Enter sends, Shift+Enter inserts a newline and composition/repeat never submits',async()=>withRun(async(page,emit)=>{
  await emit({kind:'exit',code:0});
  const input=page.locator('#composer-input');
  await input.fill('next');
  await input.press('Shift+Enter');
  assert.equal(await input.inputValue(),'next\n');
  await input.dispatchEvent('keydown',{key:'Enter',isComposing:true});
  await input.dispatchEvent('keydown',{key:'Enter',repeat:true});
  assert.equal(await page.evaluate(()=>window.__runs.length),1);
  await input.press('Enter');
  assert.equal(await page.evaluate(()=>window.__runs.length),2);
}));
test('a repeated success terminal cannot overwrite failure evidence',async()=>withRun(async(page,emit)=>{
  await emit({kind:'event',event:{type:'run_error',error:'Fixture failure'}});
  await emit({kind:'event',event:{type:'run_complete',result:{terminal_outcome:'VERIFIED_COMPLETE'}}});
  await emit({kind:'exit',code:0});
  assert.equal(await page.locator('.message-status.failed').count(),1);
}));
test('a rejected native admission preserves the unsent draft',async()=>withRun(async(page,emit)=>{
  await emit({kind:'exit',code:0});
  await page.evaluate(()=>{window.babelDesktop.run=async()=>{throw new Error('Fixture admission unavailable');};});
  await page.locator('#composer-input').fill('Keep this draft');
  await page.locator('#composer-input').press('Enter');
  await page.waitForFunction(()=>!document.querySelector('#send-button').disabled);
  assert.equal(await page.locator('#composer-input').inputValue(),'Keep this draft');
}));
test('a tool arriving after the terminal stays unverified when the process exits',async()=>withRun(async(page,emit)=>{
  await emit({kind:'event',event:{type:'run_complete',result:{terminal_outcome:'VERIFIED_COMPLETE'}}});
  await emit({kind:'event',event:started});
  await emit({kind:'exit',code:0});
  assert.equal(await page.locator('.tool-row.running').count(),0);
  assert.equal(await page.locator('.tool-row.unverified').count(),1);
}));
