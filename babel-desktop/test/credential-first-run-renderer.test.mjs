// License: Apache-2.0
// First-run credential decisions in the real built renderer. The native double
// reports the same status envelope the native owner returns; no secret is sent.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {chromium} from 'playwright';
const html=readFileSync(new URL('../dist/index.html',import.meta.url),'utf8');

function fixtureScript(){
  window.__state={storage:'legacy-plaintext',ownedProtectedEntry:false,present:true,configured:true,legacyPresent:true,migrationAvailable:true,protectionAvailable:true,binding:'fixture-binding'};
  window.__calls=[];window.__auth=null;
  const status=()=>({
    provider:'openrouter',scope:'private',
    ...window.__state,
    authentication:window.__auth??{state:'not_checked',reason:'not_checked',checkedAt:null,observedRevision:null},
  });
  const info={ready:true,officialCliReady:true,projectRoot:null,projectName:null,diagnostics:{ready:true}};
  window.babelDesktop={
    getInfo:async()=>info,refreshDiagnostics:async()=>info,listSessions:async()=>({sessions:[]}),listDirectory:async()=>[],onEvent(){},
    readProviderRoute:async()=>({provider:'openrouter',model:'openrouter/fixture-model'}),
    listQualifiedProviders:async()=>[{id:'openrouter',label:'OpenRouter',requiresApiKey:true,routes:[{id:'openrouter/fixture-model',modelId:'fixture-model',label:'Fixture model',enabled:true}]}],
    providerCredentialStatus:async()=>status(),
    checkConnection:async request=>{
      window.__calls.push({action:'check',scope:request.scope,provider:request.provider});
      // Each press advances the fixture through the next real outcome.
      const queue=window.__authQueue??[];
      window.__auth=queue.length?queue.shift():{state:'authenticated',reason:'authenticated',checkedAt:'2026-11-11T20:06:00.000Z',observedRevision:'fixture-revision'};
      return {...status(),state:window.__auth.state};
    },
    saveProviderRoute:async request=>{
      window.__calls.push({action:'save',credentialOperation:request.credentialOperation,pattern:request.apiKey?'new-key':'blank',scope:request.scope});
      if(window.__rejectSave)return {ok:false,code:'credential_write_failed',safeMessage:'A legacy plaintext key exists. Choose explicitly.',retryable:true,persisted:{credential:false,modelPolicy:false,route:false,preferences:false},recoveryAction:'Choose how to continue, then retry.'};
      if(request.credentialOperation==='supersede_legacy_with_new')Object.assign(window.__state,{storage:'os-protected',ownedProtectedEntry:true,legacyPresent:true,legacySuperseded:true,migrationAvailable:false});
      return {ok:true,route:{provider:request.provider,model:request.model},credentialChanged:Boolean(request.apiKey),credentialUpdated:Boolean(request.apiKey),authState:'not_checked',persisted:{credential:true,modelPolicy:true,route:true,preferences:true}};
    },
    removeProviderCredential:async()=>{window.__state={storage:'none',ownedProtectedEntry:false,present:false,configured:false,migrationAvailable:false,protectionAvailable:true};},
    migrateProviderCredential:async()=>{},
  };
}

test('a legacy-only profile offers explicit decisions and never a silent first-run success',async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE});
  try{
    const page=await browser.newPage();
    await page.evaluate(fixtureScript);
    page.setDefaultTimeout(7000);
    await page.setContent(html);
    await page.waitForFunction(()=>document.querySelector('#preview-badge').textContent==='BABEL CLI');
    if(await page.locator('#dialog[open]').count())await page.locator('[data-action="use-live"]').click();
    await page.locator('.more-models').click();
    await page.waitForFunction(()=>document.querySelector('#credential-scope')?.dataset.binding==='fixture-binding');

    // The status must say the key is legacy and unverified, never "authenticated".
    const status=await page.locator('#credential-status').innerText();
    assert.match(status,/Legacy plaintext key found/i);
    assert.match(status,/unverified/i);
    assert.doesNotMatch(status,/Authenticated/i);

    // Add/Replace are unavailable until the user decides explicitly.
    assert.equal(await page.locator('#credential-operation').inputValue(),'supersede_legacy_with_new');
    assert.equal(await page.locator('#credential-operation option[value="add_new"]').isDisabled(),true);
    assert.equal(await page.locator('#credential-operation option[value="replace_protected"]').isDisabled(),true);
    assert.equal(await page.locator('#credential-operation option[value="continue_with_legacy"]').isDisabled(),false);
    // The hint must not invite a blank key on a legacy profile: that action needs one.
    const hint=await page.locator('#provider-key-hint').innerText();
    assert.doesNotMatch(hint,/Leave the key blank/i);
    assert.match(hint,/Enter a new key/i);

    // A rejected save surfaces the typed message and the recovery action.
    await page.evaluate(()=>{window.__rejectSave=true;});
    await page.locator('#credential-key').fill('BabelLegacyDecisionFixture0000');
    await page.locator('[data-action="save-provider-credential"]').click();
    const error=await page.locator('#provider-error').innerText();
    assert.match(error,/Choose explicitly/i);
    assert.match(error,/retry/i);
    assert.equal(await page.locator('#dialog[open]').count(),1,'A rejected save must leave the dialog open for correction.');
    // The password field is deliberately cleared on the failure path, so the user
    // must reenter the key. The dialog must say so rather than failing silently.
    assert.equal(await page.locator('#credential-key').inputValue(),'');

    // Consented supersede stores the new protected key.
    await page.evaluate(()=>{window.__rejectSave=false;});
    await page.locator('#credential-key').fill('BabelLegacyDecisionFixture0000');
    await page.locator('[data-action="save-provider-credential"]').click();
    await page.locator('#dialog').waitFor({state:'hidden'});
    const calls=await page.evaluate(()=>window.__calls);
    assert.deepEqual(calls.map(call=>call.credentialOperation),['supersede_legacy_with_new','supersede_legacy_with_new']);
    assert.equal(calls.every(call=>call.pattern==='new-key'),true);

    // Reopening shows protected storage and no legacy migration offer.
    await page.locator('.more-models').click();
    await page.waitForFunction(()=>document.querySelector('#credential-scope')?.dataset.binding==='fixture-binding');
    assert.match(await page.locator('#credential-status').innerText(),/OS-protected storage/i);
    assert.equal(await page.locator('#migrate-provider-key').isHidden(),true);
    assert.equal(await page.locator('#credential-operation option[value="add_new"]').isDisabled(),false,'Add becomes available once the legacy decision is settled.');
  }finally{await browser.close();}
});

test('a tested connection reports the exact distinction between not authorized and payment required',async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE});
  try{
    const page=await browser.newPage();
    await page.evaluate(fixtureScript);
    page.setDefaultTimeout(7000);
    await page.setContent(html);
    await page.waitForFunction(()=>document.querySelector('#preview-badge').textContent==='BABEL CLI');
    if(await page.locator('#dialog[open]').count())await page.locator('[data-action="use-live"]').click();
    await page.evaluate(()=>{Object.assign(window.__state,{storage:'os-protected',ownedProtectedEntry:true,present:true,migrationAvailable:false});window.__authQueue=[
      {state:'unauthorized',reason:'unauthorized',checkedAt:'2026-11-11T20:00:00.000Z',observedRevision:'fixture-revision'},
      {state:'payment_required',reason:'payment_required',checkedAt:'2026-11-11T20:05:00.000Z',observedRevision:'fixture-revision'},
      {state:'authenticated',reason:'authenticated',checkedAt:'2026-11-11T20:06:00.000Z',observedRevision:'fixture-revision'},
    ];});
    await page.locator('.more-models').click();
    await page.waitForFunction(()=>document.querySelector('#credential-scope')?.dataset.binding==='fixture-binding'&&!document.querySelector('#check-connection').hidden);

    const settle=async re=>{
      for(let i=0;i<80;i++){
        const text=await page.locator('#credential-status').innerText();
        if(re.test(text))return text;
        await page.waitForTimeout(100);
      }
      return page.locator('#credential-status').innerText();
    };

    await page.locator('#check-connection').click();
    const unauthorized=await settle(/Not authorized/);
    assert.match(unauthorized,/Not authorized/i);
    assert.match(unauthorized,/provider rejected this exact key/i);

    await page.locator('#check-connection').click();
    const payment=await settle(/Payment required/);
    assert.match(payment,/not a rejected key/i);

    await page.locator('#check-connection').click();
    const authenticated=await settle(/Authenticated at/);
    assert.match(authenticated,/Authenticated at 2026-11-11T20:06:00.000Z/);
    assert.match(authenticated,/not model or tool access/i);

    const calls=await page.evaluate(()=>window.__calls.filter(call=>call.action==='check'));
    assert.equal(calls.length,3,'Each explicit Test connection click performs one check.');
    assert.equal(calls.every(call=>call.scope==='private'&&call.provider==='openrouter'),true);
  }finally{await browser.close();}
});

test('a changed credential revision reports "not checked" instead of a stale rejection',async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE});
  try{
    const page=await browser.newPage();
    await page.evaluate(fixtureScript);
    page.setDefaultTimeout(7000);
    await page.setContent(html);
    await page.waitForFunction(()=>document.querySelector('#preview-badge').textContent==='BABEL CLI');
    if(await page.locator('#dialog[open]').count())await page.locator('[data-action="use-live"]').click();
    await page.evaluate(()=>{
      Object.assign(window.__state,{storage:'os-protected',ownedProtectedEntry:true,present:true,migrationAvailable:false});
      window.__auth={state:'not_checked',reason:'credential_changed',checkedAt:'2026-11-11T19:00:00.000Z',observedRevision:'previous-revision'};
    });
    await page.locator('.more-models').click();
    await page.waitForFunction(()=>document.querySelector('#credential-scope')?.dataset.binding==='fixture-binding');
    const status=await page.locator('#credential-status').innerText();
    assert.match(status,/Not checked since the key changed/i);
    assert.doesNotMatch(status,/Not authorized/i);
  }finally{await browser.close();}
});
