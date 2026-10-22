// License: Apache-2.0 — see LICENSE
// Actual built renderer with explicitly doubled native API. This is not installed proof.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {chromium} from 'playwright';
import {parseTranscriptMessages} from '../native/sessions.mjs';

const html = readFileSync(new URL('../dist/index.html', import.meta.url), 'utf8');

async function renderer(diagnostics, body, handshake = 'ready',scope=null,draftSeed=null,infoOverride=null) {
  const browser = await chromium.launch({headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE});
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.evaluate(({diagnostics, handshake,scope,draftSeed,infoOverride}) => {
      window.__runs = [];
      window.__projectReads=[];
      window.__info = {packaged: true, ready: true, officialCliReady: true, projectName: 'fixture-project', diagnostics,...(scope?{projectRoot:null,projectName:null,projectAuthority:scope}:{}),...(infoOverride??{})};
      window.babelDesktop = {
        getInfo: async () => {
          if (handshake === 'rejected') throw new Error('Fixture handshake rejected');
          if (handshake === 'pending') await new Promise(resolve => {window.__resolveInfo = resolve;});
          return window.__info;
        },
        refreshDiagnostics: async () => window.__info,
        listDirectory: async () => {window.__projectReads.push('directory');return [{name: 'README.md', type: 'file'}];},
        listSessions: async () => ({sessions: [{id: 'history', title: 'Saved history fixture'}], total: 1}),
        readProviderRoute: async () => ({provider:'openrouter',model:'fixture-openrouter'}),
        openSession: async (id, {olderOffset = 0} = {}) => {
          const end = Math.max(0, 160 - olderOffset);
          const start = Math.max(0, end - 150);
          return {id, messages: Array.from({length: end - start}, (_, index) => ({role: (start + index) % 2 ? 'assistant' : 'user', text: `message-${start + index}`, status: 'unverified'})),
            history: {totalMessages: 160, messageLimit: 150, olderOffset, hasOlder: start > 0, windowStart: start}};
        },
        run: async request => {window.__runs.push(request); return {started: false};},
        onEvent() {},
      };
      if(draftSeed){
        window.__draftStore={version:1,scope:'fixture-scope',revision:0,readOnly:false,drafts:draftSeed};
        window.__draftWrites=[];
        window.babelDesktop.readComposerDrafts=async()=>structuredClone(window.__draftStore);
        window.babelDesktop.writeComposerDrafts=async request=>{
          if(window.__draftFailure)throw new Error('Fixture disk unavailable');
          if(request.revision!==window.__draftStore.revision)throw new Error('Fixture draft revision mismatch');
          window.__draftStore={...structuredClone(request),version:1,revision:request.revision+1,readOnly:false};window.__draftWrites.push(request);
          return {saved:true,revision:window.__draftStore.revision};
        };
        window.babelDesktop.onPrepareDraftClose=callback=>{window.__prepareDraftClose=callback;};
        window.babelDesktop.completeDraftClose=async receipt=>{window.__draftCloseReceipt=receipt;};
      }
    }, {diagnostics, handshake,scope,draftSeed,infoOverride});
    await page.setContent(html);
    if (handshake === 'ready') await page.waitForFunction(()=>!document.querySelector('#status-detail').textContent.includes('Connecting'));
    await body(page);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
}

async function connect(page) {
  if(await page.locator('#dialog[open]').count())await page.locator('#dialog [data-action="use-live"]').click();
  await page.locator('#dialog').waitFor({state:'hidden'});
  assert.equal(await page.locator('#preview-badge').innerText(),'BABEL CLI');
}

test('unsent drafts and reading position stay with their conversation and flush before close',async()=>renderer({ready:true},async page=>{
  await connect(page);
  await page.locator('#sessions .session-button').filter({hasText:'Saved history fixture'}).click();
  await page.locator('#conversation').evaluate(element=>{element.scrollTo({top:440,behavior:'instant'});});
  await page.locator('#composer-input').fill('Draft for the saved chat');
  await page.locator('[data-action="new-session"]').first().click();
  const other=await page.locator('#sessions .session-button').first().getAttribute('data-id');
  await page.locator('#composer-input').fill('Draft for the new chat');
  await page.locator('#sessions .session-button').filter({hasText:'Saved history fixture'}).click();
  assert.equal(await page.locator('#composer-input').inputValue(),'Draft for the saved chat');
  assert.ok(await page.locator('#conversation').evaluate(element=>element.scrollTop)>0);
  await page.locator(`#sessions [data-id="${other}"]`).click();
  assert.equal(await page.locator('#composer-input').inputValue(),'Draft for the new chat');
  await page.evaluate(()=>window.__prepareDraftClose('close-fixture'));
  assert.deepEqual(await page.evaluate(()=>window.__draftCloseReceipt),{token:'close-fixture',saved:true});
  const drafts=await page.evaluate(()=>window.__draftStore.drafts);
  assert.ok(drafts.some(draft=>draft.sessionId==='history'&&draft.text==='Draft for the saved chat'));
  assert.ok(drafts.some(draft=>draft.id===other&&draft.sessionId===null&&draft.text==='Draft for the new chat'));
},'ready',null,[]));

test('reopening the renderer restores an unsent draft into its canonical saved chat',async()=>renderer({ready:true},async page=>{
  await connect(page);
  await page.locator('#sessions .session-button').filter({hasText:'Saved history fixture'}).click();
  assert.equal(await page.locator('#composer-input').inputValue(),'Retained through restart');
  assert.equal(await page.locator('#conversation .message').count(),10);
  assert.equal(await page.locator('[data-action="load-latest-messages"]').count(),1);
  await page.locator('#composer-input').fill('Updated after reopening');
  await page.evaluate(()=>window.__prepareDraftClose('restart-fixture'));
  assert.equal(await page.evaluate(()=>window.__draftStore.drafts.find(draft=>draft.sessionId==='history').text),'Updated after reopening');
  assert.equal(await page.evaluate(()=>window.__draftStore.drafts.find(draft=>draft.sessionId==='history').historyOffset),150);
  assert.equal(await page.evaluate(()=>window.__runs.length),0);
},'ready',null,[{id:'retained-draft',sessionId:'history',title:'Saved history fixture',text:'Retained through restart',scrollTop:220,historyOffset:150}]));

test('draft save failure keeps text editable and refuses a successful close acknowledgement',async()=>renderer({ready:true},async page=>{
  await connect(page);
  await page.evaluate(()=>{window.__draftFailure=true;});
  await page.locator('#composer-input').fill('Keep this unsaved draft available to copy');
  await page.waitForFunction(()=>document.querySelector('#toast').textContent.includes('Draft saving failed'));
  await page.evaluate(()=>window.__prepareDraftClose('failed-close'));
  assert.deepEqual(await page.evaluate(()=>window.__draftCloseReceipt),{token:'failed-close',saved:false});
  assert.equal(await page.locator('#composer-input').inputValue(),'Keep this unsaved draft available to copy');
  assert.equal(await page.locator('#composer-input').isEditable(),true);
},'ready',null,[]));

test('the next draft is editable after native admission and never overwrites an unacknowledged Send',async()=>renderer({ready:true},async page=>{
  await connect(page);
  await page.evaluate(()=>{window.babelDesktop.run=request=>new Promise(resolve=>{window.__runs.push(request);window.__admitRun=()=>resolve({started:true});});});
  await page.locator('#composer-input').fill('Submission waiting for native admission');
  await page.locator('#composer-form').evaluate(form=>form.requestSubmit());
  await page.waitForFunction(()=>typeof window.__admitRun==='function');
  assert.equal(await page.locator('#composer-input').isEditable(),false);
  await page.evaluate(()=>window.__admitRun());
  await page.waitForFunction(()=>!document.querySelector('#composer-input').disabled);
  assert.equal(await page.locator('#send-button').isDisabled(),true);
  await page.locator('#composer-input').fill('The next draft while work runs');
  await page.evaluate(()=>window.__prepareDraftClose('busy-draft'));
  assert.equal(await page.evaluate(()=>window.__draftStore.drafts.some(draft=>draft.text==='The next draft while work runs')),true);
  assert.equal(await page.evaluate(()=>window.__runs.length),1);
},'ready',null,[]));

test('text entered while the initial native handshake waits survives connection initialization',async()=>renderer({ready:true},async page=>{
  await page.locator('#composer-input').fill('Draft entered before connection completed');
  await page.evaluate(()=>window.__prepareDraftClose('pending-initial-draft'));
  assert.equal(await page.evaluate(()=>window.__draftCloseReceipt.saved),false);
  await page.evaluate(()=>window.__resolveInfo());
  await page.waitForFunction(()=>!document.querySelector('#send-button').disabled);
  assert.equal(await page.locator('#composer-input').inputValue(),'Draft entered before connection completed');
  await page.evaluate(()=>window.__prepareDraftClose('initial-draft'));
  assert.equal(await page.evaluate(()=>window.__draftStore.drafts.some(draft=>draft.text==='Draft entered before connection completed')),true);
},'pending',null,[]));

test('project selection locks the old composer until its saved scope is replaced',async()=>renderer({ready:true},async page=>{
  await connect(page);
  await page.evaluate(()=>{
    window.babelDesktop.chooseProject=()=>new Promise(resolve=>{window.__returnProject=()=>{
      window.__previousDrafts=structuredClone(window.__draftStore.drafts);
      window.__draftStore={version:1,scope:'different-fixture-scope',revision:0,drafts:[],readOnly:false};
      window.__info={...window.__info,projectRoot:'D:/fixture-selected-project',projectName:'Selected fixture project'};
      resolve(window.__info);
    };});
  });
  await page.locator('#composer-input').fill('Draft bound to the original project');
  await page.locator('[data-action="open-project"]').first().click();
  await page.waitForFunction(()=>typeof window.__returnProject==='function');
  assert.equal(await page.locator('#composer-input').isEditable(),false);
  assert.equal(await page.locator('#send-button').isDisabled(),true);
  await page.locator('[data-action="new-session"]').first().click();
  assert.equal(await page.locator('#composer-input').inputValue(),'Draft bound to the original project');
  await page.evaluate(()=>window.__returnProject());
  await page.waitForFunction(()=>!document.querySelector('#send-button').disabled);
  assert.equal(await page.locator('#composer-input').inputValue(),'');
  assert.equal(await page.evaluate(()=>window.__previousDrafts.some(draft=>draft.text==='Draft bound to the original project')),true);
  assert.equal(await page.locator('#composer-input').isEditable(),true);
},'ready',null,[]));

test('explicit packaged conversation binding admits Chat without project reads or Docker diagnostics',async()=>{
  await renderer(undefined,async page=>{
    await connect(page);
    assert.equal(await page.locator('#send-button').isEnabled(),true);
    assert.equal(await page.locator('.top-tab[data-mode="plan"]').isDisabled(),true);
    assert.equal(await page.locator('.top-tab[data-mode="deep"]').isDisabled(),true);
    assert.deepEqual(await page.evaluate(()=>window.__projectReads),[]);
    assert.match(await page.locator('.empty-state').innerText(),/No project is open\. You can ask a general question, or open a project for code questions\./);
    assert.deepEqual(await page.locator('.empty-actions button').evaluateAll(buttons=>buttons.map(button=>button.dataset.action)),['open-project']);
    assert.equal(await page.locator('.empty-state [data-action="draft"]').count(),0);
    await page.locator('#composer-input').fill('Hello without a project');
    await page.keyboard.press('Enter');
    await page.waitForFunction(()=>window.__runs.length===1);
    assert.equal(await page.evaluate(()=>window.__runs[0].task),'Hello without a project');
  },'ready',{scope:'conversation',identity:null,trusted:false});
});

test('empty state offers one repository starter only for a known trusted project',async()=>{
  await renderer({ready:true},async page=>{
    await connect(page);
    assert.doesNotMatch(await page.locator('.empty-state').innerText(),/Send a task/);
    assert.equal(await page.locator('.empty-state [data-action="draft"]').count(),0);
    assert.equal(await page.locator('.empty-state [data-action="connection"]').count(),1);
  });
  await renderer({ready:true},async page=>{
    await connect(page);
    assert.doesNotMatch(await page.locator('.empty-state').innerText(),/No project is open/);
    const starters=page.locator('.empty-state [data-action="draft"]');
    assert.equal(await starters.count(),1);
    assert.equal(await starters.innerText(),'Trace a behavior');
    await starters.click();
    assert.match(await page.locator('#composer-input').inputValue(),/^Using this repository's README and code, trace one small documented behavior.*Do not change files, install dependencies, or run tests or builds\./s);
    assert.equal(await page.evaluate(()=>document.activeElement?.id),'composer-input');
    assert.deepEqual(await page.evaluate(()=>window.__runs),[]);
  },'ready',null,null,{projectRoot:'/fixture-project',projectAuthority:{scope:'project',trusted:true,identity:{branch:'main'}}});
  await renderer({ready:true},async page=>{
    await connect(page);
    assert.doesNotMatch(await page.locator('.empty-state').innerText(),/Send a task/);
    assert.equal(await page.locator('.empty-state [data-action="draft"]').count(),0);
  },'ready',null,null,{projectRoot:'/fixture-project',projectAuthority:{scope:'project',trusted:false,identity:null,reason:'Not trusted'}});
});

test('archive search opens a matching earlier page from a session outside the sidebar',async()=>renderer({ready:true},async page=>{
  await connect(page);
  await page.evaluate(()=>{
    window.babelDesktop.searchSessions=async query=>({totalMatches:1,results:[{sessionId:'outside-sidebar',title:'Archived <title>',excerpt:`${query} <script>fixture</script>`,olderOffset:150,messageIndex:1}]});
    const open=window.babelDesktop.openSession;
    window.babelDesktop.openSession=async(id,options)=>{window.__searchedPage={id,...options};return open(id,options);};
  });
  await page.keyboard.press('Control+k');
  await page.locator('#search-input').fill('retained words');
  await page.locator('#history-search-form').evaluate(form=>form.requestSubmit());
  await page.locator('[data-action="search-archive-hit"]').waitFor();
  assert.equal(await page.locator('#search-results script').count(),0);
  await page.locator('[data-action="search-archive-hit"]').click();
  await page.waitForFunction(()=>window.__searchedPage?.id==='outside-sidebar');
  assert.equal(await page.evaluate(()=>window.__searchedPage.olderOffset),150);
  assert.ok((await page.locator('#conversation').innerText()).includes('message-0'));
  assert.equal(await page.locator('#conversation .message:focus').count(),1);
}));

test('a delayed archive search cannot replace results for a newer query',async()=>renderer({ready:true},async page=>{
  await connect(page);
  await page.evaluate(()=>{window.babelDesktop.searchSessions=()=>new Promise(resolve=>{window.__finishSearch=resolve;});});
  await page.keyboard.press('Control+k');
  await page.locator('#search-input').fill('first query');
  await page.locator('#history-search-form').evaluate(form=>form.requestSubmit());
  await page.locator('#search-input').fill('newer query');
  await page.evaluate(()=>window.__finishSearch({results:[{sessionId:'stale',title:'STALE HIT',excerpt:'first query'}],totalMatches:1}));
  await page.waitForFunction(()=>!document.querySelector('#search-archive-button').disabled);
  assert.equal(await page.locator('[data-action="search-archive-hit"]').count(),0);
  assert.match(await page.locator('#search-status').innerText(),/Query changed/);
}));

test('sending while viewing earlier history loads a bounded latest page and resumes the same canonical chat',async()=>renderer({ready:true},async page=>{
  await connect(page);
  await page.evaluate(()=>{
    const open=window.babelDesktop.openSession;
    window.__historyReads=[];
    window.babelDesktop.openSession=async(id,options)=>{window.__historyReads.push(options?.olderOffset??0);return open(id,options);};
  });
  await page.locator('#sessions .session-button').filter({hasText:'Saved history fixture'}).click();
  await page.locator('[data-action="load-older-messages"]').click();
  await page.waitForFunction(()=>document.querySelector('#conversation').textContent.includes('message-0'));
  await page.locator('#composer-input').fill('Continue from an earlier display page');
  await page.locator('#composer-form').evaluate(form=>form.requestSubmit());
  await page.waitForFunction(()=>window.__runs.length===1,null,{timeout:3000});
  assert.deepEqual(await page.evaluate(()=>window.__historyReads),[0,150,0]);
  assert.equal(await page.evaluate(()=>window.__runs[0].sessionId),'history');
  assert.equal(await page.locator('#conversation .message').count(),150);
  assert.equal(await page.locator('#conversation .message').filter({hasText:/message-0\b/}).count(),0);
  assert.equal(await page.locator('#composer-input').inputValue(),'Continue from an earlier display page');
}));

test('a delayed latest-page load deduplicates Send and preserves a draft changed while loading',async()=>renderer({ready:true},async page=>{
  await connect(page);
  await page.locator('#sessions .session-button').filter({hasText:'Saved history fixture'}).click();
  await page.locator('[data-action="load-older-messages"]').click();
  await page.waitForFunction(()=>document.querySelector('#conversation').textContent.includes('message-0'));
  await page.evaluate(()=>{
    const open=window.babelDesktop.openSession;
    window.__latestPageRequests=0;
    window.babelDesktop.openSession=(id,options)=>new Promise(resolve=>{window.__latestPageRequests++;window.__releaseLatest=async()=>resolve(await open(id,options));});
  });
  await page.locator('#composer-input').fill('Original draft');
  await page.locator('#composer-form').evaluate(form=>form.requestSubmit());
  await page.waitForFunction(()=>typeof window.__releaseLatest==='function');
  await page.locator('#composer-form').evaluate(form=>form.requestSubmit());
  await page.locator('#composer-input').fill('Edited while history loaded');
  await page.evaluate(()=>window.__releaseLatest());
  await page.waitForFunction(()=>document.querySelector('#toast').textContent.includes('draft or route changed'));
  assert.equal(await page.evaluate(()=>window.__latestPageRequests),1);
  assert.equal(await page.evaluate(()=>window.__runs.length),0);
  assert.equal(await page.locator('#composer-input').inputValue(),'Edited while history loaded');
  assert.equal(await page.locator('#conversation .message').count(),150);
  await page.locator('#composer-form').evaluate(form=>form.requestSubmit());
  await page.waitForFunction(()=>window.__runs.length===1);
  assert.equal(await page.evaluate(()=>window.__runs[0].task),'Edited while history loaded');
}));

test('failed latest-page loading retains the earlier view and draft without dispatch',async()=>renderer({ready:true},async page=>{
  await connect(page);
  await page.locator('#sessions .session-button').filter({hasText:'Saved history fixture'}).click();
  await page.locator('[data-action="load-older-messages"]').click();
  await page.waitForFunction(()=>document.querySelector('#conversation').textContent.includes('message-0'));
  await page.evaluate(()=>{window.babelDesktop.openSession=async()=>{throw new Error('Fixture history unavailable');};});
  await page.locator('#composer-input').fill('Preserved after page failure');
  await page.locator('#composer-form').evaluate(form=>form.requestSubmit());
  await page.waitForFunction(()=>document.querySelector('#toast').textContent.includes('Fixture history unavailable'));
  assert.equal(await page.evaluate(()=>window.__runs.length),0);
  assert.equal(await page.locator('#composer-input').inputValue(),'Preserved after page failure');
  assert.equal(await page.locator('#conversation .message').count(),10);
}));

for(const first of [0,1])test(`Send and history navigation cannot replace an active response (page ${first} resolves first)`,async()=>renderer({ready:true},async page=>{
  await connect(page);
  await page.locator('#sessions .session-button').filter({hasText:'Saved history fixture'}).click();
  await page.locator('[data-action="load-older-messages"]').click();
  await page.waitForFunction(()=>document.querySelector('#conversation').textContent.includes('message-0'));
  await page.evaluate(()=>{
    const open=window.babelDesktop.openSession;
    window.__pages=[];
    window.babelDesktop.openSession=(id,options)=>new Promise(resolve=>window.__pages.push(async()=>resolve(await open(id,options))));
    window.babelDesktop.run=async request=>{window.__runs.push(request);return {started:true};};
  });
  await page.locator('#composer-input').fill('Keep this running response visible');
  await page.locator('#composer-form').evaluate(form=>form.requestSubmit());
  await page.waitForFunction(()=>window.__pages.length===1);
  await page.locator('[data-action="load-latest-messages"]').click();
  await page.waitForFunction(()=>window.__pages.length===2);
  await page.evaluate(index=>window.__pages[index](),first);
  if(first===1){
    await page.waitForFunction(()=>!document.querySelector('[data-action="load-latest-messages"]'));
    await page.locator('#composer-form').evaluate(form=>form.requestSubmit());
  }
  assert.equal(await page.evaluate(()=>window.__runs.length),0,'a superseded or pending Send read cannot dispatch');
  await page.evaluate(index=>window.__pages[index](),1-first);
  await page.waitForFunction(()=>!document.querySelector('[data-action="load-latest-messages"]'));
  await page.locator('#composer-form').evaluate(form=>form.requestSubmit());
  await page.waitForFunction(()=>window.__runs.length===1);
  assert.equal(await page.locator('#conversation .message').filter({hasText:'Keep this running response visible'}).count(),1);
  assert.equal(await page.locator('#conversation .message').count(),150);
}));

test('a pending earlier-page read cannot replace a response started from the latest view',async()=>renderer({ready:true},async page=>{
  await connect(page);
  await page.locator('#sessions .session-button').filter({hasText:'Saved history fixture'}).click();
  await page.evaluate(()=>{
    const open=window.babelDesktop.openSession;
    window.babelDesktop.openSession=(id,options)=>new Promise(resolve=>{window.__releaseOlder=async()=>resolve(await open(id,options));});
    window.babelDesktop.run=async request=>{window.__runs.push(request);return {started:true};};
  });
  await page.locator('[data-action="load-older-messages"]').click();
  await page.waitForFunction(()=>typeof window.__releaseOlder==='function');
  await page.locator('#composer-input').fill('Retain the active assistant');
  await page.locator('#composer-form').evaluate(form=>form.requestSubmit());
  await page.waitForFunction(()=>window.__runs.length===1);
  await page.evaluate(()=>window.__releaseOlder());
  assert.equal(await page.locator('#conversation .message').filter({hasText:'Retain the active assistant'}).count(),1);
  assert.equal(await page.locator('#conversation .message').count(),150);
}));

test('canonical archive search and message sections bind the source identity instead of a stale position',async()=>renderer({ready:true},async page=>{
  await connect(page);
  await page.evaluate(()=>{
    window.babelDesktop.searchSessions=async()=>({totalMatches:1,results:[{sessionId:'history',title:'Identity fixture',excerpt:'Canonical match',olderOffset:0,messageIndex:0,sourceEventId:'right-event',matchOffset:300000}]});
    window.babelDesktop.openSession=async id=>({id,messages:[{role:'user',text:'Wrong old position',sourceEventId:'wrong-event',messageIndex:0},{role:'assistant',text:'Canonical match',sourceEventId:'right-event',messageIndex:1,status:'blocked'}],history:{totalMessages:2,messageLimit:150,olderOffset:0,hasOlder:false,windowStart:0}});
    window.__sections=[];
    window.babelDesktop.readSessionMessage=async request=>{
      window.__sections.push(request);
      return {text:'Canonical retained section',charOffset:request.charOffset,totalCharacters:600000,hasPrevious:true,hasNext:true,messageIndex:1,sourceEventId:'right-event'};
    };
  });
  await page.keyboard.press('Control+k');
  await page.locator('#search-input').fill('Canonical match');
  await page.locator('#history-search-form').evaluate(form=>form.requestSubmit());
  await page.locator('[data-action="search-archive-hit"]').click();
  await page.waitForFunction(()=>window.__sections?.length===1);
  assert.deepEqual(await page.evaluate(()=>window.__sections[0]),{sessionId:'history',messageIndex:0,charOffset:250000,sourceEventId:'right-event'});
  assert.equal(await page.locator('#conversation [data-source-event-id="right-event"]').count(),1);
  await page.locator('[data-action="message-section"]').filter({hasText:'Next section'}).click();
  await page.waitForFunction(()=>window.__sections?.length===2);
  assert.equal(await page.evaluate(()=>window.__sections[1].sourceEventId),'right-event');
  assert.equal(await page.evaluate(()=>window.__sections[1].messageIndex),1);
}));

test('retained tool details remain accessible beyond previews and search opens the hidden matching text',async()=>renderer({ready:true},async page=>{
  await connect(page);
  const base={archive_source:'thread_events',turn_id:'turn'};
  const messages=parseTranscriptMessages([
    {...base,role:'assistant',source_event_id:'many-calls',archive_kind:'assistant_tool_calls',content:'Tool inspection preamble',tool_calls:Array.from({length:101},(_,index)=>({id:`call-${index}`,type:'function',function:{name:'read_file',arguments:'{}'}}))},
    {...base,role:'tool',source_event_id:'long-output',archive_kind:'tool_result',name:'run_command',tool_call_id:'call-0',content:'x'.repeat(4500)+'RETAINED ERROR AFTER PREVIEW',exit_code:1},
  ].map(JSON.stringify).join('\n')).map((message,index)=>({...message,messageIndex:index}));
  await page.evaluate(messages=>{
    window.babelDesktop.openSession=async id=>({id,messages,history:{totalMessages:2,messageLimit:150,olderOffset:0,hasOlder:false,windowStart:0}});
    window.__sections=[];
    window.babelDesktop.readSessionMessage=async request=>{window.__sections.push(request);return {text:'RETAINED ERROR AFTER PREVIEW',charOffset:request.charOffset,totalCharacters:4528,hasPrevious:false,hasNext:false,messageIndex:1,sourceEventId:request.sourceEventId};};
    window.babelDesktop.searchSessions=async()=>({totalMatches:1,results:[{sessionId:'history',title:'Saved history fixture',excerpt:'RETAINED ERROR AFTER PREVIEW',olderOffset:0,messageIndex:1,sourceEventId:'long-output',matchOffset:4500}]});
  },messages);
  await page.locator('#sessions .session-button').filter({hasText:'Saved history fixture'}).click();
  await page.locator('#conversation .message[data-source-event-id="long-output"]').waitFor();
  assert.match(await page.locator('#conversation').innerText(),/Tool inspection preamble/);
  assert.equal(await page.locator('#conversation [data-action="view-full-message"]').count(),2);
  await page.locator('#conversation [data-source-event-id="long-output"] [data-action="view-full-message"]').click();
  await page.waitForFunction(()=>window.__sections.length===1);
  assert.equal(await page.evaluate(()=>window.__sections[0].sourceEventId),'long-output');
  await page.locator('#dialog [data-action="close-dialog"]').click();
  await page.keyboard.press('Control+k');
  await page.locator('#search-input').fill('RETAINED ERROR AFTER PREVIEW');
  await page.locator('#history-search-form').evaluate(form=>form.requestSubmit());
  await page.locator('[data-action="search-archive-hit"]').click();
  await page.waitForFunction(()=>window.__sections.length===2);
  assert.equal(await page.evaluate(()=>window.__sections[1].charOffset),0);
  assert.equal(await page.evaluate(()=>window.__sections[1].sourceEventId),'long-output');
  assert.match(await page.locator('#dialog-content').innerText(),/RETAINED ERROR AFTER PREVIEW/);
}));

test('a search match beyond the preview opens its full-message section and supports paging',async()=>renderer({ready:true},async page=>{
  await connect(page);
  await page.evaluate(()=>{
    window.__messageRequests=[];
    window.babelDesktop.searchSessions=async()=>({totalMatches:1,results:[{sessionId:'long',title:'Long archive',excerpt:'NEEDLE',olderOffset:0,messageIndex:0,matchOffset:260000}]});
    window.babelDesktop.openSession=async()=>({messages:[{role:'assistant',text:'prefix',textTruncated:true,messageIndex:0}],history:{totalMessages:1,windowStart:0}});
    window.babelDesktop.readSessionMessage=async request=>{
      window.__messageRequests.push(request);
      return {text:request.charOffset?'NEEDLE <script>escaped</script>':'prefix',charOffset:request.charOffset,totalCharacters:270000,hasPrevious:request.charOffset>0,hasNext:request.charOffset===0};
    };
  });
  await page.keyboard.press('Control+k');await page.locator('#search-input').fill('needle');
  await page.locator('#history-search-form').evaluate(form=>form.requestSubmit());
  await page.locator('[data-action="search-archive-hit"]').click();
  await page.waitForFunction(()=>document.querySelector('#dialog').textContent.includes('NEEDLE'));
  assert.equal(await page.locator('#dialog script').count(),0);
  assert.equal(await page.evaluate(()=>window.__messageRequests[0].charOffset),250000);
  await page.locator('[data-action="message-section"]').click();
  await page.waitForFunction(()=>window.__messageRequests.length===2);
  assert.equal(await page.evaluate(()=>window.__messageRequests[1].charOffset),0);
  await page.locator('[data-action="close-dialog"]').click();
  assert.match(await page.locator('#conversation').innerText(),/preview truncated/);
  await page.locator('[data-action="view-full-message"]').click();
  await page.waitForFunction(()=>window.__messageRequests.length===3);
}));

async function blockedSubmissions(page) {
  await page.locator('#composer-input').fill('Read project documentation');
  await page.keyboard.press('Control+Enter');
  await page.locator('#composer-form').evaluate(form => form.requestSubmit());
  assert.equal(await page.evaluate(() => window.__runs.length), 0);
  assert.equal(await page.locator('.user-message').count(), 0);
  assert.equal(await page.locator('#send-button').isDisabled(), true);
}

test('packaged connection permits latest → older → latest history with failed Docker diagnostics', async () => {
  await renderer({ready: false, docker: 'unavailable'}, async page => {
    await connect(page);
    await page.locator('button.session-button', {hasText: 'Saved history fixture'}).click();
    const conversation = page.locator('#conversation');
    await conversation.getByText('message-159', {exact: true}).waitFor();
    assert.equal(await conversation.getByText('message-9', {exact: true}).count(), 0);
    await page.locator('[data-action="load-older-messages"]').click();
    await conversation.getByText('message-9', {exact: true}).waitFor();
    assert.equal(await conversation.getByText('message-159', {exact: true}).count(), 0);
    await page.locator('[data-action="load-latest-messages"]').click();
    await conversation.getByText('message-159', {exact: true}).waitFor();
    assert.equal(await conversation.getByText('message-9', {exact: true}).count(), 0);
    assert.equal(await page.locator('#send-button').isDisabled(), true);
    assert.equal(await page.evaluate(() => window.__runs.length), 0);
  });
});

for (const [name, diagnostics] of [['missing', undefined], ['failed', {ready: false, docker: 'unavailable'}]]) {
  test(`packaged ${name} diagnostics block keyboard and form submissions before and after connection`, async () => {
    await renderer(diagnostics, async page => {
      await blockedSubmissions(page);
      await page.locator('#dialog [data-action="close-dialog"]').click();
      await page.locator('#preview-badge').click();
      await connect(page);
      await blockedSubmissions(page);
    });
  });
}

test('healthy packaged diagnostics enter the real harness automatically', async () => {
  await renderer({ready: true, docker: 'available'}, async page => {
    await connect(page);
    assert.equal(await page.locator('#send-button').isEnabled(), true);
    await page.locator('#composer-input').fill('Read project documentation');
    await page.keyboard.press('Control+Enter');
    await page.getByText('Run was not started. No model call was made.', {exact: true}).waitFor();
    assert.equal(await page.evaluate(() => window.__runs[0].mode), 'chat');
  });
});

test('a full history page can continue its original CLI session with bounded rendering',async()=>{
  await renderer({ready:true,docker:'available'},async page=>{
    await connect(page);
    await page.locator('button.session-button',{hasText:'Saved history fixture'}).click();
    await page.locator('#conversation').getByText('message-159',{exact:true}).waitFor();
    await page.locator('#composer-input').fill('Continue this task');
    await page.keyboard.press('Enter');
    await page.waitForFunction(()=>window.__runs.length===1);
    assert.equal(await page.evaluate(()=>window.__runs[0].sessionId),'history');
    assert.ok(await page.locator('#conversation .message').count()<=150);
  });
});

test('configured supported modes keep tabs, controls and keyboard selection synchronized',async()=>{
  await renderer({ready:true,docker:'available'},async page=>{
    await connect(page);
    await page.locator('.top-tab[data-mode="plan"]').click();
    assert.equal(await page.locator('.mode-option[data-mode="plan"]').getAttribute('aria-pressed'),'true');
    await page.locator('.mode-option[data-mode="deep"]').click();
    assert.equal(await page.locator('.top-tab[data-mode="deep"]').getAttribute('aria-pressed'),'true');
    await page.keyboard.press('Alt+1');
    assert.equal(await page.locator('.top-tab[data-mode="chat"]').getAttribute('aria-pressed'),'true');
    assert.equal(await page.evaluate(()=>window.__runs.length),0);
  });
});

test('catalog controls expose unavailable models and all five metadata refresh paths without inference',async()=>{
  await renderer({ready:true,docker:'available'},async page=>{
    await connect(page);
    await page.evaluate(()=>{
      window.babelDesktop.refreshModels=async()=>{};
      window.babelDesktop.listQualifiedProviders=async()=>['openrouter','deepseek','deepinfra','opencode-go','ollama'].map(id=>({id,label:id,
        requiresApiKey:id!=='ollama',catalog:{status:'fresh',fetchedAt:'2026-10-15T00:00:00Z'},
        routes:[{id:`${id}/text`,modelId:'text',label:'Text model',enabled:true,qualification:'unverified',capabilities:{tools:null}},
          {id:`${id}/image`,modelId:'image',label:'Image model',enabled:false,selectable:false,unavailableReason:'This model does not provide text conversation.'}]}));
    });
    await page.locator('.more-models').click();
    for(const provider of ['openrouter','deepseek','deepinfra','opencode-go','ollama']){
      await page.locator('#credential-provider').selectOption(provider);
      assert.equal(await page.locator('#refresh-models').isEnabled(),true);
      assert.equal(await page.locator(`#credential-model option[value="${provider}/image"]`).isDisabled(),true);
      assert.equal(await page.locator(`#enabled-models input[value="${provider}/image"]`).isDisabled(),true);
      assert.match(await page.locator('#enabled-models').innerText(),/Not live-tested/);
    }
    assert.equal(await page.evaluate(()=>window.__runs.length),0);
  });
});

for (const handshake of ['pending', 'rejected']) {
  test(`native ${handshake} handshake blocks synthetic preview submissions`, async () => {
    await renderer({ready: true, docker: 'available'}, async page => {
      await page.locator('#composer-input').fill('Read project documentation');
      const count = await page.locator('.user-message').count();
      await page.keyboard.press('Control+Enter');
      await page.locator('#composer-form').evaluate(form => form.requestSubmit());
      assert.equal(await page.locator('.user-message').count(), count);
      assert.equal(await page.locator('#send-button').isDisabled(), true);
      assert.equal(await page.evaluate(() => window.__runs.length), 0);
      if (handshake === 'pending') {
        await page.evaluate(() => window.__resolveInfo());
        await page.waitForFunction(()=>!document.querySelector('#send-button').disabled);
        assert.equal(await page.evaluate(()=>window.__runs.length),0);
      }
    }, handshake);
  });
}

test('refreshing diagnostics after connection revokes renderer execution admission', async () => {
  await renderer({ready: true, docker: 'available'}, async page => {
    await connect(page);
    await page.evaluate(() => {window.__info.diagnostics = {ready: false, docker: 'unavailable'};});
    await page.locator('#preview-badge').click();
    await page.locator('#dialog [data-action="refresh-diagnostics"]').click();
    await page.waitForFunction(() => document.querySelector('#send-button').disabled);
    await page.locator('#dialog [data-action="close-dialog"]').click();
    await blockedSubmissions(page);
  });
});
