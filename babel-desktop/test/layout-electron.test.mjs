// Actual development Electron layout; no model calls or provider credentials.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {join, dirname, basename, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {_electron} from 'playwright';

test('native window keeps footer, composer and mode labels visible at increased zoom', {
  skip: !process.env.BABEL_TEST_ELECTRON_EXECUTABLE, timeout: 45000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'babel-layout-'));
  let app;
  try {
    const bootstrap = join(root, 'bootstrap.cjs');
    await writeFile(bootstrap, `const {app}=require('electron');import(${JSON.stringify(new URL('../native/main.mjs', import.meta.url).href)}).catch(()=>app.quit());`);
    const env = {};
    for (const key of ['PATH','SystemRoot','WINDIR','TEMP','TMP','LOCALAPPDATA','APPDATA','COMSPEC','PATHEXT','DISPLAY','XAUTHORITY']) {
      if (process.env[key]) env[key] = process.env[key];
    }
    env.HOME = root; env.USERPROFILE = root;
    app = await _electron.launch({executablePath:process.env.BABEL_TEST_ELECTRON_EXECUTABLE,args:[bootstrap,`--profile-dir=${join(root,'profile')}`],env});
    const page = await app.firstWindow();
    await page.waitForSelector('.composer');
    await page.waitForFunction(() => document.querySelector('#main-status').textContent !== 'Connecting');
    for (const [width,height,zoom] of [[1280,800,1],[1280,800,1.5],[960,650,1]]) {
      await app.evaluate(({BrowserWindow}, [width,height,zoom]) => {
        const window = BrowserWindow.getAllWindows()[0];
        window.setSize(width,height); window.webContents.setZoomFactor(zoom);
      }, [width,height,zoom]);
      // A realistic long display caption exercises header pressure without configuring a provider.
      await page.locator('#top-model').evaluate(element => { element.textContent = 'Z.ai: GLM 5.3 Flash'; });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const layout = await page.evaluate(() => {
        const rect = selector => {
          const bounds = document.querySelector(selector).getBoundingClientRect();
          return {bottom:bounds.bottom,left:bounds.left,right:bounds.right};
        };
        return {width:innerWidth,height:innerHeight,footer:rect('footer'),composer:rect('.composer'),
          labels:[...document.querySelectorAll('.top-tab')].map(tab => {
            const range = document.createRange(); range.selectNodeContents(tab);
            const rects = [...range.getClientRects()].filter(rect => rect.width && rect.height);
            return {height:Math.max(...rects.map(rect=>rect.bottom))-Math.min(...rects.map(rect=>rect.top)),lineHeight:parseFloat(getComputedStyle(tab).lineHeight)};
          })};
      });
      assert.ok(layout.footer.bottom <= layout.height + 1, `footer exceeds viewport at ${width}x${height}, zoom ${zoom}: ${JSON.stringify(layout)}`);
      assert.ok(layout.composer.bottom <= layout.height + 1, 'composer stays visible');
      assert.ok(layout.composer.left >= 0 && layout.composer.right <= layout.width + 1, 'composer fits horizontally');
      assert.ok(layout.labels.every(label => label.height <= label.lineHeight + 2), 'mode labels remain on one line');
    }
  } finally {
    if (app) await app.close();
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(basename(root).startsWith('babel-layout-'));
    await rm(root,{recursive:true,force:true});
  }
});
