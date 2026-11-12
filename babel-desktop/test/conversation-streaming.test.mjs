import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright';

test('streaming preserves conversation identity, selection, focus, scroll and approval state', {timeout:45000}, async()=>{
  const html=await readFile(new URL('../dist/index.html',import.meta.url),'utf8');
  const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE});
  try{
    const page=await browser.newPage({viewport:{width:1440,height:900}});
    await page.evaluate(()=>{
      const messages=Array.from({length:120},(_,i)=>({role:i%2?'assistant':'user',text:`Fixture ${i}: ${'sample '.repeat(20)}`,sourceEventId:`fixture-${i}`,status:'unverified'}));
      const info={ready:true,officialCliReady:true,projectRoot:null,projectName:null,projectAuthority:{scope:'conversation',identity:null,trusted:false},diagnostics:{ready:true}};
      window.babelDesktop={getInfo:async()=>info,listSessions:async()=>({sessions:[{id:'fixture',title:'Fixture history',messages:120}],total:1}),
        openSession:async()=>({messages,history:{totalMessages:120,hasOlder:false,olderOffset:0}}),listDirectory:async()=>[],
        readProviderRoute:async()=>({provider:'openrouter',model:'fixture-model'}),
        listQualifiedProviders:async()=>[{id:'openrouter',routes:[{id:'fixture-model',label:'Fixture',modelId:'fixture-model',enabled:true}]}],
        onEvent:fn=>{window.__emit=fn;},run:async request=>{window.__run=request.runId;return {started:true};}};
    });
    await page.setContent(html);
    await page.getByRole('button',{name:'Fixture history'}).click();
    await page.locator('#conversation .message').nth(119).waitFor();
    await page.locator('#composer-input').fill('Continue fixture');
    await page.locator('#composer-form').evaluate(form=>form.requestSubmit());
    await page.waitForFunction(()=>Boolean(window.__run));
    const emit=event=>page.evaluate(async event=>{
      window.__emit({runId:window.__run,kind:'event',event});
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    },event);
    await page.evaluate(()=>{
      window.__oldMessage=document.querySelector('[data-source-event-id="fixture-0"]');
      const scroller=document.querySelector('#conversation');scroller.scrollTop=100;window.__scrollTop=scroller.scrollTop;
      const text=window.__oldMessage.querySelector('.message-text').firstChild;
      const range=document.createRange();range.setStart(text,0);range.setEnd(text,7);
      const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);
    });
    await emit({type:'assistant_chunk',chunk:'alpha beta'});
    assert.equal(await page.evaluate(()=>window.__oldMessage===document.querySelector('[data-source-event-id="fixture-0"]')&&window.__oldMessage.isConnected),true);
    assert.equal(await page.evaluate(()=>window.getSelection().toString()),'Fixture');
    assert.ok(Math.abs(await page.evaluate(()=>document.querySelector('#conversation').scrollTop-window.__scrollTop))<2);
    await page.evaluate(()=>{
      const message=document.querySelector('#conversation .assistant-message:last-of-type');window.__liveMessage=message;
      const text=message.querySelector('.message-text').firstChild;
      const range=document.createRange();range.setStart(text,0);range.setEnd(text,5);
      const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);
    });
    await emit({type:'assistant_chunk',chunk:' gamma'});
    assert.equal(await page.evaluate(()=>window.getSelection().toString()),'alpha');
    assert.equal(await page.evaluate(()=>window.__liveMessage===document.querySelector('#conversation .assistant-message:last-of-type')),true);
    await emit({type:'assistant_chunk',chunk:' <img src=x onerror="alert(1)">' });
    assert.match(await page.locator('#conversation .assistant-message:last-of-type .message-text').innerText(),/<img src=x/);
    assert.equal(await page.locator('#conversation .assistant-message:last-of-type .message-text img').count(),0);
    await emit({type:'tool.started',item:{id:'tool-1',tool:'run_command',target:'node fixture-test'}});
    await page.locator('[data-action="expand-tool"][data-id="tool-1"]').click();
    await page.evaluate(()=>{window.__tool=document.activeElement;});
    await emit({type:'assistant_chunk',chunk:' after tool'});
    assert.equal(await page.evaluate(()=>document.activeElement===window.__tool&&window.__tool.isConnected),true);
    assert.equal(await page.locator('[data-action="expand-tool"][data-id="tool-1"]').getAttribute('aria-expanded'),'true');
    await emit({type:'thought',line:'fixture reasoning'});
    const details=page.locator('#conversation .assistant-message:last-of-type details.thought-note');
    await details.locator('summary').click();
    await emit({type:'assistant_chunk',chunk:' later'});
    assert.equal(await details.evaluate(element=>element.open),true);
    const runId=await page.evaluate(()=>window.__run);
    await emit({type:'approval.required',message:'Allow fixture command?',item:{command:'node fixture-test',cwd:'D:/fixture',approval:{schemaVersion:2,request_id:'request-1',thread_id:'thread-1',turn_id:'turn-1',run_id:runId,operation_digest:'a'.repeat(64),expires_at:new Date(Date.now()+60000).toISOString()}}});
    const allow=page.locator('[data-action="approve-run"]');
    await allow.focus();
    await page.evaluate(()=>{window.__allow=document.activeElement;});
    await emit({type:'assistant_chunk',chunk:' while waiting'});
    assert.equal(await page.evaluate(()=>document.activeElement===window.__allow&&window.__allow.isConnected),true);
    assert.equal(await allow.isDisabled(),false);
    await emit({type:'cancelled'});
    assert.equal(await page.locator('[data-action="approve-run"]').count(),0);
    assert.match(await page.locator('#conversation .assistant-message:last-of-type .message-status').innerText(),/stopped/i);
  }finally{await browser.close();}
});
