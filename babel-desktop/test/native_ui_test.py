"""Renderer integration with an explicit native API test double, not Electron or a real model."""
import json, os, shutil
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
ROOT=Path(__file__).resolve().parents[1]

def check_manual_models(page):
    page.evaluate('''() => {
      window.__manualSaves=[];
      window.babelDesktop.listQualifiedProviders=async()=>[
        {id:'openrouter',label:'OpenRouter',requiresApiKey:true,manualModels:true,routes:[]},
        {id:'command-code',label:'Command Code',requiresApiKey:true,manualModels:true,catalogRefresh:false,routes:[]}
      ];
      window.babelDesktop.readProviderRoute=async()=>({provider:'openrouter',model:'openrouter/vendor/saved'});
      window.babelDesktop.refreshDiagnostics=async()=>({cliName:'index.js',projectName:'fixture-project',ready:true});
      window.babelDesktop.saveProviderRoute=async options=>{
        window.__manualSaves.push(options);
        return {route:{provider:options.provider,model:options.model},credentialUpdated:false};
      };
    }''')
    for provider in ['openrouter','command-code']:
        page.locator('[data-action="settings"]').click()
        page.locator('[data-action="configure-provider"]').click()
        page.locator('#credential-provider').select_option(provider)
        page.locator('#credential-model-source').select_option('manual')
        assert page.locator('#manual-model-fields').is_visible()
        assert 'Unverified model' in page.locator('#manual-model-fields').inner_text()
        assert page.locator('#credential-model').is_disabled()
        page.locator('#credential-manual-model').fill('Vendor/Unlisted-Case')
        page.locator('[data-action="save-provider-credential"]').click()
        page.locator('#dialog').wait_for(state='hidden')
        saved=page.evaluate('window.__manualSaves.at(-1)')
        assert saved['provider']==provider
        assert saved['model']==provider+'/Vendor/Unlisted-Case'
        assert saved['manualModelId']=='Vendor/Unlisted-Case'
        assert saved['model'] in saved['enabledModels']
        assert saved['apiKey']==''
    return 'manual ID UI submits exact provider-bound unverified routes without a credential value'

def main():
    checks=[]; errors=[]
    with sync_playwright() as p:
        browser=p.chromium.launch(executable_path=os.environ.get('CHROMIUM_EXECUTABLE') or shutil.which('chromium'),headless=True,args=['--no-sandbox'])
        page=browser.new_page(viewport={'width':1536,'height':1024})
        page.on('pageerror',lambda error:errors.append(str(error)))
        page.evaluate('''() => {
          window.__requests=[];
          window.babelDesktop={
            getInfo:async()=>({cliName:'index.js',projectName:'fixture-project',ready:true}),
            readProviderRoute:async()=>({provider:'openrouter',model:'fixture-route'}),
            listDirectory:async()=>[{name:'README.md',type:'file'}],
            readFile:async()=>({text:'<script>not executable</script>',truncated:false}),
            onEvent:callback=>{window.__emit=callback;},
            run:async request=>{window.__requests.push(request);return {started:true};},
            openRepository:async()=>{}
          };
        }''')
        page.set_content((ROOT/'dist/index.html').read_text())
        page.wait_for_function("document.querySelector('#preview-badge').textContent === 'BABEL CLI'")
        assert page.locator('#preview-badge').inner_text()=='BABEL CLI'
        assert page.locator('.reference-answer').count()==0
        assert page.locator('#context-value').inner_text()=='—'
        assert page.locator('.model-option').count()==1
        assert page.locator('.model-option').inner_text()=='openrouter · fixture-route'
        assert page.locator('[role="switch"]').count()==0
        checks.append('live mode removes fixtures and leaves unreported telemetry unknown')
        page.locator('[data-action="file"]').click()
        assert '<script>not executable</script>' in page.locator('#dialog-content').inner_text()
        assert page.locator('#dialog-content script').count()==0
        page.keyboard.press('Escape')
        checks.append('native file content is escaped as text')
        def send(task):
            page.locator('#composer-input').fill(task)
            page.keyboard.press('Control+Enter')
            return page.evaluate('window.__requests.at(-1).runId')
        def emit(run_id,**fields):page.evaluate('p=>window.__emit(p)',{'runId':run_id,**fields})
        run_id=send('Read project documentation')
        assert page.evaluate('window.__requests.at(-1).mode')=='chat'
        emit('stale-run',kind='event',event={'type':'assistant_chunk','chunk':'SHOULD NOT APPEAR'})
        emit(run_id,kind='event',event={'type':'assistant_chunk','chunk':'Streamed fixture text.'})
        assert 'SHOULD NOT APPEAR' not in page.locator('#conversation').inner_text()
        expect(page.locator('#conversation')).to_contain_text('Streamed fixture text.')
        emit(run_id,kind='event',event={'type':'run_complete','result':{}})
        assert page.locator('#main-status').inner_text()=='Finishing'
        assert page.locator('#send-button').is_disabled()
        emit(run_id,kind='exit',code=0)
        assert page.locator('#main-status').inner_text()=='Unverified'
        checks.append('stream routing is run-bound and zero exit does not fabricate verification')
        run_id=send('Second fixture')
        emit(run_id,kind='event',event={'type':'run_complete','result':{'terminal_outcome':'VERIFIED_COMPLETE'}})
        emit(run_id,kind='exit',code=1)
        assert page.locator('#main-status').inner_text()=='Failed'
        checks.append('abnormal process exit overrides an apparent successful terminal event')
        run_id=send('Third fixture')
        emit(run_id,kind='transport-error',error='Malformed fixture event')
        emit(run_id,kind='event',event={'type':'run_complete','result':{'terminal_outcome':'VERIFIED_COMPLETE'}})
        emit(run_id,kind='exit',code=0)
        assert page.locator('#main-status').inner_text()=='Unverified'
        checks.append('incomplete event stream cannot report verified completion')
        page.evaluate('''() => {
          window.babelDesktop.listQualifiedProviders = async () => ([
            {id:'deepseek',label:'DeepSeek',requiresApiKey:true,local:false,routes:[{id:'deepseek-v4-pro',label:'deepseek-v4-pro'}]},
            {id:'ollama',label:'Ollama',requiresApiKey:false,local:true,routes:[{id:'deepseek-v4-flash',label:'local flash'}]}
          ]);
          window.babelDesktop.readProviderRoute = async () => ({provider:'deepseek',model:'deepseek-v4-pro'});
          window.babelDesktop.saveProviderRoute = async () => ({route:{provider:'deepseek',model:'deepseek-v4-pro'},credentialUpdated:false});
          window.babelDesktop.listSessions = async (options) => ({
            sessions:[{id:'chat-1',title:'One',messages:3},{id:'chat-2',title:'Two',messages:1}],
            total:4, offset:(options&&options.offset)||0, limit:(options&&options.limit)||30
          });
          window.babelDesktop.openSession = async (sessionId, options) => ({
            id:sessionId,
            messages:[{role:'user',text:'hello'},{role:'assistant',text:'world',status:'unverified'}],
            history:{totalMessages:2,hasOlder:false,olderOffset:(options&&options.olderOffset)||0,messageLimit:150}
          });
        }''')
        page.locator('[data-action="settings"]').click()
        page.locator('[data-action="configure-provider"]').click()
        assert 'PROVIDERS AND MODELS' in page.locator('#dialog-title').inner_text()
        page.locator('#dialog [data-action="close-dialog"].button').click()
        assert page.locator('#dialog').is_hidden()
        checks.append('provider dialog can cancel without saving')
        checks.append(check_manual_models(page))
        page.evaluate('''() => {
          window.__sessionCalls = [];
          window.__openCalls = [];
          window.babelDesktop={
            getInfo:async()=>({cliName:'index.js',projectName:'fixture-project',ready:true}),
            listDirectory:async()=>[{name:'README.md',type:'file'}],
            readFile:async()=>({text:'',truncated:false}),
            onEvent:()=>{},
            run:async()=>({started:true}),
            openRepository:async()=>{}
          };
          const makeMessages = (olderOffset) => {
            const total = 160;
            const end = Math.max(0, total - olderOffset);
            const start = Math.max(0, end - 150);
            const messages = [];
            for (let i = start; i < end; i += 1) {
              const label = `m-${String(i).padStart(3, '0')}`;
              messages.push({role: i % 2 === 0 ? 'user' : 'assistant', text: label, status: 'unverified'});
            }
            return {messages, history:{totalMessages:total, hasOlder:start>0, olderOffset, messageLimit:150}};
          };
          window.babelDesktop.listSessions = async (options) => {
            window.__sessionCalls.push(options||{});
            const offset = options?.offset||0;
            const batch = offset===0
              ? [{id:'chat-paged',title:'Paged chat',messages:160}]
              : [{id:'chat-extra',title:'Extra chat',messages:2}];
            return {sessions:batch,total:2,offset,limit:30};
          };
          window.babelDesktop.openSession = async (sessionId, options) => {
            const olderOffset = (options&&options.olderOffset)||0;
            window.__openCalls.push({sessionId, olderOffset});
            const payload = makeMessages(olderOffset);
            return {id:sessionId, ...payload};
          };
          window.babelDesktop.readProviderRoute = async () => ({provider:'deepseek',model:'deepseek-v4-pro'});
        }''')
        page.set_content((ROOT/'dist/index.html').read_text())
        page.wait_for_function("document.querySelector('#preview-badge').textContent === 'BABEL CLI'")
        page.locator('button.session-button[data-action="session"]', has_text='Paged chat').click()
        conv = page.locator('#conversation')
        expect(conv).to_contain_text('m-159')
        expect(conv).not_to_contain_text('m-009')
        page.locator('[data-action="load-older-messages"]').click()
        expect(conv).to_contain_text('m-009')
        expect(conv).not_to_contain_text('m-159')
        page.locator('[data-action="load-latest-messages"]').click()
        expect(conv).to_contain_text('m-159')
        page.locator('[data-action="load-older-messages"]').click()
        expect(conv).to_contain_text('m-009')
        page.locator('button.session-button[data-action="session"]', has_text='Paged chat').click()
        # Session selection restores the retained reading window; Latest is explicit.
        expect(conv).to_contain_text('m-009')
        expect(conv).not_to_contain_text('m-159')
        assert page.evaluate('window.__openCalls.at(-1).olderOffset') == 150
        page.locator('[data-action="load-latest-messages"]').click()
        expect(conv).to_contain_text('m-159')
        assert page.evaluate('window.__openCalls.at(-1).olderOffset') == 0
        page.locator('#show-more').click()
        assert page.evaluate('window.__sessionCalls.some(call => call.offset === 1)') is True
        assert page.locator('#show-more').is_visible()
        assert 'Show less' in page.locator('#show-more').inner_text()
        checks.append('saved-chat paging retains the reading window and returns to latest on explicit request')
        assert not errors,errors
        browser.close()
    report={'passed':len(checks),'basis':'Native API test double; not a real Babel or Electron execution','checks':checks,'errors':errors}
    (ROOT/'artifacts/native-ui-test-results.json').write_text(json.dumps(report,indent=2))
    print(json.dumps(report,indent=2))

def manual_models_only():
    errors=[]
    with sync_playwright() as p:
        browser=p.chromium.launch(executable_path=os.environ.get('CHROMIUM_EXECUTABLE') or shutil.which('chromium'),headless=True,args=['--no-sandbox'])
        page=browser.new_page(viewport={'width':1536,'height':1024})
        page.on('pageerror',lambda error:errors.append(str(error)))
        page.evaluate("""() => { window.babelDesktop={
          getInfo:async()=>({cliName:'index.js',projectName:'fixture-project',ready:true}),
          readProviderRoute:async()=>({provider:'openrouter',model:'fixture-route'}),
          listDirectory:async()=>[],onEvent:()=>{},run:async()=>({started:true})
        }; }""")
        page.set_content((ROOT/'dist/index.html').read_text())
        page.wait_for_function("() => document.querySelector('#preview-badge').textContent === 'BABEL CLI'")
        check=check_manual_models(page)
        assert not errors,errors
        browser.close()
    report={'passed':1,'basis':'Chromium renderer with native API double; no Electron or provider execution','checks':[check],'errors':errors}
    print(json.dumps(report,indent=2))

if __name__=='__main__':
    import sys
    manual_models_only() if '--manual-models-only' in sys.argv else main()
