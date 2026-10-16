// Runs the actual development Electron main/preload/renderer against a non-inference child fixture.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {_electron} from 'playwright';
import {saveProviderRoute} from '../native/provider-routing.mjs';

test('actual Electron close choice backgrounds the same child, reopens, and stops on explicit quit',{
  skip:!process.env.BABEL_TEST_ELECTRON_EXECUTABLE,
  timeout:45000,
},async()=>{
  const root=await mkdtemp(join(tmpdir(),'babel-close-electron-'));
  let application;
  try{
    const project=join(root,'project'),profile=join(root,'profile'),config=join(profile,'engine','config'),entry=join(root,'fixture.mjs');
    await mkdir(project);await mkdir(config,{recursive:true});
    await writeFile(join(project,'README.md'),'Synthetic project fixture');
    const receipt=join(root,'cancel-receipt.txt'),started=join(root,'start-receipt.txt');
    await writeFile(entry,`if(process.argv.length===3&&process.argv[2]==='--desktop-capabilities'){console.log(JSON.stringify({schemaVersion:1,credentialEnvironment:'native-resolved-v1'}));process.exit(0);}
import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(started)},'started');process.stdout.write(JSON.stringify({type:'run_start'})+'\\n');
const timer=setInterval(()=>process.stdout.write(JSON.stringify({type:'thought',line:'owned child still running'})+'\\n'),200);
process.stdin.on('data',data=>{if(data.toString().includes('cancel')){clearInterval(timer);setTimeout(()=>{writeFileSync(${JSON.stringify(receipt)},'cancel settled');process.stdout.write(JSON.stringify({type:'cancelled'})+'\\n');process.exit(0);},300);}});
setTimeout(()=>process.exit(2),30000).unref();`);
    await writeFile(join(profile,'ui-connection.json'),JSON.stringify({projectRoot:project,cliEntry:entry}));
    const bootstrap=join(root,'bootstrap.cjs');
    await writeFile(bootstrap,`const {app,dialog}=require('electron');dialog.showErrorBox=(title,message)=>{console.error(title+': '+message);app.quit();};import(${JSON.stringify(new URL('../native/main.mjs',import.meta.url).href)}).catch(error=>{console.error(error);app.quit();});`);
    saveProviderRoute({configDirectory:config,provider:'openrouter',model:'deepseek-v4-pro-openrouter'});
    const env={};
    for(const name of ['PATH','SystemRoot','WINDIR','TEMP','TMP','LOCALAPPDATA','APPDATA','USERPROFILE','HOME','COMSPEC','PATHEXT'])if(process.env[name])env[name]=process.env[name];
    env.BABEL_RUNS_DIR=join(profile,'engine','state','runs');
    application=await _electron.launch({executablePath:process.env.BABEL_TEST_ELECTRON_EXECUTABLE,args:[bootstrap,`--profile-dir=${profile}`],env,timeout:20000});
    const page=await application.firstWindow();
    await application.evaluate(({dialog,Menu})=>{
      globalThis.__dialogs=[];
      dialog.showMessageBox=async(_window,options)=>{globalThis.__dialogs.push(options.title);return {response:1,checkboxChecked:false};};
      const original=Menu.buildFromTemplate;
      Menu.buildFromTemplate=template=>{globalThis.__trayTemplate=template;return original.call(Menu,template);};
    });
    assert.equal(await page.evaluate(async()=>{try{await window.babelDesktop.readFile('README.md');return 'allowed';}catch{return 'denied';}}),'denied');
    const authority=await page.evaluate(()=>window.babelDesktop.trustProject());
    assert.equal(authority.projectAuthority.trusted,true);
    const cancelledRemote=await page.evaluate(async()=>{
      const start=window.babelDesktop.startRemoteBridge({port:4549}).then(()=>false,error=>/cancel/i.test(error.message));
      await window.babelDesktop.stopRemoteBridge();return start;
    });
    assert.equal(cancelledRemote,true);
    await assert.rejects(()=>readFile(started),{code:'ENOENT'});
    const cancelledAdmission=await page.evaluate(async()=>{const start=window.babelDesktop.run({runId:'cancel-during-admission',task:'Never launch this fixture',mode:'chat'});await window.babelDesktop.cancel();return start;});
    assert.equal(cancelledAdmission.started,false);
    await assert.rejects(()=>readFile(started),{code:'ENOENT'});
    await page.reload();
    await page.waitForFunction(()=>!document.querySelector('#send-button').disabled);
    await page.locator('#composer-input').fill('Synthetic lifecycle fixture; no inference');
    await page.locator('#composer-form').evaluate(form=>form.requestSubmit());
    await page.waitForFunction(()=>document.querySelector('#main-status').textContent==='Running');
    await page.waitForFunction(()=>document.querySelector('#conversation').textContent.includes('owned child still running'));
    assert.deepEqual(await application.evaluate(()=>globalThis.__dialogs),['Trust this project?'],'trusted runs need no second start popup');
    await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].close());
    await assertEventually(async()=>application.evaluate(({BrowserWindow})=>!BrowserWindow.getAllWindows()[0].isVisible()));
    assert.equal(await page.locator('#main-status').innerText(),'Running');
    await application.evaluate(({app})=>app.emit('second-instance'));
    assert.equal(await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isVisible()),true);
    await page.waitForFunction(()=>document.querySelector('#conversation').textContent.includes('owned child still running'));
    await page.evaluate(()=>window.babelDesktop.cancel());
    await page.waitForFunction(()=>!document.querySelector('#send-button').disabled);
    await application.evaluate(()=>{globalThis.__staleQuit=globalThis.__trayTemplate.find(item=>item.label==='Quit Babel').click;});
    await writeFile(receipt,'');
    await page.locator('#composer-input').fill('Second synthetic run');
    await page.locator('#composer-form').evaluate(form=>form.requestSubmit());
    await page.waitForFunction(()=>document.querySelector('#main-status').textContent==='Running');
    await assertEventually(async()=>application.evaluate(()=>globalThis.__trayTemplate.find(item=>item.label==='Stop work and quit').enabled));
    assert.equal(await application.evaluate(()=>globalThis.__trayTemplate.find(item=>item.label==='Quit Babel').enabled),false);
    await application.evaluate(()=>globalThis.__staleQuit());
    assert.equal(await page.locator('#main-status').innerText(),'Running');
    const revoked=await page.evaluate(()=>window.babelDesktop.revokeProjectTrust());
    assert.equal(revoked.projectAuthority.trusted,false);
    await assertEventually(async()=>readFile(receipt,'utf8').then(text=>text==='cancel settled'));
    assert.equal(await page.evaluate(async()=>{try{await window.babelDesktop.run({runId:'revoked-run',mode:'chat',task:'Must be denied'});return 'allowed';}catch{return 'denied';}}),'denied');
    await assertEventually(async()=>page.evaluate(async()=>{try{return (await window.babelDesktop.trustProject()).projectAuthority.trusted;}catch{return false;}}));
    await page.reload();
    await page.waitForFunction(()=>!document.querySelector('#send-button').disabled);
    await writeFile(receipt,'');
    await page.locator('#composer-input').fill('Third synthetic run after explicit regrant');
    await page.locator('#composer-form').evaluate(form=>form.requestSubmit());
    await page.waitForFunction(()=>document.querySelector('#main-status').textContent==='Running');
    await page.waitForFunction(()=>document.querySelector('#conversation').textContent.includes('owned child still running'));
    await page.evaluate(()=>{
      window.__draftPreparations=0;
      // Veto only the final flush after the first cancellation, exercising
      // the real native acknowledgement boundary without a disk fault claim.
      window.babelDesktop.onPrepareDraftClose(token=>{if(++window.__draftPreparations===2)void window.babelDesktop.completeDraftClose({token,saved:false});});
    });
    await application.evaluate(({dialog})=>{
      globalThis.__draftSaveWarnings=0;
      globalThis.__activeClosePrompts=0;
      dialog.showMessageBox=async(_window,options)=>{
        if(options.title==='Drafts are not saved'){globalThis.__draftSaveWarnings++;return {response:0,checkboxChecked:false};}
        if(options.title==='Active Babel work')globalThis.__activeClosePrompts++;
        return {response:2,checkboxChecked:false};
      };
    });
    await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].close());
    await assertEventually(()=>application.evaluate(()=>globalThis.__draftSaveWarnings===1));
    await page.waitForFunction(()=>!document.querySelector('#send-button').disabled);
    assert.equal(await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isVisible()),true);
    await writeFile(receipt,'');
    await page.locator('#composer-input').fill('Fourth synthetic run after declining the final draft close');
    await page.locator('#composer-form').evaluate(form=>form.requestSubmit());
    await page.waitForFunction(()=>document.querySelector('#main-status').textContent==='Running');
    await page.waitForFunction(()=>!document.querySelector('#composer-input').disabled);
    await page.locator('#conversation .assistant-message').last().filter({hasText:'owned child still running'}).waitFor();
    const closed=application.waitForEvent('close',{timeout:10000});
    await application.evaluate(({BrowserWindow})=>{const window=BrowserWindow.getAllWindows()[0];window.close();setTimeout(()=>{if(!window.isDestroyed())window.close();},10);});
    try{await closed;}catch{
      assert.fail(JSON.stringify({warnings:await application.evaluate(()=>globalThis.__draftSaveWarnings),prompts:await application.evaluate(()=>globalThis.__activeClosePrompts),preparations:await page.evaluate(()=>window.__draftPreparations),status:await page.locator('#main-status').innerText()}));
    }
    assert.equal(await readFile(receipt,'utf8'),'cancel settled');
  }finally{
    if(application){
      const page=application.windows()[0];
      await page?.evaluate(()=>window.babelDesktop?.cancel()).catch(()=>{});
      await page?.waitForFunction(()=>!document.querySelector('#send-button').disabled,null,{timeout:3000}).catch(()=>{});
      // Test teardown cannot choose Keep working and leak the isolated fixture after a failed assertion.
      await application.evaluate(({app})=>app.exit(0)).catch(()=>{});
      await application.close().catch(()=>{});
    }
    await rm(root,{recursive:true,force:true});
  }
});

async function assertEventually(check){
  for(let attempt=0;attempt<40;attempt++){if(await check())return;await new Promise(resolve=>setTimeout(resolve,50));}
  assert.fail('Electron did not enter the expected lifecycle state');
}

test('actual Electron continues project-free Chat and restores rich retained history',{
  skip:!process.env.BABEL_TEST_ELECTRON_EXECUTABLE,timeout:30000,
},async t=>{
  const root=await mkdtemp(join(tmpdir(),'babel-conversation-electron-'));
  let application,phase='setup';
  try{
    const profile=join(root,'profile'),config=join(profile,'engine','config'),entry=join(root,'fixture.mjs'),receipt=join(root,'scope.json');
    await mkdir(config,{recursive:true});
    const archive=join(profile,'engine','state','runs','chat-sessions','rich-archive');
    await mkdir(archive,{recursive:true});
    const archiveBase={archive_source:'thread_events',thread_id:'rich-archive',turn_id:'rich-turn',route:{provider:'fixture-provider',model:'fixture-model',source:'turn_started'}};
    const history=[
      {...archiveBase,role:'user',archive_kind:'user_message',source_event_id:'rich-user',content:'Retained rich fixture'},
      {...archiveBase,role:'assistant',archive_kind:'assistant_message',name:'working_state',source_event_id:'rich-context',content:'Internal retained context'},
      {...archiveBase,role:'assistant',archive_kind:'model_candidate',source_event_id:'rich-candidate',content:'Unaccepted model proposal'},
      {...archiveBase,role:'assistant',archive_kind:'assistant_tool_calls',source_event_id:'rich-calls',content:'',tool_calls:[{id:'missing',type:'function',function:{name:'list_dir',arguments:'{}'}}]},
      {...archiveBase,role:'tool',archive_kind:'tool_result',source_event_id:'rich-result',name:'read_file',tool_call_id:'denied',exit_code:1,content:'PROJECT_REQUIRED'},
      {...archiveBase,role:'assistant',archive_kind:'terminal_response',source_event_id:'rich-terminal',content:'Choose a project first.',terminal_outcome:'BLOCKED_POLICY'},
    ];
    await writeFile(join(archive,'transcript.jsonl'),history.map(JSON.stringify).join('\n')+'\n');
    await writeFile(entry,`if(process.argv.length===3&&process.argv[2]==='--desktop-capabilities'){console.log(JSON.stringify({schemaVersion:1,credentialEnvironment:'native-resolved-v1'}));process.exit(0);}
import {writeFileSync} from 'node:fs';
const args=process.argv;
writeFileSync(${JSON.stringify(receipt)},JSON.stringify({conversation:args[args.indexOf('--execution-scope')+1]==='conversation',projectFlag:args.includes('--project-root'),projectEnvironment:['BABEL_PROJECT_ROOT','BABEL_ALLOWED_ROOTS','BABEL_PROJECT_CREDENTIALS_DIR'].some(name=>process.env[name]!==undefined),launchDirectory:process.cwd()===${JSON.stringify(profile)},resumeId:args.includes('--resume-chat')?args[args.indexOf('--resume-chat')+1]:null}));
process.stdout.write(JSON.stringify({type:'assistant_chunk',chunk:'Hello without a project.'})+'\\n');
process.stdout.write(JSON.stringify({type:'run_complete',result:{session_id:'conversation-fixture',terminal_outcome:'NO_CHANGE_REQUIRED',answer:{answer:'Hello without a project.'}}})+'\\n');`);
    await writeFile(join(profile,'ui-connection.json'),JSON.stringify({cliEntry:entry}));
    const bootstrap=join(root,'bootstrap.cjs');
    await writeFile(bootstrap,`const {app,dialog}=require('electron');dialog.showErrorBox=()=>app.exit(2);import(${JSON.stringify(new URL('../native/main.mjs',import.meta.url).href)}).catch(()=>app.exit(2));`);
    saveProviderRoute({configDirectory:config,provider:'openrouter',model:'deepseek-v4-pro-openrouter'});
    const env={};
    for(const name of ['PATH','SystemRoot','WINDIR','TEMP','TMP','LOCALAPPDATA','APPDATA','USERPROFILE','HOME','COMSPEC','PATHEXT'])if(process.env[name])env[name]=process.env[name];
    env.BABEL_RUNS_DIR=join(profile,'engine','state','runs');
    application=await _electron.launch({executablePath:process.env.BABEL_TEST_ELECTRON_EXECUTABLE,args:[bootstrap,`--profile-dir=${profile}`],env,timeout:20000});
    const page=await application.firstWindow();
    page.setDefaultTimeout(7000);
    phase='ready';
    await application.evaluate(({dialog})=>{globalThis.__dialogs=[];dialog.showMessageBox=async(_window,options)=>{globalThis.__dialogs.push(options.title);return {response:0,checkboxChecked:false};};});
    await page.waitForFunction(()=>!document.querySelector('#send-button').disabled);
    const info=await page.evaluate(()=>window.babelDesktop.getInfo());
    assert.equal(info.projectRoot,null);assert.equal(info.projectAuthority.scope,'conversation');assert.equal(info.ready,true);assert.equal(info.diagnostics,null);
    assert.equal(await page.evaluate(async()=>{try{await window.babelDesktop.readFile('README.md');return 'allowed';}catch{return 'denied';}}),'denied');
    assert.equal(await page.locator('[data-action="mode"][data-mode="plan"]').first().isDisabled(),true);
    await page.locator('#composer-input').fill('Hello, with no project selected');
    await page.locator('#composer-form').evaluate(form=>form.requestSubmit());
    phase='first-response';
    await page.waitForFunction(()=>document.querySelector('#conversation').textContent.includes('Hello without a project.')&&!document.querySelector('#send-button').disabled);
    assert.deepEqual(JSON.parse(await readFile(receipt,'utf8')),{conversation:true,projectFlag:false,projectEnvironment:false,launchDirectory:true,resumeId:null});
    await page.locator('#composer-input').fill('Continue the same conversation');
    await page.locator('#composer-form').evaluate(form=>form.requestSubmit());
    phase='second-response';
    await assertEventually(async()=>JSON.parse(await readFile(receipt,'utf8')).resumeId==='conversation-fixture');
    await page.waitForFunction(()=>!document.querySelector('#send-button').disabled);
    assert.deepEqual(JSON.parse(await readFile(receipt,'utf8')),{conversation:true,projectFlag:false,projectEnvironment:false,launchDirectory:true,resumeId:'conversation-fixture'});
    phase='archive-button';
    await page.locator('#sessions .session-button').filter({hasText:'Retained rich fixture'}).click();
    phase='archive-terminal';
    await page.locator('#conversation [data-source-event-id="rich-terminal"]').waitFor();
    assert.equal(await page.locator('#conversation .tool-row.unverified').count(),1);
    assert.equal(await page.locator('#conversation .tool-row.failed').count(),1);
    assert.equal(await page.locator('#conversation .thought-note[open]').count(),0);
    assert.match(await page.locator('#conversation').innerText(),/Retained context/);
    assert.match(await page.locator('#conversation').innerText(),/Selected route · fixture-provider \/ fixture-model/);
    assert.equal(await page.locator('#conversation [data-source-event-id="rich-terminal"] .message-status').innerText(),'Approval or environment action required');
    assert.deepEqual(await application.evaluate(()=>globalThis.__dialogs),[]);
    phase='draft-close';
    await page.locator('#composer-input').fill('Unsent draft retained by the real Electron profile');
    const closed=application.waitForEvent('close',{timeout:10000});
    await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].close());
    await closed;
    phase='draft-restart';
    application=await _electron.launch({executablePath:process.env.BABEL_TEST_ELECTRON_EXECUTABLE,args:[bootstrap,`--profile-dir=${profile}`],env,timeout:20000});
    const reopened=await application.firstWindow();reopened.setDefaultTimeout(7000);
    await reopened.waitForFunction(()=>!document.querySelector('#send-button').disabled);
    await reopened.locator('#sessions .session-button').filter({hasText:'Retained rich fixture'}).click();
    assert.equal(await reopened.locator('#composer-input').inputValue(),'Unsent draft retained by the real Electron profile');
    assert.equal((await reopened.evaluate(()=>window.babelDesktop.readComposerDrafts())).drafts.find(draft=>draft.sessionId==='rich-archive').text,'Unsent draft retained by the real Electron profile');
  }catch(error){t.diagnostic(JSON.stringify({phase}));throw error;}finally{
    if(application){await application.evaluate(({app})=>app.exit(0)).catch(()=>{});await application.close().catch(()=>{});}
    await rm(root,{recursive:true,force:true});
  }
});
