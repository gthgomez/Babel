// License: Apache-2.0
// Built renderer with a narrow native double; separate Electron fixture proves OS storage.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {chromium} from 'playwright';
const html=readFileSync(new URL('../dist/index.html',import.meta.url),'utf8');
test('credential dialog clears transient input, binds explicit lifecycle changes, and preserves composer drafts',async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE});
 try{
  const page=await browser.newPage();page.setDefaultTimeout(7000);
  await page.evaluate(()=>{
    window.__credential={configured:false,legacy:false};window.__receipts=[];
    const info={ready:true,officialCliReady:true,projectRoot:null,projectName:null,diagnostics:{ready:true}};
    window.babelDesktop={getInfo:async()=>info,refreshDiagnostics:async()=>info,listSessions:async()=>({sessions:[]}),listDirectory:async()=>[],onEvent(){},readProviderRoute:async()=>({provider:'deepseek',model:'deepseek-v4-pro'}),
      listQualifiedProviders:async()=>[{id:'deepseek',label:'DeepSeek',requiresApiKey:true,routes:[{id:'deepseek-v4-pro',modelId:'deepseek-v4-pro',label:'Pro',enabled:true}]}],
      providerCredentialStatus:async()=>({configured:window.__credential.configured,storage:window.__credential.legacy?'legacy-plaintext':window.__credential.configured?'os-protected':'none',migrationAvailable:window.__credential.legacy,protectionAvailable:true,binding:'fixture-binding'}),
      saveProviderRoute:async request=>{window.__receipts.push({action:request.credentialOperation,cleared:document.querySelector('#credential-key').value==='',scope:request.scope,bound:request.binding==='fixture-binding',keyPresent:request.apiKey.length>8});window.__credential.configured=true;return {route:{provider:request.provider,model:request.model},credentialUpdated:true};},
      removeProviderCredential:async request=>{window.__receipts.push({action:'remove',cleared:document.querySelector('#credential-key').value==='',scope:request.scope,bound:request.binding==='fixture-binding'});window.__credential.configured=false;},
      migrateProviderCredential:async request=>{if(!request.confirm)throw new Error('Confirm recovery retention.');window.__receipts.push({action:'migrate',bound:request.binding==='fixture-binding',confirm:request.confirm});window.__credential.legacy=false;window.__credential.configured=true;},
    };
  });
  await page.setContent(html);await page.waitForFunction(()=>document.querySelector('#preview-badge').textContent==='BABEL CLI');
  if(await page.locator('#dialog[open]').count())await page.locator('[data-action="use-live"]').click();
  await page.locator('#composer-input').fill('Retain this unsent composer text');
  const open=async()=>{await page.locator('.more-models').click();await page.waitForFunction(()=>document.querySelector('#credential-scope')?.dataset.binding==='fixture-binding');};
  await open();await page.locator('#credential-key').fill('BabelRendererSyntheticFixture0000');await page.locator('[data-action="save-provider-credential"]').click();await page.locator('#dialog').waitFor({state:'hidden'});
  await open();assert.equal(await page.locator('#credential-operation').inputValue(),'replace');await page.locator('#credential-key').fill('BabelRendererReplacementFixture0000');await page.locator('[data-action="save-provider-credential"]').click();await page.locator('#dialog').waitFor({state:'hidden'});
  await open();await page.locator('#credential-key').fill('BabelRendererDiscardedFixture0000');await page.locator('#remove-provider-key').click();await page.waitForFunction(()=>window.__receipts.some(receipt=>receipt.action==='remove'));
  await page.getByRole('button',{name:'Cancel',exact:true}).click();
  await page.evaluate(()=>{window.__credential.legacy=true;window.__credential.configured=true;});
  await open();await page.locator('#migrate-provider-key').click();assert.match(await page.locator('#provider-error').innerText(),/Confirm recovery/);
  await page.locator('#credential-retain-recovery').check();await page.locator('#migrate-provider-key').click();await page.waitForFunction(()=>window.__receipts.some(receipt=>receipt.action==='migrate'));
  assert.equal(await page.locator('#composer-input').inputValue(),'Retain this unsent composer text');
  assert.deepEqual(await page.evaluate(()=>window.__receipts),[{action:'add',cleared:true,scope:'private',bound:true,keyPresent:true},{action:'replace',cleared:true,scope:'private',bound:true,keyPresent:true},{action:'remove',cleared:true,scope:'private',bound:true},{action:'migrate',bound:true,confirm:true}]);
 }finally{await browser.close();}
});
