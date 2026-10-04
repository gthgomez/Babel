"""Browser-level acceptance for the offline preview. Requires Playwright + Chromium."""
from pathlib import Path
import json
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / 'artifacts'
ARTIFACTS.mkdir(exist_ok=True)

def main():
    checks=[]
    errors=[]
    with sync_playwright() as p:
        import os, shutil
        exe = os.environ.get('CHROMIUM_EXECUTABLE') or shutil.which('chromium')
        browser=p.chromium.launch(executable_path=exe,headless=True,args=['--no-sandbox'])
        page=browser.new_page(viewport={'width':1536,'height':1024},device_scale_factor=1)
        page.on('pageerror',lambda error:errors.append(str(error)))
        # The execution environment blocks browser navigation, so render the
        # exact built document offline. A storage double tests reload serialization.
        html=(ROOT/'dist/index.html').read_text()
        page.evaluate("Object.defineProperty(window,'localStorage',{value:{data:{},getItem(k){return this.data[k]??null},setItem(k,v){this.data[k]=String(v)},removeItem(k){delete this.data[k]}}})")
        page.set_content(html)
        page.wait_for_selector('.reference-answer')
        page.screenshot(path=str(ARTIFACTS/'Babel-Desktop-1536x1024.png'),full_page=True)
        assert page.locator('.left-panel').is_visible()
        assert page.locator('.right-panel').is_visible()
        assert page.locator('.result-card').count()==2
        assert page.locator('.tool-row').count()==4
        assert page.locator('#preview-badge').inner_text()=='REFERENCE PREVIEW'
        assert page.locator('#main-status').inner_text()=='Preview'
        checks.append('reference structure and explicit preview status')
        layout=page.evaluate('''() => Object.fromEntries(['.topbar','.left-panel','.center-panel','.right-panel','.bottom-bar','.composer','.conversation','.result-card'].map(s=>{let r=document.querySelector(s).getBoundingClientRect();return [s,{x:r.x,y:r.y,width:r.width,height:r.height}]}))''')
        (ARTIFACTS/'layout.json').write_text(json.dumps(layout,indent=2))
        assert abs(layout['.topbar']['height']-72)<1
        assert abs(layout['.left-panel']['width']-268)<1
        checks.append('reference column and header geometry')
        page.locator('.top-tab[data-mode="plan"]').click()
        assert page.locator('.mode-option[data-mode="plan"]').get_attribute('aria-pressed')=='true'
        page.locator('.mode-option[data-mode="deep"]').click()
        assert page.locator('.top-tab[data-mode="deep"]').get_attribute('aria-pressed')=='true'
        page.keyboard.press('Alt+1')
        assert page.locator('.top-tab[data-mode="chat"]').get_attribute('aria-pressed')=='true'
        checks.append('synchronized modes and keyboard shortcuts')
        page.locator('.model-option').nth(3).click()
        assert page.locator('#top-model').inner_text()=='deepseek-v4'
        page.locator('.model-option').first.click()
        checks.append('model selection updates header')
        page.locator('.tool-row').first.click()
        assert page.locator('.tool-detail').is_visible()
        assert 'No repository file was read' in page.locator('.tool-detail').inner_text()
        page.locator('.tool-row').first.click()
        checks.append('expandable execution evidence')
        page.locator('[data-action="folder"][data-path="src"]').click()
        assert page.locator('[data-path="src/review"]').is_visible()
        page.locator('[data-action="file"][data-path="README.md"]').click()
        assert page.locator('#dialog').is_visible()
        assert 'not bundled' in page.locator('#dialog-content').inner_text()
        page.keyboard.press('Escape')
        checks.append('folder expansion and honest file preview')
        page.keyboard.press('Control+k')
        page.locator('#search-input').fill('truth')
        assert page.locator('.search-result').count()==1
        page.locator('.search-result').click()
        assert page.locator('.session-button.active').inner_text()=='Chat truth repair'
        checks.append('search navigates to matching session')
        page.keyboard.press('Control+Alt+n')
        page.locator('#composer-input').fill('Test <img src=x onerror="window.INJECTED=true">')
        page.keyboard.press('Shift+Enter')
        page.keyboard.type('Second line')
        assert '\n' in page.locator('#composer-input').input_value()
        page.keyboard.press('Control+Enter')
        page.wait_for_selector('.stream-caret')
        page.locator('[data-action="stop"]').click()
        assert 'Response stopped' in page.locator('.message-status').inner_text()
        assert page.evaluate('window.INJECTED') is None
        assert page.locator('.user-message img').count()==0
        checks.append('multiline composer, send, cancellation, HTML escaping')
        title=page.locator('.session-button.active').inner_text()
        page.set_content(html)
        page.wait_for_selector('.session-button.active')
        assert page.locator('.session-button.active').inner_text()==title
        checks.append('preview history serializes and restores with a storage test double')
        page.locator('[data-action="settings"]').click()
        page.locator('[data-action="reset-preview"]').click()
        page.wait_for_selector('.reference-answer')
        page.locator('[data-action="new-session"]').first.click()
        page.locator('#composer-input').fill('Demonstrate streaming')
        page.keyboard.press('Control+Enter')
        page.wait_for_selector('.stream-caret')
        # Switching sessions is blocked while a preview run is active. Wait for
        # the existing completion status before checking session isolation.
        page.locator('.message-status.complete').filter(has_text='Response complete').wait_for(timeout=10000)
        page.locator('.session-button[data-id="reference"]').click()
        assert page.locator('.reference-answer').count()==1
        assert 'Your message is saved' not in page.locator('#conversation').inner_text()
        page.locator('.session-button').first.click()
        assert 'No model was called' in page.locator('#conversation').inner_text()
        checks.append('response remains attached to original session after switching')
        page.locator('[data-action="settings"]').click()
        page.locator('[data-action="reset-preview"]').click()
        page.locator('#toast').evaluate("el=>el.classList.remove('visible')")
        page.set_viewport_size({'width':1366,'height':768})
        page.screenshot(path=str(ARTIFACTS/'Babel-Desktop-1366x768.png'),full_page=True)
        assert page.locator('.composer').is_visible()
        assert page.locator('.right-panel').is_visible()
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        checks.append('laptop viewport: composer and three columns remain available')
        page.set_viewport_size({'width':390,'height':844})
        page.screenshot(path=str(ARTIFACTS/'Babel-Desktop-390x844.png'),full_page=True)
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        page.locator('[data-action="toggle-right"]').click()
        assert page.locator('.right-panel').is_visible()
        page.keyboard.press('Escape')
        page.locator('[data-action="toggle-left"]').click()
        assert page.locator('.left-panel').is_visible()
        checks.append('small viewport: no horizontal overflow; sidebars accessible')
        assert not errors,errors
        checks.append('no browser JavaScript errors')
        browser.close()
    report={'passed':len(checks),'checks':checks,'errors':errors}
    (ARTIFACTS/'ui-test-results.json').write_text(json.dumps(report,indent=2))
    print(json.dumps(report,indent=2))

if __name__=='__main__': main()
