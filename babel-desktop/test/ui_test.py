"""Browser layout/accessibility acceptance; no native bridge means no execution."""
from pathlib import Path
import json, os, shutil
from playwright.sync_api import sync_playwright
ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / 'artifacts'
ARTIFACTS.mkdir(exist_ok=True)
def main():
    checks, errors = [], []
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=os.environ.get('CHROMIUM_EXECUTABLE') or shutil.which('chromium'), headless=True)
        page = browser.new_page(viewport={'width':1536,'height':1024})
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.set_content((ROOT/'dist/index.html').read_text())
        assert page.locator('.left-panel').is_visible()
        assert page.locator('.right-panel').is_visible()
        assert page.locator('.reference-answer').count() == 0
        assert page.locator('.tool-row').count() == 0
        assert page.locator('#preview-badge').inner_text() == 'BABEL CLI'
        assert page.locator('#send-button').is_disabled()
        assert 'installed Babel Desktop' in page.locator('#status-detail').inner_text()
        checks.append('browser-only view cannot execute or fabricate a conversation')
        for mode, shortcut in [('plan', 'Alt+2'), ('deep', 'Alt+3')]:
            assert page.locator(f'.top-tab[data-mode="{mode}"]').is_disabled()
            assert page.locator(f'.mode-option[data-mode="{mode}"]').is_disabled()
            page.keyboard.press(shortcut)
            assert page.locator('.top-tab[data-mode="chat"]').get_attribute('aria-pressed') == 'true'
        page.keyboard.press('Alt+1')
        assert page.locator('.top-tab[data-mode="chat"]').get_attribute('aria-pressed') == 'true'
        checks.append('unsupported modes fail closed without a configured native provider')
        page.locator('#composer-input').fill('Test <img src=x onerror="window.INJECTED=true">')
        page.keyboard.press('Shift+Enter')
        page.keyboard.type('Second line')
        assert '\n' in page.locator('#composer-input').input_value()
        page.keyboard.press('Control+Enter')
        assert page.locator('.user-message').count() == 0
        assert page.evaluate('window.INJECTED') is None
        page.keyboard.press('Escape')
        checks.append('multiline composer fails closed without native execution')
        page.keyboard.press('Control+Alt+n')
        assert page.locator('#composer-input').input_value() == ''
        page.keyboard.press('Control+k')
        assert page.locator('#search-input').is_visible()
        page.keyboard.press('Escape')
        checks.append('new-session and search keyboard access')
        for width, height in [(1536,1024),(1366,768),(390,844)]:
            page.set_viewport_size({'width':width,'height':height})
            assert page.locator('.composer').is_visible()
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            page.screenshot(path=str(ARTIFACTS/f'Babel-Desktop-{width}x{height}.png'),full_page=True)
        page.locator('[data-action="toggle-right"]').click()
        assert page.locator('.right-panel').is_visible()
        page.keyboard.press('Escape')
        page.locator('[data-action="toggle-left"]').click()
        assert page.locator('.left-panel').is_visible()
        checks.append('desktop/laptop/mobile layout and accessible drawers')
        assert not errors, errors
        browser.close()
    report = {'passed':len(checks),'basis':'Browser-only layout; native events tested separately','checks':checks,'errors':errors}
    (ARTIFACTS/'ui-test-results.json').write_text(json.dumps(report,indent=2))
    print(json.dumps(report,indent=2))
if __name__ == '__main__': main()
