// Real development Electron shell with a synthetic, non-inference CLI child.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {_electron} from 'playwright';
import {saveProviderRoute} from '../native/provider-routing.mjs';

test('native renderer distinguishes a read-only plan and shows terminal errors after partial output',{
 skip:!process.env.BABEL_TEST_ELECTRON_EXECUTABLE,timeout:45000,
},async()=>{
 const root=await mkdtemp(join(tmpdir(),'babel-plan-result-'));let app;
 try{
  const project=join(root,'project'),profile=join(root,'profile'),config=join(profile,'engine','config'),entry=join(root,'fixture.mjs');
  await mkdir(project);await mkdir(config,{recursive:true});await writeFile(join(project,'calc.js'),'export const value=1;');
  await writeFile(entry,`if(process.argv.includes('--desktop-capabilities')){console.log(JSON.stringify({schemaVersion:1,credentialEnvironment:'native-resolved-v1'}));process.exit(0);}
const fail=process.argv.at(-1)==='Failure fixture';
const emit=event=>process.stdout.write(JSON.stringify(event)+'\\n');emit({type:'run_start'});
if(fail){emit({type:'assistant_chunk',chunk:'Analyzing your request…'});emit({type:'run_complete',result:{user_status:'failed',errors:['The requested plan cannot be produced.']}});process.exitCode=1;}
else emit({type:'run_complete',result:{command:'plan',status:'PLAN_READY',changed_files:[],answer:{answer:'Inspect calc.js, decide validation semantics, then test before implementation.'}}});`);
  await writeFile(join(profile,'ui-connection.json'),JSON.stringify({projectRoot:project,cliEntry:entry}));
  const bootstrap=join(root,'bootstrap.cjs');
  await writeFile(bootstrap,`const {app}=require('electron');import(${JSON.stringify(new URL('../native/main.mjs',import.meta.url).href)}).catch(error=>{console.error(error);app.quit();});`);
  saveProviderRoute({configDirectory:config,provider:'openrouter',model:'glm-5.3-flash'});
  const env={};for(const key of ['PATH','SystemRoot','WINDIR','TEMP','TMP','LOCALAPPDATA','APPDATA','USERPROFILE','HOME','COMSPEC','PATHEXT','DISPLAY','XAUTHORITY'])if(process.env[key])env[key]=process.env[key];
  env.BABEL_RUNS_DIR=join(profile,'engine','state','runs');
  app=await _electron.launch({executablePath:process.env.BABEL_TEST_ELECTRON_EXECUTABLE,args:[bootstrap,`--profile-dir=${profile}`],env,timeout:20000});
  let page=await app.firstWindow();await app.evaluate(({dialog})=>{dialog.showMessageBox=async()=>({response:1});});
  await page.evaluate(()=>window.babelDesktop.trustProject());await page.reload();await page.waitForFunction(()=>!document.querySelector('#send-button').disabled);
  await page.locator('.top-tab[data-mode="plan"]').click();await page.locator('#composer-input').fill('Read-only plan fixture');await page.locator('#composer-form').evaluate(form=>form.requestSubmit());
  await page.waitForFunction(()=>document.querySelector('#conversation').textContent.includes('Inspect calc.js'));
  await page.waitForFunction(()=>!document.querySelector('#send-button').disabled);
  assert.equal(await page.locator('#main-status').innerText(),'Plan ready');
  assert.match(await page.locator('#conversation').innerText(),/Inspect calc.js/);
  await page.locator('[data-action="new-session"]').first().click();await page.locator('#composer-input').fill('Failure fixture');await page.locator('#composer-form').evaluate(form=>form.requestSubmit());
  await page.waitForFunction(()=>document.querySelector('#main-status').textContent==='Failed');
  assert.match(await page.locator('#conversation').innerText(),/Analyzing your request…[\s\S]*The requested plan cannot be produced\./);
 }finally{if(app)await app.close();await rm(root,{recursive:true,force:true});}
});
