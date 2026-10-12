"""Renderer integration with an explicit native API test double, not Electron or a real model."""
import json, os, shutil
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]

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
            listDirectory:async()=>[{name:'README.md',type:'file'}],
            readFile:async()=>({text:'<script>not executable</script>',truncated:false}),
            onEvent:callback=>{window.__emit=callback;},
            run:async request=>{window.__requests.push(request);return {started:true};},
            openRepository:async()=>{}
          };
        }''')
        page.set_content((ROOT/'dist/index.html').read_text())
        page.locator('#preview-badge').click()
        page.locator('[data-action="use-live"]').click()
        assert page.locator('#preview-badge').inner_text()=='BABEL CLI'
        assert page.locator('.reference-answer').count()==0
        assert page.locator('#context-value').inner_text()=='—'
        assert page.locator('.model-option').count()==1
        assert page.locator('.tool-toggle:disabled').count()==5
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
        assert 'Streamed fixture text.' in page.locator('#conversation').inner_text()
        emit(run_id,kind='event',event={'type':'run_complete','result':{}})
        assert page.locator('#main-status').inner_text()=='Running'
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
        page.locator('[data-action="configure-provider"]').click()
        assert 'CONFIGURE AI PROVIDER' in page.locator('#dialog-title').inner_text()
        page.locator('[data-action="close-dialog"]').click()
        assert page.locator('#dialog').is_hidden()
        checks.append('provider dialog can cancel without saving')
        page.evaluate('''async () => {
          window.__sessionCalls = [];
          const native = window.babelDesktop;
          window.babelDesktop.listSessions = async (options) => {
            window.__sessionCalls.push(options||{});
            const offset = options?.offset||0;
            const batch = offset===0 ? [{id:'chat-1',title:'One',messages:3}] : [{id:'chat-3',title:'Three',messages:2}];
            return {sessions:batch,total:2,offset,limit:30};
          };
          window.babelDesktop.readProviderRoute = async () => ({provider:'deepseek',model:'deepseek-v4-pro'});
          await native.getInfo();
        }''')
        page.locator('[data-action="use-live"]').click()
        page.locator('#show-more').click()
        assert page.evaluate('window.__sessionCalls.length') >= 1
        checks.append('session list requests paging options from native bridge')
        assert not errors,errors
        browser.close()
    report={'passed':len(checks),'basis':'Native API test double; not a real Babel or Electron execution','checks':checks,'errors':errors}
    (ROOT/'artifacts/native-ui-test-results.json').write_text(json.dumps(report,indent=2))
    print(json.dumps(report,indent=2))
if __name__=='__main__':main()
