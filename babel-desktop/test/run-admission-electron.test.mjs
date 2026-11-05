// Real Electron main/preload IPC with a synthetic, credential-free child.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rename,rm} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {_electron} from 'playwright';
import {saveProviderRoute} from '../native/provider-routing.mjs';

test('an admitted submission cannot replay after exit, renderer reload, or application restart',{
  skip:!process.env.BABEL_TEST_ELECTRON_EXECUTABLE,timeout:60000,
},async()=>{
  const root=await mkdtemp(join(tmpdir(),'babel-run-replay-'));
  let application;
  const profile=join(root,'profile'),project=join(root,'project'),config=join(profile,'engine','config');
  const receipt=join(root,'starts.txt'),entry=join(root,'fixture.mjs'),bootstrap=join(root,'bootstrap.cjs');
  const env={};
  for(const name of ['PATH','SystemRoot','WINDIR','TEMP','TMP','LOCALAPPDATA','APPDATA','USERPROFILE','HOME','COMSPEC','PATHEXT','DISPLAY','XAUTHORITY'])if(process.env[name])env[name]=process.env[name];
  const launch=async()=>{
    application=await _electron.launch({executablePath:process.env.BABEL_TEST_ELECTRON_EXECUTABLE,args:[bootstrap,`--profile-dir=${profile}`],env,timeout:20000});
    const page=await application.firstWindow();
    await page.waitForFunction(()=>!!window.babelDesktop);
    await application.evaluate(({dialog})=>{dialog.showMessageBox=async(_window,options)=>{
      if(options.title!=='Trust this project?')throw new Error(`Unexpected dialog: ${options.title}`);
      return {response:1};
    };});
    return page;
  };
  const submit=async(page,runId)=>{
    await page.evaluate(()=>{window.__childExited=false;window.babelDesktop.onEvent(packet=>{if(packet.kind==='exit')window.__childExited=true;});});
    const result=await page.evaluate(runId=>window.babelDesktop.run({runId,task:'Synthetic receipt only; no inference.',mode:'chat'}),runId);
    if(result.started)await page.waitForFunction(()=>window.__childExited);
    return result;
  };
  try{
    await mkdir(project);await mkdir(config,{recursive:true});
    await writeFile(entry,`if(process.argv.includes('--desktop-capabilities')){console.log(JSON.stringify({schemaVersion:1,credentialEnvironment:'native-resolved-v1'}));process.exit(0);}const {appendFileSync}=await import('node:fs');appendFileSync(${JSON.stringify(receipt)},process.env.BABEL_DESKTOP_RUN_ID+'\\n');console.log(JSON.stringify({type:'run_complete',result:{terminal_outcome:'COMPLETE'}}));`);
    await writeFile(join(profile,'ui-connection.json'),JSON.stringify({projectRoot:project,cliEntry:entry}));
    saveProviderRoute({configDirectory:config,provider:'openrouter',model:'deepseek-v4-pro-openrouter'});
    // The remote lane below uses a bridge double; local launches use the real child.
    await writeFile(bootstrap,`const {app,dialog}=require('electron');dialog.showErrorBox=(title,message)=>{console.error(title+': '+message);app.exit(1);};
Promise.all([import(${JSON.stringify(new URL('../native/run-admission.mjs',import.meta.url).href)}),import(${JSON.stringify(new URL('../native/remoteHost.mjs',import.meta.url).href)})]).then(async([{RunAdmissionLedger},{RemoteBridgeChild}])=>{
globalThis.__claimReached=new Promise(resolve=>{globalThis.__markClaimReached=resolve;});
const claim=RunAdmissionLedger.prototype.claim;RunAdmissionLedger.prototype.claim=async function(id){const result=await claim.call(this,id);if(globalThis.__holdClaim){globalThis.__markClaimReached();await new Promise(resolve=>{globalThis.__releaseClaim=resolve;});}return result;};
RemoteBridgeChild.prototype.start=async function(){Object.defineProperties(this,{state:{get:()=>this.__stopped?'stopped':'ready'},running:{get:()=>!this.__stopped},sharedSession:{value:true},port:{value:4545},desktopClientId:{value:'synthetic-client'},desktopProofKey:{value:'synthetic-proof'}});return {started:true};};
RemoteBridgeChild.prototype.stop=function(){this.__stopped=true;};RemoteBridgeChild.prototype.waitForOwnedChildExit=async function(){};
await import(${JSON.stringify(new URL('../native/main.mjs',import.meta.url).href)});}).catch(error=>{console.error(error);app.exit(1);});`);
    let page=await launch();
    await assert.rejects(()=>submit(page,'untrusted'),/trust/i);
    await page.evaluate(()=>window.babelDesktop.trustProject());
    assert.equal((await submit(page,'same-submission')).started,true);
    assert.deepEqual(await submit(page,'same-submission'),{started:false,reason:'run_already_admitted'});
    await page.reload();await page.waitForFunction(()=>!!window.babelDesktop);
    assert.deepEqual(await submit(page,'same-submission'),{started:false,reason:'run_already_admitted'});
    await application.close();application=null;
    page=await launch();
    assert.deepEqual(await submit(page,'same-submission'),{started:false,reason:'run_already_admitted'});
    assert.equal((await submit(page,'next-submission')).started,true,'a distinct task remains usable');
    await page.evaluate(()=>window.babelDesktop.revokeProjectTrust());
    await assert.rejects(()=>submit(page,'revoked'),/trust/i);
    await page.evaluate(()=>window.babelDesktop.trustProject());
    await application.evaluate(()=>{globalThis.__holdClaim=true;globalThis.__claimReached=new Promise(resolve=>{globalThis.__markClaimReached=resolve;});});
    const swapped=page.evaluate(()=>window.babelDesktop.run({runId:'replaced-project',task:'Never launch in a replacement directory',mode:'chat'})).then(value=>({value}),error=>({error:String(error)}));
    await application.evaluate(()=>globalThis.__claimReached);
    const saved=join(root,'saved-project'),replacement=join(root,'replacement-project');
    for(const path of [project,saved,replacement])assert.equal(dirname(resolve(path)),resolve(root),'moves must stay inside the owned fixture');
    await rename(project,saved);await mkdir(project);
    await application.evaluate(()=>globalThis.__releaseClaim());
    assert.match((await swapped).error??'',/trust|identity/i,'physical identity replacement during persistence must prevent launch');
    assert.equal(await readFile(receipt,'utf8'),'same-submission\nnext-submission\n');
    await rename(project,replacement);await rename(saved,project);
    await application.evaluate(()=>{globalThis.__holdClaim=false;});
    await page.evaluate(()=>window.babelDesktop.startRemoteBridge({port:4545}));
    await application.evaluate(()=>{globalThis.__holdClaim=true;globalThis.__claimReached=new Promise(resolve=>{globalThis.__markClaimReached=resolve;});});
    const pending=page.evaluate(()=>window.babelDesktop.run({runId:'stopped-bridge',task:'Never launch after remote stop',mode:'chat'}));
    await application.evaluate(()=>globalThis.__claimReached);
    await page.evaluate(()=>window.babelDesktop.stopRemoteBridge());
    await application.evaluate(()=>globalThis.__releaseClaim());
    assert.deepEqual(await pending,{started:false},'stopping the bridge during persistence fences launch');
    assert.equal(await readFile(receipt,'utf8'),'same-submission\nnext-submission\n');
  }finally{
    if(application){await application.evaluate(({app})=>app.exit(0)).catch(()=>{});await application.close().catch(()=>{});}
    await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  }
});
