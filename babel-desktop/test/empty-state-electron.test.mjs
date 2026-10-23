// License: Apache-2.0
// Actual Electron main, preload and renderer; an owned child fixture never invokes a provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,access,rm} from 'node:fs/promises';
import {join,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {_electron} from 'playwright';
import electronExecutable from 'electron';
import {saveProviderRoute} from '../native/provider-routing.mjs';

for(const [width,height] of [[1440,900],[960,700]])test(`Electron empty guidance follows project trust and selection without reload or inference (${width}x${height})`,{timeout:60000},async()=>{
  const root=await mkdtemp(join(tmpdir(),'babel-empty-state-'));
  let application;
  try{
    const project=join(root,'project one'),second=join(root,'project two'),profile=join(root,'profile'),config=join(profile,'engine','config'),entry=join(root,'fixture.mjs'),receipt=join(root,'unexpected-run');
    await mkdir(project);await mkdir(second);await mkdir(config,{recursive:true});
    const runs=join(profile,'engine','state','runs'),archive=join(runs,'chat-sessions','chat-empty-state-history');
    await mkdir(archive,{recursive:true});
    await writeFile(join(archive,'transcript.jsonl'),Array.from({length:60},(_,index)=>JSON.stringify({role:index%2?'assistant':'user',content:index===0?'Archived fixture history':`Retained fixture message ${index}`})).join('\n')+'\n');
    for(const directory of [project,second])await writeFile(join(directory,'README.md'),'Synthetic project for empty-state verification.');
    await writeFile(entry,`if(process.argv.includes('--desktop-capabilities')){console.log(JSON.stringify({schemaVersion:1,credentialEnvironment:'native-resolved-v1'}));process.exit(0);}import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(receipt)},'unexpected execution');process.exit(1);`);
    await writeFile(join(profile,'ui-connection.json'),JSON.stringify({projectRoot:null,cliEntry:entry}));
    saveProviderRoute({configDirectory:config,provider:'openrouter',model:'deepseek-v4-pro-openrouter'});
    const bootstrap=join(root,'bootstrap.cjs');
    await writeFile(bootstrap,`const {app,dialog}=require('electron');dialog.showErrorBox=(title,message)=>{console.error(title+': '+message);app.quit();};import(${JSON.stringify(new URL('../native/main.mjs',import.meta.url).href)}).catch(error=>{console.error(error);app.quit();});`);
    const env={};
    for(const name of ['PATH','SystemRoot','WINDIR','TEMP','TMP','LOCALAPPDATA','APPDATA','USERPROFILE','HOME','COMSPEC','PATHEXT'])if(process.env[name])env[name]=process.env[name];
    env.BABEL_RUNS_DIR=runs;
    application=await _electron.launch({executablePath:process.env.BABEL_TEST_ELECTRON_EXECUTABLE??electronExecutable,args:[bootstrap,`--profile-dir=${profile}`],env,timeout:20000});
    const page=await application.firstWindow();
    await application.evaluate(({BrowserWindow},{width,height})=>BrowserWindow.getAllWindows()[0].setContentSize(width,height),{width,height});
    await page.waitForFunction(({width,height})=>innerWidth===width&&innerHeight===height,{width,height});
    await page.waitForFunction(()=>document.querySelector('#status-detail')&&!document.querySelector('#status-detail').textContent.includes('Connecting'));
    await application.evaluate(({dialog})=>{dialog.showMessageBox=async()=>({response:1,checkboxChecked:false});dialog.showOpenDialog=async()=>({canceled:false,filePaths:[globalThis.__selectedProject]});});
    const dismiss=async()=>{if(await page.locator('#dialog[open]').count())await page.keyboard.press('Escape');await page.locator('#dialog').waitFor({state:'hidden'});};
    const screenshot=async name=>{
      if(!process.env.BABEL_TEST_EVIDENCE_DIR)return;
      await mkdir(process.env.BABEL_TEST_EVIDENCE_DIR,{recursive:true});
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
      await page.screenshot({path:join(process.env.BABEL_TEST_EVIDENCE_DIR,`${name}-${width}.png`)});
    };
    await dismiss();
    assert.match(await page.locator('.empty-state').innerText(),/No project is open/);
    await screenshot('conversation-only');
    const choose=async directory=>{
      await application.evaluate((_electron,directory)=>{globalThis.__selectedProject=directory;},directory);
      await page.locator('[data-action="open-project"]').first().click();
      await page.waitForFunction(name=>document.querySelector('#dialog').open&&document.querySelector('#dialog-content').textContent.includes(name),basename(directory));
      await dismiss();
    };
    const trust=async grant=>{
      await page.locator('#preview-badge').click();
      await page.locator(`#dialog [data-action="${grant?'trust-project':'revoke-trust'}"]`).click();
      await page.locator(`#dialog [data-action="${grant?'revoke-trust':'trust-project'}"]`).waitFor();await dismiss();
    };
    await choose(project);
    assert.equal(await page.locator('.empty-actions [data-action="draft"]').count(),0);
    await screenshot('untrusted');
    await page.locator('#composer-input').fill('Retained draft before trust');
    await trust(true);
    assert.equal(await page.locator('#composer-input').inputValue(),'Retained draft before trust');
    await page.locator('.empty-actions [data-action="draft"]').click();
    assert.match(await page.locator('#composer-input').inputValue(),/^Using this repository's README and code/);
    assert.equal(await page.evaluate(()=>document.activeElement?.id),'composer-input');
    assert.equal(await page.locator('#conversation .message').count(),0);
    await screenshot('trusted-drafted');
    await trust(false);
    assert.equal(await page.locator('.empty-actions [data-action="draft"]').count(),0);
    assert.match(await page.locator('#composer-input').inputValue(),/^Using this repository's README and code/);
    await assert.rejects(()=>page.evaluate(()=>window.babelDesktop.readFile('README.md')),/trust/i);
    await assert.rejects(()=>page.evaluate(()=>window.babelDesktop.run({runId:'revoked-empty-state',mode:'chat',task:'Must be denied'})),/trust/i);
    await screenshot('revoked');
    await choose(second);
    assert.equal(await page.locator('.empty-actions [data-action="draft"]').count(),0);
    await choose(project);
    const restored=await page.evaluate(async()=>{const saved=await window.babelDesktop.readComposerDrafts();return saved.drafts.find(draft=>draft.text.startsWith("Using this repository's README and code"));});
    assert.ok(restored,'the original project retains its unsent draft');
    await page.locator(`#sessions [data-id="${restored.id}"]`).click();
    assert.match(await page.locator('#composer-input').inputValue(),/^Using this repository's README and code/);
    await page.locator('#sessions .session-button').filter({hasText:'Archived fixture history'}).click();
    await page.waitForFunction(()=>document.querySelectorAll('#conversation .message').length===60);
    await page.locator('#composer-input').fill('Draft alongside retained history');
    await page.locator('#conversation').evaluate(element=>{element.scrollTo({top:220,behavior:'instant'});window.__historyNode=element.querySelector('.message');window.__historyHtml=element.innerHTML;window.__historyTop=element.scrollTop;});
    for(const grant of [true,false]){
      await trust(grant);
      assert.equal(await page.locator('#conversation').evaluate(element=>element.querySelector('.message')===window.__historyNode&&element.innerHTML===window.__historyHtml&&element.scrollTop===window.__historyTop),true);
      assert.equal(await page.locator('#composer-input').inputValue(),'Draft alongside retained history');
    }
    assert.equal(await page.locator('#conversation').evaluate(element=>element.scrollHeight>element.clientHeight&&element.scrollTop>0),true);
    await screenshot('populated-history');
    await assert.rejects(()=>access(receipt),{code:'ENOENT'});
  }finally{if(application)await application.close();await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
});
