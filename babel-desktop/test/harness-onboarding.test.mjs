// License: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {chromium} from 'playwright';
const html = readFileSync(new URL('../dist/index.html', import.meta.url), 'utf8');

test('first project onboarding loads its files and switching roots starts a new CLI chat',async()=>{
  const browser=await chromium.launch({headless:true});
  try{
    const page=await browser.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.evaluate(()=>{
      window.__root=null;window.__nextRoot='project-a';window.__runs=[];
      const info=()=>({packaged:true,ready:Boolean(window.__root),projectName:window.__root,projectRoot:window.__root?`C:/${window.__root}`:null,diagnostics:{ready:true}});
      window.babelDesktop={getInfo:async()=>info(),refreshDiagnostics:async()=>info(),
        chooseProject:async()=>{window.__root=window.__nextRoot;return info();},listDirectory:async()=>[{name:`${window.__root}-only.txt`,type:'file'}],listSessions:async()=>({sessions:[]}),
        readProviderRoute:async()=>({provider:'openrouter',model:'fixture-route'}),listQualifiedProviders:async()=>[{id:'openrouter',label:'OpenRouter',requiresApiKey:true,routes:[{id:'fixture-route',label:'Fixture route'}]}],
        saveProviderRoute:async()=>({route:{provider:'openrouter',model:'fixture-route'},credentialUpdated:false}),onEvent:callback=>window.__emit=callback,
        run:async request=>{window.__runs.push(request);return {started:true};}};
    });
    await page.setContent(html);await page.locator('#dialog [data-action="open-project"]').click();
    await page.locator('#project-tree [data-path="project-a-only.txt"]').waitFor({timeout:1500});
    await page.locator('#dialog [data-action="configure-provider"]').click();await page.getByRole('button',{name:'Save provider',exact:true}).click();
    await page.locator('#dialog').waitFor({state:'hidden'});await page.locator('#composer-input').fill('Task A');await page.keyboard.press('Control+Enter');
    await page.waitForFunction(()=>window.__runs.length===1);
    await page.evaluate(()=>{const runId=window.__runs[0].runId;window.__emit({runId,kind:'event',event:{type:'run_complete',result:{session_id:'project-a-session',terminal_outcome:'VERIFIED_COMPLETE'}}});window.__emit({runId,kind:'exit',code:0});window.__nextRoot='project-b';});
    await page.locator('#preview-badge').click();await page.locator('#dialog [data-action="open-project"]').click();
    await page.locator('#project-tree [data-path="project-b-only.txt"]').waitFor({timeout:1500});
    assert.equal(await page.locator('#project-tree [data-path="project-a-only.txt"]').count(),0);
    await page.locator('#dialog [data-action="close-dialog"]').click();await page.locator('#composer-input').fill('Task B');await page.keyboard.press('Control+Enter');
    await page.waitForFunction(()=>window.__runs.length===2);
    assert.equal(await page.evaluate(()=>window.__runs[1].sessionId),undefined);
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});

test('native startup is a real harness and provider save makes the selected route usable', async () => {
  const browser = await chromium.launch({headless:true});
  try {
    const page = await browser.newPage({viewport:{width:1280,height:800}});
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.evaluate(() => {
      window.__runs=[]; window.__saved=null;
      window.babelDesktop={
        getInfo:async()=>({packaged:true,ready:true,officialCliReady:true,projectName:'test-project',diagnostics:{ready:true,node:'ready',resources:'ready',provider:'configured',docker:'available'}}),
        refreshDiagnostics:async()=>window.babelDesktop.getInfo(),
        listDirectory:async()=>[{name:'README.md',type:'file'}],listSessions:async()=>({sessions:[],total:0}),
        listQualifiedProviders:async()=>[{id:'openrouter',label:'OpenRouter',requiresApiKey:true,routes:[{id:'openrouter/model-a',label:'Model A',enabled:true},{id:'openrouter/model-b',label:'Model B',enabled:true}]}],
        readProviderRoute:async()=>window.__saved?.route??{provider:'openrouter',model:'openrouter/model-a'},
        saveProviderRoute:async options=>(window.__saved={options,route:{provider:options.provider,model:options.model},credentialUpdated:false}),
        run:async request=>{window.__runs.push(request);return {started:false};},
        onEvent(){},onUpdateEvent(){},
      };
    });
    await page.setContent(html);
    await page.waitForFunction(()=>document.querySelector('#preview-badge').textContent==='BABEL CLI');
    await page.locator('#send-button').waitFor();
    await page.waitForFunction(()=>!document.querySelector('#send-button').disabled);
    assert.equal(await page.getByText('Interactive preview · no model or tool execution',{exact:true}).count(),0);
    assert.equal(await page.locator('#top-context').innerText(),'—');
    assert.equal(await page.getByRole('switch').count(),0);
    await page.locator('[data-action="models"]').click();
    await page.getByLabel('Default model',{exact:true}).selectOption('openrouter/model-b');
    await page.getByRole('button',{name:'Save provider',exact:true}).click();
    await page.locator('#dialog').waitFor({state:'hidden'});
    await page.locator('#composer-input').fill('Read README.md and answer hello.');
    await page.keyboard.press('Control+Enter');
    assert.deepEqual(errors,[]);
    await page.waitForFunction(()=>window.__runs.length===1);
    const request=await page.evaluate(()=>window.__runs[0]);
    assert.equal(request.model,'openrouter/model-b');
    assert.equal(request.mode,'chat');
    assert.deepEqual(await page.evaluate(()=>window.__saved.options.enabledModels),['openrouter/model-a','openrouter/model-b']);
  } finally {await browser.close();}
});

test('native missing project explains setup without any simulated conversation or model choices', async () => {
  const browser = await chromium.launch({headless:true});
  try {
    const page=await browser.newPage();
    await page.evaluate(()=>{window.babelDesktop={getInfo:async()=>({packaged:true,ready:false,officialCliReady:true,projectName:null,diagnostics:{ready:true}}),listSessions:async()=>({sessions:[]}),readProviderRoute:async()=>null,onEvent(){}};});
    await page.setContent(html);
    await page.waitForFunction(()=>document.querySelector('#preview-badge').textContent==='BABEL CLI');
    assert.equal(await page.locator('#send-button').isDisabled(),true);
    assert.equal(await page.locator('.reference-answer').count(),0);
    await page.locator('#status-detail').filter({hasText:/project/i}).waitFor();
    assert.match(await page.locator('#status-detail').innerText(),/project/i);
    assert.equal(await page.getByText('gpt-5.6-sol',{exact:true}).count(),0);
  } finally {await browser.close();}
});

test('a real CLI terminal review result renders safely and releases the composer on exit',async()=>{
  const browser=await chromium.launch({headless:true});
  try {
    const page=await browser.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.evaluate(()=>{
      window.babelDesktop={getInfo:async()=>({packaged:true,ready:true,officialCliReady:true,projectName:'fixture',diagnostics:{ready:true}}),listDirectory:async()=>[],listSessions:async()=>({sessions:[]}),readProviderRoute:async()=>({provider:'openrouter',model:'fixture-route'}),onEvent:callback=>{window.__emit=callback;},run:async request=>{window.__run=request.runId;return {started:true};}};
    });
    await page.setContent(html);await page.waitForFunction(()=>!document.querySelector('#send-button').disabled);
    await page.locator('#composer-input').fill('Review README.md');await page.keyboard.press('Control+Enter');
    await page.waitForFunction(()=>Boolean(window.__run));
    await page.keyboard.press('Control+Alt+n');
    assert.equal(await page.locator('.session-button').count(),1,'A running response must stay visible in its original session');
    assert.equal(await page.locator('.user-message').count(),1);
    await page.evaluate(()=>window.__emit({runId:window.__run,kind:'event',event:{type:'run_complete',result:{terminal_outcome:'VERIFIED_COMPLETE',answer:'Reviewed the file.',critic_receipt:{verdict:'PASS',reasons:['No unresolved defects in this fixture.']}}}}));
    await page.evaluate(()=>window.__emit({runId:window.__run,kind:'exit',code:0}));
    assert.deepEqual(errors,[]);
    assert.match(await page.locator('#conversation').innerText(),/No unresolved defects/);
    assert.equal(await page.locator('#send-button').isEnabled(),true);
  } finally {await browser.close();}
});
