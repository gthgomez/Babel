// License: Apache-2.0 — see LICENSE
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {chromium} from 'playwright';

const html=readFileSync(new URL('../dist/index.html',import.meta.url),'utf8');

test('a saved route with a missing key keeps the draft and blocks Send',async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE});
  try{
    const page=await browser.newPage();
    await page.evaluate(()=>{
      const info={ready:true,officialCliReady:true,projectRoot:null,projectName:null,
        projectAuthority:{scope:'conversation',identity:null,trusted:false},
        connection:{state:'credential_missing',provider:'openrouter'},diagnostics:{ready:true}};
      window.babelDesktop={getInfo:async()=>info,refreshDiagnostics:async()=>info,listSessions:async()=>({sessions:[]}),
        listDirectory:async()=>[],onEvent(){},readProviderRoute:async()=>({provider:'openrouter',model:'openrouter/fixture'}),
        listQualifiedProviders:async()=>[{id:'openrouter',label:'OpenRouter',requiresApiKey:true,
          routes:[{id:'openrouter/fixture',modelId:'fixture',label:'Fixture',enabled:true}]}]};
    });
    await page.setContent(html);
    await page.waitForFunction(()=>document.querySelector('#preview-badge').textContent==='BABEL CLI');
    await page.locator('#composer-input').fill('Keep this draft');
    assert.equal(await page.locator('#send-button').isDisabled(),true);
    assert.match(await page.locator('#status-detail').innerText(),/key|credential/i);
    assert.equal(await page.locator('#composer-input').inputValue(),'Keep this draft');
  }finally{await browser.close();}
});

test('unavailable OS credential protection blocks Send with a repair message',async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE});
  try{
    const page=await browser.newPage();
    await page.evaluate(()=>{
      const info={ready:true,officialCliReady:true,projectRoot:null,projectName:null,
        projectAuthority:{scope:'conversation',identity:null,trusted:false},
        connection:{state:'credential_unavailable',provider:'openrouter',model:'openrouter/fixture'}};
      window.babelDesktop={getInfo:async()=>info,listSessions:async()=>({sessions:[]}),listDirectory:async()=>[],onEvent(){},
        readProviderRoute:async()=>({provider:'openrouter',model:'openrouter/fixture'}),listQualifiedProviders:async()=>[]};
    });
    await page.setContent(html);
    await page.waitForFunction(()=>document.querySelector('#status-detail').textContent.includes('OS-protected'));
    assert.equal(await page.locator('#send-button').isDisabled(),true);
  }finally{await browser.close();}
});

test('packaged host-native chat allows the composer before optional diagnostics',async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE});
  try{
    const page=await browser.newPage();
    await page.evaluate(()=>{
      const info={ready:true,packaged:true,officialCliReady:true,projectRoot:'C:\\fixture',projectName:'fixture',
        projectAuthority:{scope:'project',identity:'fixture',trusted:true},
        engine:{executionProfile:'host_native'},connection:{state:'configured_unverified',provider:'openrouter',model:'openrouter/fixture'},diagnostics:null};
      window.babelDesktop={getInfo:async()=>info,refreshDiagnostics:async()=>info,listSessions:async()=>({sessions:[]}),
        listDirectory:async()=>[],onEvent(){},readProviderRoute:async()=>({provider:'openrouter',model:'openrouter/fixture'}),
        listQualifiedProviders:async()=>[{id:'openrouter',label:'OpenRouter',requiresApiKey:true,
          routes:[{id:'openrouter/fixture',modelId:'fixture',label:'Fixture',enabled:true}]}]};
    });
    await page.setContent(html);
    await page.waitForFunction(()=>document.querySelector('#preview-badge').textContent==='BABEL CLI');
    assert.equal(await page.locator('#send-button').isDisabled(),false);
    assert.match(await page.locator('#main-status').innerText(),/unverified/i);
  }finally{await browser.close();}
});

test('slow workspace preparation does not block chat or overwrite the next project',async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE});
  try{
    const page=await browser.newPage();
    await page.evaluate(()=>{
      let root='a';
      const info=()=>({ready:true,officialCliReady:true,projectRoot:`C:/${root}`,projectName:root,
        projectAuthority:{scope:'project',identity:root,trusted:true},connection:{state:'configured_unverified',provider:'openrouter',model:'openrouter/fixture'}});
      window.babelDesktop={getInfo:async()=>info(),onEvent(){},
        chooseProject:async()=>{root='b';return info();},
        readProviderRoute:async()=>({provider:'openrouter',model:'openrouter/fixture'}),
        listQualifiedProviders:async()=>[{id:'openrouter',routes:[{id:'openrouter/fixture',label:'Fixture'}]}],
        listDirectory:async()=>root==='a'?new Promise(resolve=>window.__oldTree=resolve):[{name:'new.txt',type:'file'}],
        listSessions:async()=>root==='a'?new Promise(resolve=>window.__oldSessions=resolve):({sessions:[{id:'new-session',title:'New project chat'}]})};
    });
    await page.setContent(html);
    await page.waitForFunction(()=>!document.querySelector('#send-button').disabled,null,{timeout:2000});
    await page.locator('#composer-input').fill('Keep typing');
    await page.locator('#preview-badge').click();
    await page.locator('#dialog [data-action="open-project"]').click();
    await page.locator('#project-tree [data-path="new.txt"]').waitFor({timeout:2000});
    await page.getByRole('button',{name:'New project chat'}).waitFor({timeout:2000});
    await page.evaluate(()=>{window.__oldTree([{name:'old.txt',type:'file'}]);window.__oldSessions({sessions:[{id:'old-session',title:'Old project chat'}]});});
    await page.waitForTimeout(50);
    assert.equal(await page.locator('#project-tree [data-path="old.txt"]').count(),0);
    assert.equal(await page.getByRole('button',{name:'Old project chat'}).count(),0);
  }finally{await browser.close();}
});

test('a pending project listing cannot reappear after trust is revoked',async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE});
  try{
    const page=await browser.newPage();
    await page.evaluate(()=>{
      let info={ready:true,officialCliReady:true,projectRoot:'C:/fixture',projectName:'fixture',
        projectAuthority:{scope:'project',identity:'fixture',trusted:true},connection:{state:'configured_unverified',provider:'openrouter',model:'openrouter/fixture'}};
      window.babelDesktop={getInfo:async()=>info,onEvent(){},listSessions:async()=>({sessions:[]}),
        listDirectory:async()=>new Promise(resolve=>window.__lateTree=resolve),
        readProviderRoute:async()=>({provider:'openrouter',model:'openrouter/fixture'}),listQualifiedProviders:async()=>[],
        revokeProjectTrust:async()=>{info={...info,ready:false,projectAuthority:{...info.projectAuthority,trusted:false}};return info;}};
    });
    await page.setContent(html);await page.waitForFunction(()=>!document.querySelector('#send-button').disabled);
    await page.locator('#preview-badge').click();await page.locator('#dialog [data-action="revoke-trust"]').click();
    await page.locator('#dialog [data-action="trust-project"]').waitFor();
    await page.evaluate(()=>window.__lateTree([{name:'stale.txt',type:'file'}]));await page.waitForTimeout(50);
    assert.equal(await page.locator('#project-tree [data-path="stale.txt"]').count(),0);
  }finally{await browser.close();}
});

test('missing readiness information cannot be presented as a usable connection',async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE});
  try{
    const page=await browser.newPage();
    await page.evaluate(()=>{
      const info={ready:true,officialCliReady:true,projectRoot:null,projectName:null,
        projectAuthority:{scope:'conversation',identity:null,trusted:false},diagnostics:{ready:true}};
      window.babelDesktop={getInfo:async()=>info,refreshDiagnostics:async()=>info,listSessions:async()=>({sessions:[]}),
        listDirectory:async()=>[],onEvent(){},readProviderRoute:async()=>({provider:'openrouter',model:'openrouter/fixture'}),
        listQualifiedProviders:async()=>[{id:'openrouter',label:'OpenRouter',requiresApiKey:true,
          routes:[{id:'openrouter/fixture',modelId:'fixture',label:'Fixture',enabled:true}]}]};
    });
    await page.setContent(html);
    await page.waitForFunction(()=>document.querySelector('#preview-badge').textContent==='BABEL CLI');
    assert.equal(await page.locator('#send-button').isDisabled(),true);
    assert.match(await page.locator('#status-detail').innerText(),/connection status.*unavailable/i);
  }finally{await browser.close();}
});

test('readiness for an old route cannot enable a different selected route',async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE});
  try{
    const page=await browser.newPage();
    await page.evaluate(()=>{
      const info={ready:true,officialCliReady:true,projectRoot:null,projectName:null,
        projectAuthority:{scope:'conversation',identity:null,trusted:false},
        connection:{state:'configured_unverified',provider:'openrouter',model:'openrouter/old'}};
      window.babelDesktop={getInfo:async()=>info,listSessions:async()=>({sessions:[]}),listDirectory:async()=>[],onEvent(){},
        readProviderRoute:async()=>({provider:'command-code',model:'command-code/new'}),listQualifiedProviders:async()=>[]};
    });
    await page.setContent(html);
    await page.waitForFunction(()=>document.querySelector('#model-controls').textContent.includes('command-code'));
    assert.equal(await page.locator('#send-button').isDisabled(),true);
    assert.match(await page.locator('#status-detail').innerText(),/changed|refresh/i);
  }finally{await browser.close();}
});

test('switching to a provider without Plan support does not silently select Chat',async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE});
  try{
    const page=await browser.newPage();
    await page.evaluate(()=>{
      const info={ready:true,officialCliReady:true,projectRoot:'C:\\fixture',projectName:'fixture',
        projectAuthority:{scope:'project',identity:'fixture',trusted:true},
        connection:{state:'configured_unverified',provider:'openrouter',model:'openrouter/fixture'},diagnostics:{ready:true}};
      const providers=['openrouter','command-code'].map(id=>({id,label:id,requiresApiKey:true,
        routes:[{id:`${id}/fixture`,modelId:'fixture',label:'Fixture',enabled:true}]}));
      window.babelDesktop={getInfo:async()=>info,refreshDiagnostics:async()=>info,listSessions:async()=>({sessions:[]}),
        listDirectory:async()=>[],onEvent(){},readProviderRoute:async()=>({provider:'openrouter',model:'openrouter/fixture'}),
        listQualifiedProviders:async()=>providers,
        providerCredentialStatus:async()=>({present:true,configured:true,storage:'os-protected',ownedProtectedEntry:true,binding:'fixture',authentication:{state:'not_checked'}}),
        saveProviderRoute:async request=>{info.connection.provider=request.provider;info.connection.model=request.model;return {ok:true,route:{provider:request.provider,model:request.model},credentialChanged:false}}};
    });
    await page.setContent(html);
    await page.waitForFunction(()=>document.querySelector('#preview-badge').textContent==='BABEL CLI');
    await page.locator('#top-tabs [data-mode="plan"]').click();
    await page.locator('.more-models').click();
    await page.locator('#credential-provider').selectOption('command-code');
    await page.waitForFunction(()=>document.querySelector('#credential-scope')?.dataset.binding==='fixture');
    await page.locator('[data-action="save-provider-credential"]').click();
    await page.locator('#dialog').waitFor({state:'hidden'});
    assert.equal(await page.locator('#top-tabs [data-mode="plan"]').getAttribute('aria-pressed'),'true');
    assert.equal(await page.locator('#send-button').isDisabled(),true);
  }finally{await browser.close();}
});

test('a provider 401 offers repair and restores the task only when the user asks',async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE});
  try{
    const page=await browser.newPage();
    await page.evaluate(()=>{
      window.__requests=[];
      const info={ready:true,officialCliReady:true,projectRoot:null,projectName:null,
        projectAuthority:{scope:'conversation',identity:null,trusted:false},connection:{state:'configured_unverified',provider:'openrouter',model:'openrouter/fixture'}};
      window.babelDesktop={getInfo:async()=>info,listSessions:async()=>({sessions:[]}),listDirectory:async()=>[],
        readProviderRoute:async()=>({provider:'openrouter',model:'openrouter/fixture'}),
        listQualifiedProviders:async()=>[{id:'openrouter',routes:[{id:'openrouter/fixture',modelId:'fixture',label:'Fixture',enabled:true}]}],
        onEvent:callback=>window.__emit=callback,run:async request=>{window.__requests.push(request);return {started:true}}};
    });
    await page.setContent(html);await page.waitForFunction(()=>!document.querySelector('#send-button').disabled);
    await page.locator('#composer-input').fill('Explain the fixture');await page.locator('#composer-form').evaluate(form=>form.requestSubmit());
    await page.waitForFunction(()=>window.__requests.length===1);
    await page.evaluate(()=>{const runId=window.__requests[0].runId;window.__emit({runId,kind:'event',event:{type:'run_error',error:'[openrouter] HTTP 401 (fixture)'}});window.__emit({runId,kind:'exit',code:1});});
    assert.match(await page.locator('#conversation').innerText(),/provider settings/i);
    await page.getByRole('button',{name:'Restore task',exact:true}).click();
    assert.equal(await page.locator('#composer-input').inputValue(),'Explain the fixture');
    assert.equal(await page.evaluate(()=>window.__requests.length),1);
  }finally{await browser.close();}
});

test('an unreadable protected key preserves the task when native admission fails',async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE});
  try{
    const page=await browser.newPage();
    await page.evaluate(()=>{
      const info={ready:true,officialCliReady:true,projectRoot:null,projectName:null,
        projectAuthority:{scope:'conversation',identity:null,trusted:false},connection:{state:'configured_unverified',provider:'openrouter',model:'openrouter/fixture'}};
      window.babelDesktop={getInfo:async()=>info,listSessions:async()=>({sessions:[]}),listDirectory:async()=>[],onEvent(){},
        readProviderRoute:async()=>({provider:'openrouter',model:'openrouter/fixture'}),listQualifiedProviders:async()=>[],
        run:async()=>{throw new Error('OS-protected credential could not be unlocked. No changes were made.')}};
    });
    await page.setContent(html);await page.waitForFunction(()=>!document.querySelector('#send-button').disabled);
    await page.locator('#composer-input').fill('Keep this task');await page.locator('#composer-form').evaluate(form=>form.requestSubmit());
    await page.getByText(/could not be unlocked/i).first().waitFor();
    assert.equal(await page.locator('#composer-input').inputValue(),'Keep this task');
    assert.match(await page.locator('#conversation').innerText(),/unlock.*provider settings/i);
  }finally{await browser.close();}
});
