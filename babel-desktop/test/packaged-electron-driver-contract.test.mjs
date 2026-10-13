// License: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, mkdtempSync, rmSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {chromium} from 'playwright';

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const acceptanceSource = readFileSync(
  join(desktopRoot, 'test/packaged-electron-acceptance/packaged_gui_acceptance.mjs'),
  'utf8',
);

test('packaged GUI acceptance source uses Node Playwright APIs only', () => {
  assert.doesNotMatch(acceptanceSource, /\binner_text\s*\(/);
  assert.doesNotMatch(acceptanceSource, /\bfull_page\s*:/);
  assert.match(acceptanceSource, /\.innerText\s*\(/);
  assert.match(acceptanceSource, /fullPage:\s*true/);
  assert.match(acceptanceSource, /_electron\s+as\s+electron/);
  assert.match(acceptanceSource, /executablePath:\s*exe/);
  assert.doesNotMatch(acceptanceSource, /args:\s*\[\s*str\(exe\)/);
  assert.match(readFileSync(join(desktopRoot, 'test/packaged-electron-acceptance/packaged-fixture-lane.mjs'), 'utf8'), /PACKAGED-HISTORY-FIXTURE/);
});

test('packaged GUI acceptance uses startup BABEL SETUP modal for harness (not footer badge under modal)', () => {
  assert.match(acceptanceSource, /waitForSelector\([^)]*#dialog\[open\]/);
  assert.match(acceptanceSource, /connectLiveFromPackagedStartupDialog/);
  assert.match(acceptanceSource, /#dialog \[data-action="use-live"\]/);
  assert.doesNotMatch(acceptanceSource, /#dialog:not\(\[open\]\)/);
  assert.match(acceptanceSource, /waitFor\(\{state:\s*'hidden'/);
  const afterProvider = acceptanceSource.split('journeys.provider')[1] ?? '';
  assert.doesNotMatch(afterProvider, /locator\('#preview-badge'\)\.click\(\)/);
  const appStartup = readFileSync(join(desktopRoot, 'src/app.mjs'), 'utf8');
  assert.match(appStartup, /info\?\.packaged.*connectionDialog\(\)/s);
  assert.match(appStartup, /data-action="use-live"/);
});

test('playwright driver contract: closed HTML dialog is hidden (not visible without [open])', async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox'],
  });
  try {
    const page = await browser.newPage();
    await page.setContent(
      '<dialog id="dialog" open><div style="padding:2rem">BABEL SETUP</div></dialog>',
    );
    const dialog = page.locator('#dialog');
    await dialog.waitFor({state: 'visible', timeout: 5_000});
    assert.equal(await page.evaluate(() => document.querySelector('#dialog').open), true);
    await page.evaluate(() => document.querySelector('#dialog').close());
    await dialog.waitFor({state: 'hidden', timeout: 5_000});
    assert.equal(await page.evaluate(() => document.querySelector('#dialog').open), false);
    await assert.rejects(
      () => page.waitForSelector('#dialog:not([open])', {timeout: 500}),
      /Timeout|waiting for selector/,
    );
  } finally {
    await browser.close();
  }
});

test('playwright driver contract: locator.innerText and screenshot fullPage', async () => {
  const outDir = mkdtempSync(join(tmpdir(), 'babel-pw-contract-'));
  const shot = join(outDir, 'contract.png');
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox'],
  });
  try {
    const page = await browser.newPage();
    await page.setContent('<main id="preview-badge">REFERENCE PREVIEW</main>');
    const locator = page.locator('#preview-badge');
    assert.equal(typeof locator.innerText, 'function');
    assert.equal(await locator.innerText(), 'REFERENCE PREVIEW');
    await page.screenshot({path: shot, fullPage: true});
    assert.ok(readFileSync(shot).length > 0);
  } finally {
    await browser.close();
    rmSync(outDir, {recursive: true, force: true});
  }
});
